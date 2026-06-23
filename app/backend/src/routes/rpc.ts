/**
 * RPC Proxy Routes - Call PostgreSQL functions
 *
 * @swagger
 * tags:
 *   name: RPC
 *   description: PostgreSQL function calls
 */
import { Router, Request, Response } from "express";
import db from "../utils/database";
import { logger } from "../utils/logger";
import { Errors } from "../middleware/errorHandler";
import crypto from "crypto";
import { broadcast } from "../websocket";
import {
  batchStageFiles,
  BatchStageFileInput,
  getFileContentByPathWithToken,
  stageFileChangeWithToken,
} from "../utils/rpcHelpers";
import { getRepoBlobStore } from "../utils/repoBlobStore";
import {
  getStagedContent,
  computeContentMeta,
} from "../staging/stagedContentStore";
import {
  getArtifactContent,
  putArtifactContent,
  deleteArtifactContent,
  cloneArtifactContent,
} from "../staging/artifactContentStore";
import { stagingChannel, repoFilesChannel } from "../utils/repoChannels";
import {
  ensureGenappKeyVault,
  purgeGenappKeyVault,
  setGenappSecrets,
  getGenappSecrets,
  deleteGenappSecrets,
  setConnectionStringSecret,
  deleteConnectionStringSecret,
  type GenappSecretEntry,
} from "../services/deployment/docker/genappKeyVault";

const router = Router();

/**
 * @swagger
 * /rpc/{functionName}:
 *   post:
 *     summary: Call a PostgreSQL function
 *     tags: [RPC]
 *     parameters:
 *       - in: path
 *         name: functionName
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Function parameters as key-value pairs
 */
router.post("/:functionName", async (req: Request, res: Response) => {
  const { functionName } = req.params;
  const params = req.body || {};
  const userId = req.user?.id;

  // Validate function name (prevent SQL injection)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(functionName)) {
    throw Errors.badRequest("Invalid function name");
  }

  logger.info(`RPC call: ${functionName}`, { params: Object.keys(params) });

  // Handle special functions that don't exist as PostgreSQL functions
  switch (functionName) {
    // ============================================================
    // PROJECT OPERATIONS
    // ============================================================

    case "insert_project_with_token": {
      const {
        p_name,
        p_org_id,
        p_description,
        p_organization,
        p_budget,
        p_scope,
        p_status,
      } = params;
      if (!p_name) {
        return res.json({ data: null, error: "p_name is required" });
      }

      // Start transaction
      const client = await db.getClient();
      try {
        await client.query("BEGIN");

        // Insert the project with the authenticated user's ID
        const projectSql = `
          INSERT INTO projects (name, org_id, description, organization, budget, scope, status, created_by, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'DESIGN'), $8, NOW(), NOW())
          RETURNING id
        `;
        const projectResult = await client.query(projectSql, [
          p_name,
          p_org_id || null,
          p_description || null,
          p_organization || null,
          p_budget || null,
          p_scope || null,
          p_status || "DESIGN",
          userId || null, // Use the authenticated user ID from the request
        ]);
        const projectId = projectResult.rows[0].id;

        // Create an owner token
        const tokenSql = `
          INSERT INTO project_tokens (project_id, role, label, created_by, created_at)
          VALUES ($1, 'owner', 'Default Owner Token', $2, NOW())
          RETURNING token
        `;
        const tokenResult = await client.query(tokenSql, [
          projectId,
          userId || null,
        ]);
        const shareToken = tokenResult.rows[0].token;

        await client.query("COMMIT");

        broadcast(`project-${projectId}`, "project_refresh", { projectId });
        return res.json({
          data: { id: projectId, share_token: shareToken },
          error: null,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    case "get_user_projects": {
      // Fetch projects owned by the user (via created_by OR via owner token)
      if (!userId) {
        return res.json({ data: [], error: null });
      }
      const sql = `
        SELECT DISTINCT ON (p.id)
          p.id, p.name, p.description, p.organization, p.budget, p.scope,
          p.status, p.splash_image_url, p.created_at, p.updated_at
        FROM projects p
        LEFT JOIN project_tokens pt ON pt.project_id = p.id AND pt.role = 'owner'
        WHERE p.created_by = $1 
           OR pt.created_by = $1
        ORDER BY p.id, p.updated_at DESC
      `;
      const result = await db.query(sql, [userId]);
      // Sort by updated_at descending after distinct
      const sorted = result.rows.sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
      return res.json({ data: sorted, error: null });
    }

    case "get_linked_projects": {
      if (!userId) {
        return res.json({ data: [], error: null });
      }
      const sql = `
        SELECT 
          plp.id, plp.project_id,
          p.name as project_name, p.description as project_description,
          p.status as project_status, p.splash_image_url as project_splash_image_url,
          p.updated_at as project_updated_at,
          pt.role, TRUE as is_valid
        FROM profile_linked_projects plp
        JOIN projects p ON p.id = plp.project_id
        LEFT JOIN project_tokens pt ON pt.token = plp.token
        WHERE plp.user_id = $1
        ORDER BY p.updated_at DESC
      `;
      const result = await db.query(sql, [userId]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_published_projects": {
      const sql = `
        SELECT 
          pp.id, pp.project_id,
          p.name as project_name, p.description as project_description,
          p.status as project_status, p.splash_image_url as project_splash_image_url,
          p.updated_at as project_updated_at, pp.published_at, pp.image_url,
          pp.category, pp.tags, pp.clone_count, pp.view_count
        FROM published_projects pp
        JOIN projects p ON p.id = pp.project_id
        WHERE pp.is_visible = true
        ORDER BY pp.published_at DESC LIMIT 50
      `;
      const result = await db.query(sql);
      return res.json({ data: result.rows, error: null });
    }

    case "get_project_with_token": {
      const { p_project_id, p_token } = params;
      if (!p_project_id) return res.json({ data: null, error: null });

      let sql: string, queryParams: any[];
      if (p_token) {
        sql = `
          SELECT p.* FROM projects p
          JOIN project_tokens pt ON pt.project_id = p.id
          WHERE p.id = $1 AND pt.token = $2 AND (pt.expires_at IS NULL OR pt.expires_at > NOW())
        `;
        queryParams = [p_project_id, p_token];
      } else {
        sql = "SELECT * FROM projects WHERE id = $1";
        queryParams = [p_project_id];
      }
      const result = await db.query(sql, queryParams);
      if (p_token && result.rows.length > 0) {
        await db.query(
          "UPDATE project_tokens SET last_used_at = NOW() WHERE token = $1",
          [p_token],
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "update_project_with_token": {
      const { p_project_id, p_token } = params;
      if (!p_project_id)
        return res.json({ data: null, error: "p_project_id is required" });

      console.log("[RPC] update_project_with_token called with:", {
        p_project_id,
        p_token: p_token ? "***" : null,
      });

      if (p_token) {
        const tokenResult = await db.query(
          "SELECT 1 FROM project_tokens WHERE project_id = $1 AND token = $2 AND (expires_at IS NULL OR expires_at > NOW())",
          [p_project_id, p_token],
        );
        if (tokenResult.rows.length === 0) {
          console.log("[RPC] update_project_with_token: Invalid share token");
          return res.json({ data: null, error: "Invalid share token" });
        }
      }

      const fieldMap: Record<string, string> = {
        p_name: "name",
        p_description: "description",
        p_organization: "organization",
        p_budget: "budget",
        p_scope: "scope",
        p_timeline_start: "timeline_start",
        p_timeline_end: "timeline_end",
        p_priority: "priority",
        p_tags: "tags",
        p_splash_image_url: "splash_image_url",
      };

      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;

      for (const [paramKey, columnName] of Object.entries(fieldMap)) {
        if (Object.prototype.hasOwnProperty.call(params, paramKey)) {
          updates.push(`${columnName} = $${idx++}`);
          values.push(params[paramKey]);
        }
      }

      updates.push("updated_at = NOW()");
      values.push(p_project_id);

      const sql = `UPDATE projects SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`;
      console.log("[RPC] update_project_with_token SQL:", sql);
      console.log(
        "[RPC] update_project_with_token values (project_id last):",
        values.map((v, i) =>
          i === values.length - 1
            ? v
            : typeof v === "string" && v.length > 50
              ? v.substring(0, 50) + "..."
              : v,
        ),
      );

      const result = await db.query(sql, values);

      if (result.rows.length === 0) {
        console.log(
          "[RPC] update_project_with_token: No rows updated - project may not exist",
        );
        return res.json({
          data: null,
          error: "Project not found or no rows updated",
        });
      }

      console.log(
        "[RPC] update_project_with_token success, updated timeline_start:",
        result.rows[0].timeline_start,
        "timeline_end:",
        result.rows[0].timeline_end,
      );
      broadcast(`project-${p_project_id}`, "project_refresh", {
        projectId: p_project_id,
      });
      return res.json({ data: result.rows[0], error: null });
    }

    case "update_project_llm_settings_with_token": {
      const {
        p_project_id,
        p_token,
        p_selected_model,
        p_max_tokens,
        p_thinking_enabled,
        p_thinking_budget,
      } = params;
      if (!p_project_id)
        return res.json({ data: null, error: "p_project_id is required" });

      // Validate token if provided
      if (p_token) {
        const tokenResult = await db.query(
          "SELECT 1 FROM project_tokens WHERE project_id = $1 AND token = $2 AND (expires_at IS NULL OR expires_at > NOW())",
          [p_project_id, p_token],
        );
        if (tokenResult.rows.length === 0) {
          return res.json({ data: null, error: "Invalid share token" });
        }
      }

      const sql = `
        UPDATE projects
        SET selected_model = $2, max_tokens = $3, thinking_enabled = $4, thinking_budget = $5, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      const result = await db.query(sql, [
        p_project_id,
        p_selected_model,
        p_max_tokens,
        p_thinking_enabled,
        p_thinking_budget,
      ]);
      broadcast(`project-${p_project_id}`, "project_refresh", {
        projectId: p_project_id,
      });
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_user_project_role_with_token": {
      const { p_project_id, p_token } = params;
      if (!p_project_id) return res.json({ data: "viewer", error: null });

      // Check 1: If authenticated user owns the project, they have owner role
      if (userId) {
        const ownerCheck = await db.query(
          "SELECT created_by FROM projects WHERE id = $1",
          [p_project_id],
        );
        if (
          ownerCheck.rows.length > 0 &&
          ownerCheck.rows[0].created_by === userId
        ) {
          return res.json({ data: "owner", error: null });
        }
      }

      // Check 2: Validate token
      if (p_token) {
        const sql = `
          SELECT pt.role FROM project_tokens pt
          WHERE pt.project_id = $1 AND pt.token = $2 AND (pt.expires_at IS NULL OR pt.expires_at > NOW())
        `;
        const result = await db.query(sql, [p_project_id, p_token]);
        return res.json({
          data: result.rows[0]?.role || "viewer",
          error: null,
        });
      }
      return res.json({ data: "viewer", error: null });
    }

    // ============================================================
    // ARTIFACTS
    // ============================================================

    case "get_artifacts_with_token": {
      const { p_project_id, p_search_term } = params;
      if (!p_project_id) return res.json({ data: [], error: null });

      let sql = "SELECT id, project_id, ai_title, ai_summary, source_type, source_id, image_url, provenance_id, provenance_path, provenance_page, provenance_total_pages, parent_id, is_folder, content_length, created_at, updated_at, created_by FROM artifacts WHERE project_id = $1";
      const queryParams: any[] = [p_project_id];

      if (p_search_term) {
        sql += " AND (ai_title ILIKE $2 OR ai_summary ILIKE $2)";
        queryParams.push(`%${p_search_term}%`);
      }
      sql += " ORDER BY created_at DESC";

      const result = await db.query(sql, queryParams);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_artifact_with_token": {
      const {
        p_project_id,
        p_content,
        p_source_type,
        p_source_id,
        p_image_url,
        p_parent_id,
      } = params;
      if (!p_project_id || !p_content) {
        return res.json({
          data: null,
          error: "p_project_id and p_content are required",
        });
      }

      const sql = `
        INSERT INTO artifacts (project_id, source_type, source_id, image_url, created_by, created_at, updated_at, parent_id, is_folder, content_length)
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), $6, FALSE, $7) RETURNING *
      `;
      const contentLength = Buffer.byteLength(p_content, "utf8");
      const insertResult = await db.query(sql, [
        p_project_id,
        p_source_type || null,
        p_source_id || null,
        p_image_url || null,
        userId || null,
        p_parent_id || null,
        contentLength,
      ]);
      const inserted = insertResult.rows[0];
      if (inserted) {
        await putArtifactContent(p_project_id, inserted.id, p_content);
        broadcast(`project-${p_project_id}-artifacts`, "artifact_refresh", {
          projectId: p_project_id,
        });
      }
      return res.json({
        data: inserted ? { ...inserted, content: p_content } : null,
        error: null,
      });
    }

    case "update_artifact_with_token": {
      const {
        p_id,
        p_content,
        p_ai_title,
        p_ai_summary,
        p_image_url,
      } = params;
      if (!p_id) return res.json({ data: null, error: "p_id is required" });

      if (p_content !== undefined && p_content !== null) {
        const { contentLength } = await putArtifactContent(
          // Need project_id for container name — look it up
          (
            await db.query("SELECT project_id FROM artifacts WHERE id = $1", [
              p_id,
            ])
          ).rows[0]?.project_id,
          p_id,
          p_content,
        );
        const sql = `
          UPDATE artifacts
          SET ai_title = COALESCE($2, ai_title),
              ai_summary = COALESCE($3, ai_summary), image_url = COALESCE($4, image_url),
              content_length = $5, updated_at = NOW()
          WHERE id = $1 RETURNING *
        `;
        const result = await db.query(sql, [
          p_id,
          p_ai_title ?? null,
          p_ai_summary ?? null,
          p_image_url ?? null,
          contentLength,
        ]);
        if (result.rows[0]) {
          broadcast(
            `project-${result.rows[0].project_id}-artifacts`,
            "artifact_refresh",
            { projectId: result.rows[0].project_id },
          );
        }
        return res.json({
          data: result.rows[0]
            ? { ...result.rows[0], content: p_content }
            : null,
          error: null,
        });
      } else {
        const sql = `
          UPDATE artifacts
          SET ai_title = COALESCE($2, ai_title),
              ai_summary = COALESCE($3, ai_summary), image_url = COALESCE($4, image_url), updated_at = NOW()
          WHERE id = $1 RETURNING *
        `;
        const result = await db.query(sql, [
          p_id,
          p_ai_title ?? null,
          p_ai_summary ?? null,
          p_image_url ?? null,
        ]);
        if (result.rows[0]) {
          broadcast(
            `project-${result.rows[0].project_id}-artifacts`,
            "artifact_refresh",
            { projectId: result.rows[0].project_id },
          );
        }
        return res.json({ data: result.rows[0] || null, error: null });
      }
    }

    case "delete_artifact_with_token": {
      const { p_id } = params;
      if (!p_id) return res.json({ data: null, error: "p_id is required" });
      const artLookup = await db.query(
        "SELECT project_id FROM artifacts WHERE id = $1",
        [p_id],
      );
      const artProjectId = artLookup.rows[0]?.project_id;
      const sql = "DELETE FROM artifacts WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      if (artProjectId) {
        await deleteArtifactContent(artProjectId, p_id);
        broadcast(`project-${artProjectId}-artifacts`, "artifact_refresh", {
          projectId: artProjectId,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "insert_artifact_folder_with_token": {
      const { p_project_id, p_name, p_parent_id } = params;
      if (!p_project_id || !p_name) {
        return res.json({
          data: null,
          error: "p_project_id and p_name are required",
        });
      }
      const sql = `
        INSERT INTO artifacts (project_id, ai_title, created_by, created_at, updated_at, parent_id, is_folder, content_length)
        VALUES ($1, $2, $3, NOW(), NOW(), $4, TRUE, 0) RETURNING *
      `;
      const result = await db.query(sql, [
        p_project_id,
        p_name,
        userId || null,
        p_parent_id || null,
      ]);
      broadcast(`project-${p_project_id}-artifacts`, "artifact_refresh", {
        projectId: p_project_id,
      });
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "move_artifact_with_token": {
      const { p_artifact_id, p_new_parent_id } = params;
      if (!p_artifact_id)
        return res.json({ data: null, error: "p_artifact_id is required" });
      const sql = "UPDATE artifacts SET parent_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [
        p_artifact_id,
        p_new_parent_id || null,
      ]);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-artifacts`,
          "artifact_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // CHAT SESSIONS & MESSAGES
    // ============================================================

    case "get_chat_sessions_with_token": {
      const { p_project_id } = params;
      if (!p_project_id) return res.json({ data: [], error: null });
      const sql = "SELECT * FROM chat_sessions WHERE project_id = $1 ORDER BY created_at DESC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_chat_session_with_token": {
      const { p_project_id, p_title } = params;
      if (!p_project_id)
        return res.json({ data: null, error: "p_project_id is required" });
      const sql = "INSERT INTO chat_sessions (project_id, title, created_by, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *";
      const result = await db.query(sql, [
        p_project_id,
        p_title || null,
        userId || null,
      ]);
      broadcast(`project-${p_project_id}-chat`, "chat_session_refresh", {
        projectId: p_project_id,
      });
      return res.json({ data: result.rows[0], error: null });
    }

    case "get_chat_messages_with_token": {
      const { p_chat_session_id } = params;
      const sql = "SELECT * FROM chat_messages WHERE chat_session_id = $1 ORDER BY created_at ASC";
      const result = await db.query(sql, [p_chat_session_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_chat_message_with_token": {
      const { p_chat_session_id, p_role, p_content } = params;
      // Get project_id from the chat session
      const sessionResult = await db.query(
        "SELECT project_id FROM chat_sessions WHERE id = $1",
        [p_chat_session_id],
      );
      const projectId = sessionResult.rows[0]?.project_id || null;
      const sql = "INSERT INTO chat_messages (chat_session_id, project_id, role, content, created_by, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *";
      const result = await db.query(sql, [
        p_chat_session_id,
        projectId,
        p_role,
        p_content,
        userId || null,
      ]);
      if (projectId) {
        broadcast(`project-${projectId}-chat`, "chat_message_refresh", {
          projectId,
          chatSessionId: p_chat_session_id,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_chat_session_with_token": {
      const { p_id } = params;
      const chatLookup = await db.query(
        "SELECT project_id FROM chat_sessions WHERE id = $1",
        [p_id],
      );
      const chatProjectId = chatLookup.rows[0]?.project_id;
      const sql = "DELETE FROM chat_sessions WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      if (chatProjectId) {
        broadcast(`project-${chatProjectId}-chat`, "chat_session_refresh", {
          projectId: chatProjectId,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "update_chat_session_with_token": {
      const { p_id, p_title } = params;
      const sql = "UPDATE chat_sessions SET title = $2, updated_at = NOW() WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_id, p_title]);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-chat`,
          "chat_session_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // CANVAS OPERATIONS
    // ============================================================

    case "get_canvas_nodes_with_token": {
      const { p_project_id } = params;
      if (!p_project_id) return res.json({ data: [], error: null });
      const sql = "SELECT * FROM canvas_nodes WHERE project_id = $1 ORDER BY created_at ASC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_canvas_edges_with_token": {
      const { p_project_id } = params;
      if (!p_project_id) return res.json({ data: [], error: null });
      const sql = "SELECT * FROM canvas_edges WHERE project_id = $1 ORDER BY created_at ASC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "upsert_canvas_node_with_token": {
      const {
        p_id,
        p_project_id,
        p_type,
        p_data,
        p_position_x,
        p_position_y,
        p_width,
        p_height,
      } = params;
      if (p_id) {
        const sql = `
          UPDATE canvas_nodes 
          SET type = COALESCE($2, type), data = COALESCE($3, data), position_x = COALESCE($4, position_x), 
              position_y = COALESCE($5, position_y), width = COALESCE($6, width), height = COALESCE($7, height), updated_at = NOW()
          WHERE id = $1 RETURNING *
        `;
        const result = await db.query(sql, [
          p_id,
          p_type,
          p_data,
          p_position_x,
          p_position_y,
          p_width,
          p_height,
        ]);
        if (result.rows[0]) {
          broadcast(
            `project-${result.rows[0].project_id}-canvas`,
            "canvas_refresh",
            { projectId: result.rows[0].project_id },
          );
        }
        return res.json({ data: result.rows[0] || null, error: null });
      } else {
        const sql = `
          INSERT INTO canvas_nodes (project_id, type, data, position_x, position_y, width, height, created_by, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW()) RETURNING *
        `;
        const result = await db.query(sql, [
          p_project_id,
          p_type,
          p_data,
          p_position_x || 0,
          p_position_y || 0,
          p_width,
          p_height,
          userId,
        ]);
        broadcast(`project-${p_project_id}-canvas`, "canvas_refresh", {
          projectId: p_project_id,
        });
        return res.json({ data: result.rows[0] || null, error: null });
      }
    }

    case "delete_canvas_node_with_token": {
      const { p_id } = params;
      const nodeLookup = await db.query(
        "SELECT project_id FROM canvas_nodes WHERE id = $1",
        [p_id],
      );
      const nodeProjectId = nodeLookup.rows[0]?.project_id;
      const sql = "DELETE FROM canvas_nodes WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      if (nodeProjectId) {
        broadcast(`project-${nodeProjectId}-canvas`, "canvas_refresh", {
          projectId: nodeProjectId,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "upsert_canvas_edge_with_token": {
      const {
        p_id,
        p_project_id,
        p_source,
        p_target,
        p_source_handle,
        p_target_handle,
        p_data,
      } = params;
      if (p_id) {
        const sql = `
          UPDATE canvas_edges SET source = COALESCE($2, source), target = COALESCE($3, target),
          source_handle = COALESCE($4, source_handle), target_handle = COALESCE($5, target_handle),
          data = COALESCE($6, data), updated_at = NOW() WHERE id = $1 RETURNING *
        `;
        const result = await db.query(sql, [
          p_id,
          p_source,
          p_target,
          p_source_handle,
          p_target_handle,
          p_data,
        ]);
        if (result.rows[0]) {
          broadcast(
            `project-${result.rows[0].project_id}-canvas`,
            "canvas_refresh",
            { projectId: result.rows[0].project_id },
          );
        }
        return res.json({ data: result.rows[0] || null, error: null });
      } else {
        const sql = "INSERT INTO canvas_edges (project_id, source, target, source_handle, target_handle, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *";
        const result = await db.query(sql, [
          p_project_id,
          p_source,
          p_target,
          p_source_handle,
          p_target_handle,
          p_data,
        ]);
        broadcast(`project-${p_project_id}-canvas`, "canvas_refresh", {
          projectId: p_project_id,
        });
        return res.json({ data: result.rows[0] || null, error: null });
      }
    }

    case "delete_canvas_edge_with_token": {
      const { p_id } = params;
      const edgeLookup = await db.query(
        "SELECT project_id FROM canvas_edges WHERE id = $1",
        [p_id],
      );
      const edgeProjectId = edgeLookup.rows[0]?.project_id;
      const sql = "DELETE FROM canvas_edges WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      if (edgeProjectId) {
        broadcast(`project-${edgeProjectId}-canvas`, "canvas_refresh", {
          projectId: edgeProjectId,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_canvas_layers_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM canvas_layers WHERE project_id = $1 ORDER BY z_index ASC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    // ============================================================
    // REQUIREMENTS
    // ============================================================

    case "get_requirements_with_token": {
      const { p_project_id } = params;
      if (!p_project_id) return res.json({ data: [], error: null });
      const sql = "SELECT * FROM requirements WHERE project_id = $1 ORDER BY order_index ASC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_requirement_with_token": {
      const { p_project_id, p_parent_id, p_type, p_title } = params;
      if (!p_project_id || !p_type || !p_title) {
        return res.status(400).json({
          data: null,
          error: {
            message:
              "Missing required parameters: p_project_id, p_type, p_title",
          },
        });
      }
      // Get max order_index for the parent level
      const orderSql = p_parent_id
        ? "SELECT COALESCE(MAX(order_index), -1) + 1 as next_order FROM requirements WHERE project_id = $1 AND parent_id = $2"
        : "SELECT COALESCE(MAX(order_index), -1) + 1 as next_order FROM requirements WHERE project_id = $1 AND parent_id IS NULL";
      const orderResult = await db.query(
        orderSql,
        p_parent_id ? [p_project_id, p_parent_id] : [p_project_id],
      );
      const nextOrder = orderResult.rows[0]?.next_order || 0;

      const sql = "INSERT INTO requirements (project_id, parent_id, type, title, order_index, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING *";
      const result = await db.query(sql, [
        p_project_id,
        p_parent_id || null,
        p_type,
        p_title,
        nextOrder,
      ]);
      broadcast(
        `project-${p_project_id}-requirements`,
        "requirements_refresh",
        { projectId: p_project_id },
      );
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "update_requirement_with_token": {
      const { p_id, p_title, p_content } = params;
      if (!p_id) {
        return res.status(400).json({
          data: null,
          error: { message: "Missing required parameter: p_id" },
        });
      }
      const sql = "UPDATE requirements SET title = COALESCE($2, title), content = COALESCE($3, content), updated_at = NOW() WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_id, p_title, p_content]);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-requirements`,
          "requirements_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_requirement_with_token": {
      const { p_id } = params;
      if (!p_id) {
        return res.status(400).json({
          data: null,
          error: { message: "Missing required parameter: p_id" },
        });
      }
      // Get project_id before deleting
      const reqLookup = await db.query(
        "SELECT project_id FROM requirements WHERE id = $1",
        [p_id],
      );
      const reqProjectId = reqLookup.rows[0]?.project_id;
      // Delete children first (cascade), then the requirement itself
      const deleteChildrenSql = "DELETE FROM requirements WHERE parent_id = $1";
      await db.query(deleteChildrenSql, [p_id]);
      const sql = "DELETE FROM requirements WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      if (reqProjectId) {
        broadcast(
          `project-${reqProjectId}-requirements`,
          "requirements_refresh",
          { projectId: reqProjectId },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // SPECIFICATIONS
    // ============================================================

    case "get_project_specifications_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM project_specifications WHERE project_id = $1 ORDER BY created_at DESC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_project_specification_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM project_specifications WHERE project_id = $1 AND is_latest = true LIMIT 1";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // PRESENTATIONS (project_presentations table)
    // ============================================================

    case "get_project_presentations_list_with_token": {
      const { p_project_id } = params;
      const sql = `SELECT id, project_id, name, initial_prompt, mode, target_slides, status, 
                   (SELECT COUNT(*) FROM jsonb_array_elements(slides)) as slide_count,
                   cover_image_url, metadata, created_at, updated_at, created_by, version
                   FROM project_presentations WHERE project_id = $1 ORDER BY created_at DESC`;
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_project_presentations_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM project_presentations WHERE project_id = $1 ORDER BY created_at DESC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_presentation_with_token": {
      const { p_id } = params;
      const sql = "SELECT * FROM project_presentations WHERE id = $1";
      const result = await db.query(sql, [p_id]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "insert_presentation_with_token": {
      const {
        p_project_id,
        p_name,
        p_initial_prompt,
        p_mode,
        p_target_slides,
      } = params;
      const sql = `INSERT INTO project_presentations (project_id, name, initial_prompt, mode, target_slides, status, created_by, created_at, updated_at) 
                   VALUES ($1, COALESCE($2, 'New Presentation'), $3, COALESCE($4, 'concise'), COALESCE($5, 15), 'draft', $6, NOW(), NOW()) RETURNING *`;
      const result = await db.query(sql, [
        p_project_id,
        p_name,
        p_initial_prompt,
        p_mode,
        p_target_slides,
        userId,
      ]);
      broadcast(
        `project-${p_project_id}-presentations`,
        "presentation_refresh",
        { projectId: p_project_id },
      );
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "update_presentation_with_token": {
      const {
        p_presentation_id,
        p_name,
        p_slides,
        p_blackboard,
        p_cover_image_url,
        p_metadata,
        p_status,
      } = params;
      const sql = `UPDATE project_presentations SET 
                   name = COALESCE($2, name), 
                   slides = COALESCE($3, slides), 
                   blackboard = COALESCE($4, blackboard),
                   cover_image_url = COALESCE($5, cover_image_url),
                   metadata = COALESCE($6, metadata),
                   status = COALESCE($7, status),
                   updated_at = NOW() 
                   WHERE id = $1 RETURNING *`;
      const result = await db.query(sql, [
        p_presentation_id,
        p_name,
        p_slides,
        p_blackboard,
        p_cover_image_url,
        p_metadata,
        p_status,
      ]);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-presentations`,
          "presentation_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "append_presentation_blackboard_with_token": {
      const { p_presentation_id, p_entry } = params;
      const sql = "UPDATE project_presentations SET blackboard = blackboard || $2, updated_at = NOW() WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_presentation_id, p_entry]);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-presentations`,
          "presentation_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_presentation_with_token": {
      const { p_presentation_id } = params;
      const presLookup = await db.query(
        "SELECT project_id FROM project_presentations WHERE id = $1",
        [p_presentation_id],
      );
      const presProjectId = presLookup.rows[0]?.project_id;
      const sql = "DELETE FROM project_presentations WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_presentation_id]);
      if (presProjectId) {
        broadcast(
          `project-${presProjectId}-presentations`,
          "presentation_refresh",
          { projectId: presProjectId },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // PROJECT REPOS & FILES
    // ============================================================

    case "get_project_repos_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM project_repos WHERE project_id = $1 ORDER BY is_prime DESC, created_at DESC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_prime_repo_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM project_repos WHERE project_id = $1 AND is_prime = true LIMIT 1";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_file_structure_with_token": {
      const { p_repo_id } = params;
      const sql = "SELECT * FROM repo_files WHERE repo_id = $1 ORDER BY path";
      const result = await db.query(sql, [p_repo_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "create_file_with_token": {
      const { p_repo_id, p_path, p_content } = params;
      const sql = "INSERT INTO repo_files (repo_id, path, content, is_binary, created_at, updated_at) VALUES ($1, $2, $3, false, NOW(), NOW()) RETURNING *";
      const result = await db.query(sql, [p_repo_id, p_path, p_content || ""]);
      // Get project_id from repo for broadcast
      const fileRepoLookup = await db.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [p_repo_id],
      );
      const fileRepoProjectId = fileRepoLookup.rows[0]?.project_id;
      if (fileRepoProjectId) {
        broadcast(
          `project-${fileRepoProjectId}-repo-${p_repo_id}`,
          "repo_files_refresh",
          { projectId: fileRepoProjectId, repoId: p_repo_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_file_with_token": {
      const { p_file_id } = params;
      const sql = "DELETE FROM repo_files WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_file_id]);
      if (result.rows[0]) {
        const delFileRepoLookup = await db.query(
          "SELECT project_id FROM project_repos WHERE id = $1",
          [result.rows[0].repo_id],
        );
        const delFileProjectId = delFileRepoLookup.rows[0]?.project_id;
        if (delFileProjectId) {
          broadcast(
            `project-${delFileProjectId}-repo-${result.rows[0].repo_id}`,
            "repo_files_refresh",
            { projectId: delFileProjectId, repoId: result.rows[0].repo_id },
          );
        }
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // PROJECT TOKENS & SHARING
    // ============================================================

    case "set_share_token": {
      const { token } = params;
      if (!token) return res.json({ data: null, error: null });
      const tokenResult = await db.query(
        "SELECT project_id FROM project_tokens WHERE token = $1 AND (expires_at IS NULL OR expires_at > NOW())",
        [token],
      );
      if (tokenResult.rows.length === 0)
        return res.json({ data: null, error: null });
      const projectId = tokenResult.rows[0].project_id;
      if (userId) {
        await db.query(
          "INSERT INTO profile_linked_projects (user_id, project_id, token) VALUES ($1, $2, $3) ON CONFLICT (user_id, project_id) DO UPDATE SET token = $3",
          [userId, projectId, token],
        );
      }
      return res.json({ data: null, error: null });
    }

    case "authorize_project_access": {
      const { p_project_id, p_token } = params;

      // Check 1: If authenticated user owns the project, they have owner role
      if (userId) {
        const ownerCheck = await db.query(
          "SELECT created_by FROM projects WHERE id = $1",
          [p_project_id],
        );
        if (
          ownerCheck.rows.length > 0 &&
          ownerCheck.rows[0].created_by === userId
        ) {
          // Return role directly as string 
          return res.json({ data: "owner", error: null });
        }
      }

      // Check 2: Validate token
      if (!p_token) return res.json({ data: null, error: null });
      const sql = "SELECT role FROM project_tokens WHERE project_id = $1 AND token = $2 AND (expires_at IS NULL OR expires_at > NOW())";
      const result = await db.query(sql, [p_project_id, p_token]);
      if (result.rows.length === 0) {
        return res.json({ data: null, error: { message: "Access denied" } });
      }
      // Return role directly as string
      return res.json({ data: result.rows[0].role, error: null });
    }

    case "get_project_tokens_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM project_tokens WHERE project_id = $1 ORDER BY created_at DESC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "create_project_token_with_token": {
      const { p_project_id, p_role, p_label, p_expires_at } = params;
      const newToken = crypto.randomBytes(16).toString("hex");
      const sql = "INSERT INTO project_tokens (project_id, token, role, label, expires_at, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *";
      const result = await db.query(sql, [
        p_project_id,
        newToken,
        p_role || "viewer",
        p_label || null,
        p_expires_at,
        userId,
      ]);
      broadcast(`project-${p_project_id}-tokens`, "tokens_refresh", {
        projectId: p_project_id,
      });
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "roll_project_token_with_token": {
      const { p_token_id } = params;
      // Generate a new token value
      const newTokenValue = crypto.randomBytes(16).toString("hex");
      const sql = "UPDATE project_tokens SET token = $2, last_used_at = NOW() WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_token_id, newTokenValue]);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-tokens`,
          "tokens_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      // Return just the new token value as a string (to match original behavior)
      return res.json({ data: result.rows[0]?.token || null, error: null });
    }

    case "delete_project_token_with_token": {
      const { p_id } = params;
      const tokenLookup = await db.query(
        "SELECT project_id FROM project_tokens WHERE id = $1",
        [p_id],
      );
      const tokenProjectId = tokenLookup.rows[0]?.project_id;
      const sql = "DELETE FROM project_tokens WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      if (tokenProjectId) {
        broadcast(`project-${tokenProjectId}-tokens`, "tokens_refresh", {
          projectId: tokenProjectId,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // AGENT SESSIONS
    // ============================================================

    case "get_agent_sessions_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM agent_sessions WHERE project_id = $1 ORDER BY created_at DESC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "create_agent_session_with_token": {
      const { p_project_id, p_mode, p_task_description, p_status } =
        params;
      const sql = "INSERT INTO agent_sessions (project_id, status, mode, task_description, started_at, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), $5, NOW(), NOW()) RETURNING *";
      const result = await db.query(sql, [
        p_project_id,
        p_status || "running",
        p_mode,
        p_task_description,
        userId,
      ]);
      broadcast(`project-${p_project_id}-agents`, "agent_session_refresh", {
        projectId: p_project_id,
      });
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "update_agent_session_status_with_token": {
      const { p_id, p_status } = params;
      const sql = "UPDATE agent_sessions SET status = $2, updated_at = NOW(), completed_at = CASE WHEN $2 IN ('completed','failed','aborted') THEN NOW() ELSE completed_at END WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_id, p_status]);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-agents`,
          "agent_session_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "request_agent_session_abort_with_token": {
      const { p_session_id } = params;
      const sql = "UPDATE agent_sessions SET abort_requested = true WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_session_id]);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-agents`,
          "agent_session_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // AGENT LLM LOGS
    // ============================================================

    case "get_agent_llm_logs_with_token": {
      const { p_session_id, p_limit } = params;
      const limit = p_limit || 200;
      const sql = "SELECT * FROM agent_llm_logs WHERE session_id = $1 ORDER BY iteration ASC, created_at ASC LIMIT $2";
      const result = await db.query(sql, [p_session_id, limit]);
      return res.json({ data: result.rows, error: null });
    }

    // ============================================================
    // AUDIT SESSIONS
    // ============================================================

    case "get_audit_sessions_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM audit_sessions WHERE project_id = $1 ORDER BY created_at DESC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_audit_session_with_token": {
      const {
        p_project_id,
        p_name,
        p_description,
        p_dataset_1_type,
        p_dataset_1_ids,
        p_dataset_2_type,
        p_dataset_2_ids,
        p_max_iterations,
        p_agent_definitions,
        p_dataset_1_content,
        p_dataset_2_content,
      } = params;
      const sql = `
        INSERT INTO audit_sessions (project_id, name, description, dataset_1_type, dataset_1_ids, dataset_2_type, dataset_2_ids, 
          max_iterations, agent_definitions, dataset_1_content, dataset_2_content, created_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW()) RETURNING *
      `;
      const result = await db.query(sql, [
        p_project_id,
        p_name || "Untitled Audit",
        p_description || null,
        p_dataset_1_type || "requirements",
        p_dataset_1_ids || null,
        p_dataset_2_type || "artifacts",
        p_dataset_2_ids || null,
        p_max_iterations || 10,
        p_agent_definitions || null,
        p_dataset_1_content || null,
        p_dataset_2_content || null,
        userId,
      ]);
      broadcast(`project-${p_project_id}-audit`, "audit_refresh", {
        projectId: p_project_id,
      });
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_audit_sessions_list_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT id, name, description, status, created_at, updated_at FROM audit_sessions WHERE project_id = $1 ORDER BY created_at DESC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "update_audit_session_with_token": {
      const { p_session_id, p_status, p_current_iteration, p_phase } =
        params;
      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (p_status !== undefined) {
        updates.push(`status = $${idx++}`);
        values.push(p_status);
      }
      if (p_current_iteration !== undefined) {
        updates.push(`current_iteration = $${idx++}`);
        values.push(p_current_iteration);
      }
      if (p_phase !== undefined) {
        updates.push(`phase = $${idx++}`);
        values.push(p_phase);
      }
      updates.push("updated_at = NOW()");
      if (p_status === "completed") updates.push("completed_at = NOW()");

      values.push(p_session_id);
      const sql = `UPDATE audit_sessions SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`;
      const result = await db.query(sql, values);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-audit`,
          "audit_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "update_audit_session_venn_with_token": {
      const { p_session_id, p_venn_result, p_status } = params;
      let sql = "UPDATE audit_sessions SET venn_result = $2, updated_at = NOW()";
      const values: any[] = [p_session_id, p_venn_result];
      if (p_status) {
        sql += ", status = $3, completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE completed_at END";
        values.push(p_status);
      }
      sql += " WHERE id = $1 RETURNING *";
      const result = await db.query(sql, values);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-audit`,
          "audit_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // AUDIT BLACKBOARD
    // ============================================================

    case "get_audit_blackboard_with_token": {
      const { p_session_id } = params;
      const sql = "SELECT * FROM audit_blackboard WHERE session_id = $1 ORDER BY created_at ASC";
      const result = await db.query(sql, [p_session_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_audit_blackboard_with_token": {
      const {
        p_session_id,
        p_agent_role,
        p_entry_type,
        p_content,
        p_iteration,
        p_confidence,
        p_evidence,
        p_target_agent,
      } = params;
      const sql = `
        INSERT INTO audit_blackboard (session_id, agent_role, entry_type, content, iteration, confidence, evidence, target_agent, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING *
      `;
      const result = await db.query(sql, [
        p_session_id,
        p_agent_role,
        p_entry_type,
        p_content,
        p_iteration || 0,
        p_confidence,
        p_evidence,
        p_target_agent,
      ]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // AUDIT ACTIVITY STREAM
    // ============================================================

    case "get_audit_activity_stream_with_token": {
      const { p_session_id, p_limit } = params;
      const sql = "SELECT * FROM audit_activity_stream WHERE session_id = $1 ORDER BY created_at ASC LIMIT $2";
      const result = await db.query(sql, [p_session_id, p_limit || 100]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_audit_activity_batch_with_token": {
      const { p_session_id, p_activities } = params;
      if (
        !p_activities ||
        !Array.isArray(p_activities) ||
        p_activities.length === 0
      ) {
        return res.json({ data: 0, error: null });
      }
      const values: any[] = [];
      const placeholders: string[] = [];
      let idx = 1;
      for (const act of p_activities) {
        placeholders.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, NOW())`,
        );
        values.push(
          p_session_id,
          act.agent_role || null,
          act.activity_type,
          act.title,
          act.content || null,
          act.metadata || {},
        );
      }
      const sql = `INSERT INTO audit_activity_stream (session_id, agent_role, activity_type, title, content, metadata, created_at) VALUES ${placeholders.join(", ")}`;
      await db.query(sql, values);
      return res.json({ data: p_activities.length, error: null });
    }

    // ============================================================
    // AUDIT GRAPH NODES & EDGES
    // ============================================================

    case "get_audit_graph_nodes_with_token": {
      const { p_session_id } = params;
      const sql = "SELECT * FROM audit_graph_nodes WHERE session_id = $1 ORDER BY created_at ASC";
      const result = await db.query(sql, [p_session_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_audit_graph_edges_with_token": {
      const { p_session_id } = params;
      const sql = "SELECT * FROM audit_graph_edges WHERE session_id = $1 ORDER BY created_at ASC";
      const result = await db.query(sql, [p_session_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_audit_graph_nodes_batch_with_token": {
      const { p_session_id, p_nodes } = params;
      if (!p_nodes || !Array.isArray(p_nodes) || p_nodes.length === 0) {
        return res.json({ data: 0, error: null });
      }
      const values: any[] = [];
      const placeholders: string[] = [];
      let idx = 1;
      for (const n of p_nodes) {
        placeholders.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, NOW(), NOW())`,
        );
        values.push(
          n.id || crypto.randomUUID(),
          p_session_id,
          n.label,
          n.description || null,
          n.node_type || "concept",
          n.source_dataset || null,
          n.source_element_ids || [],
          n.created_by_agent || "system",
          n.x_position || 0,
          n.y_position || 0,
          n.color || null,
          n.size || 10,
          n.metadata || {},
        );
      }
      const sql = `
        INSERT INTO audit_graph_nodes (id, session_id, label, description, node_type, source_dataset, source_element_ids, 
          created_by_agent, x_position, y_position, color, size, metadata, created_at, updated_at) 
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, updated_at = NOW()
      `;
      await db.query(sql, values);
      return res.json({ data: p_nodes.length, error: null });
    }

    case "insert_audit_graph_edges_batch_with_token": {
      const { p_session_id, p_edges } = params;
      if (!p_edges || !Array.isArray(p_edges) || p_edges.length === 0) {
        return res.json({ data: 0, error: null });
      }
      const values: any[] = [];
      const placeholders: string[] = [];
      let idx = 1;
      for (const e of p_edges) {
        placeholders.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, NOW())`,
        );
        values.push(
          e.id || crypto.randomUUID(),
          p_session_id,
          e.source_node_id,
          e.target_node_id,
          e.label || null,
          e.edge_type || "relates_to",
          e.weight || 1,
          e.created_by_agent || "system",
          e.metadata || {},
        );
      }
      const sql = `
        INSERT INTO audit_graph_edges (id, session_id, source_node_id, target_node_id, label, edge_type, weight, created_by_agent, metadata, created_at) 
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (id) DO NOTHING
      `;
      await db.query(sql, values);
      return res.json({ data: p_edges.length, error: null });
    }

    case "delete_audit_graph_node_with_token": {
      const { p_node_id } = params;
      // Also delete connected edges
      await db.query(
        "DELETE FROM audit_graph_edges WHERE source_node_id = $1 OR target_node_id = $1",
        [p_node_id],
      );
      const sql = "DELETE FROM audit_graph_nodes WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_node_id]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // AUDIT TESSERACT
    // ============================================================

    case "get_audit_tesseract_cells_with_token": {
      const { p_session_id } = params;
      const sql = "SELECT * FROM audit_tesseract_cells WHERE session_id = $1 ORDER BY x_index, y_step";
      const result = await db.query(sql, [p_session_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "upsert_audit_tesseract_cell_with_token": {
      const {
        p_session_id,
        p_x_index,
        p_x_element_id,
        p_x_element_type,
        p_x_element_label,
        p_y_step,
        p_y_step_label,
        p_z_polarity,
        p_z_criticality,
        p_evidence_summary,
        p_evidence_refs,
        p_contributing_agents,
      } = params;
      const sql = `
        INSERT INTO audit_tesseract_cells (session_id, x_index, x_element_id, x_element_type, x_element_label, y_step, y_step_label, z_polarity, z_criticality, evidence_summary, evidence_refs, contributing_agents, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
        ON CONFLICT (session_id, x_element_id, y_step) DO UPDATE SET
          z_polarity = EXCLUDED.z_polarity, z_criticality = EXCLUDED.z_criticality, evidence_summary = EXCLUDED.evidence_summary,
          evidence_refs = EXCLUDED.evidence_refs, contributing_agents = EXCLUDED.contributing_agents, updated_at = NOW()
        RETURNING *
      `;
      const result = await db.query(sql, [
        p_session_id,
        p_x_index,
        p_x_element_id,
        p_x_element_type,
        p_x_element_label,
        p_y_step,
        p_y_step_label,
        p_z_polarity || 0,
        p_z_criticality || "info",
        p_evidence_summary,
        p_evidence_refs,
        p_contributing_agents,
      ]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "insert_audit_tesseract_cells_batch_with_token": {
      const { p_session_id, p_cells } = params;
      if (!p_cells || !Array.isArray(p_cells) || p_cells.length === 0) {
        return res.json({ data: 0, error: null });
      }
      const values: any[] = [];
      const placeholders: string[] = [];
      let idx = 1;
      for (const c of p_cells) {
        placeholders.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, NOW(), NOW())`,
        );
        values.push(
          p_session_id,
          c.x_index,
          c.x_element_id,
          c.x_element_type,
          c.x_element_label || null,
          c.y_step,
          c.y_step_label || null,
          c.z_polarity || 0,
          c.z_criticality || "info",
          c.evidence_summary || null,
          c.evidence_refs || [],
          c.contributing_agents || [],
        );
      }
      const sql = `
        INSERT INTO audit_tesseract_cells (session_id, x_index, x_element_id, x_element_type, x_element_label, y_step, y_step_label, z_polarity, z_criticality, evidence_summary, evidence_refs, contributing_agents, created_at, updated_at)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (session_id, x_element_id, y_step) DO UPDATE SET
          z_polarity = EXCLUDED.z_polarity, z_criticality = EXCLUDED.z_criticality, evidence_summary = EXCLUDED.evidence_summary,
          evidence_refs = EXCLUDED.evidence_refs, contributing_agents = EXCLUDED.contributing_agents, updated_at = NOW()
      `;
      await db.query(sql, values);
      return res.json({ data: p_cells.length, error: null });
    }

    // ============================================================
    // CANVAS LAYERS
    // ============================================================

    case "upsert_canvas_layer_with_token": {
      const {
        p_id,
        p_project_id,
        p_name,
        p_node_ids,
        p_visible,
        p_z_index,
      } = params;
      if (p_id) {
        const sql = "UPDATE canvas_layers SET name = COALESCE($2, name), node_ids = COALESCE($3, node_ids), visible = COALESCE($4, visible), z_index = COALESCE($5, z_index), updated_at = NOW() WHERE id = $1 RETURNING *";
        const result = await db.query(sql, [
          p_id,
          p_name,
          p_node_ids,
          p_visible,
          p_z_index,
        ]);
        if (result.rows[0]) {
          broadcast(
            `project-${result.rows[0].project_id}-canvas`,
            "canvas_refresh",
            { projectId: result.rows[0].project_id },
          );
        }
        return res.json({ data: result.rows[0] || null, error: null });
      } else {
        const sql = "INSERT INTO canvas_layers (project_id, name, node_ids, visible, z_index, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING *";
        const result = await db.query(sql, [
          p_project_id,
          p_name || "New Layer",
          p_node_ids || [],
          p_visible !== false,
          p_z_index || 0,
        ]);
        broadcast(`project-${p_project_id}-canvas`, "canvas_refresh", {
          projectId: p_project_id,
        });
        return res.json({ data: result.rows[0] || null, error: null });
      }
    }

    case "delete_canvas_layer_with_token": {
      const { p_id } = params;
      const layerLookup = await db.query(
        "SELECT project_id FROM canvas_layers WHERE id = $1",
        [p_id],
      );
      const layerProjectId = layerLookup.rows[0]?.project_id;
      const sql = "DELETE FROM canvas_layers WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      if (layerProjectId) {
        broadcast(`project-${layerProjectId}-canvas`, "canvas_refresh", {
          projectId: layerProjectId,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_canvas_node_types": {
      const { p_include_legacy } = params;
      // If p_include_legacy is true, include legacy nodes, otherwise only active non-legacy nodes
      const sql = p_include_legacy
        ? "SELECT * FROM canvas_node_types WHERE is_active = true ORDER BY order_score ASC"
        : "SELECT * FROM canvas_node_types WHERE is_active = true AND is_legacy = false ORDER BY order_score ASC";
      const result = await db.query(sql);
      return res.json({ data: result.rows, error: null });
    }

    // ============================================================
    // PROJECT STANDARDS & TECH STACKS
    // ============================================================

    case "get_project_standards_with_token": {
      const { p_project_id } = params;
      const sql = `
        SELECT ps.*, s.code, s.title, s.description, s.content, sc.name as category_name, sc.icon as category_icon
        FROM project_standards ps
        JOIN standards s ON s.id = ps.standard_id
        LEFT JOIN standard_categories sc ON sc.id = s.category_id
        WHERE ps.project_id = $1
        ORDER BY sc.order_index, s.order_index
      `;
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_project_standard_with_token": {
      const { p_project_id, p_standard_id } = params;
      const sql = "INSERT INTO project_standards (project_id, standard_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (project_id, standard_id) DO NOTHING RETURNING *";
      const result = await db.query(sql, [p_project_id, p_standard_id]);
      broadcast(
        `project-${p_project_id}-standards`,
        "project_standards_refresh",
        { projectId: p_project_id },
      );
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_project_standard_with_token": {
      const { p_project_id, p_standard_id } = params;
      const sql = "DELETE FROM project_standards WHERE project_id = $1 AND standard_id = $2 RETURNING id";
      const result = await db.query(sql, [p_project_id, p_standard_id]);
      broadcast(
        `project-${p_project_id}-standards`,
        "project_standards_refresh",
        { projectId: p_project_id },
      );
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_project_tech_stacks_with_token": {
      const { p_project_id } = params;
      const sql = `
        SELECT pts.*, ts.name, ts.description, ts.icon, ts.color, ts.type, ts.version, ts.version_constraint,
          parent.name as parent_name
        FROM project_tech_stacks pts
        JOIN tech_stacks ts ON ts.id = pts.tech_stack_id
        LEFT JOIN tech_stacks parent ON parent.id = ts.parent_id
        WHERE pts.project_id = $1
        ORDER BY ts.order_index
      `;
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_project_tech_stack_with_token": {
      const { p_project_id, p_tech_stack_id } = params;
      const sql = "INSERT INTO project_tech_stacks (project_id, tech_stack_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (project_id, tech_stack_id) DO NOTHING RETURNING *";
      const result = await db.query(sql, [p_project_id, p_tech_stack_id]);
      broadcast(
        `project-${p_project_id}-standards`,
        "project_standards_refresh",
        { projectId: p_project_id },
      );
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_project_tech_stack_with_token": {
      const { p_project_id, p_tech_stack_id } = params;
      const sql = "DELETE FROM project_tech_stacks WHERE project_id = $1 AND tech_stack_id = $2 RETURNING id";
      const result = await db.query(sql, [p_project_id, p_tech_stack_id]);
      broadcast(
        `project-${p_project_id}-standards`,
        "project_standards_refresh",
        { projectId: p_project_id },
      );
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // SPECIFICATIONS
    // ============================================================

    case "insert_specification_with_token": {
      const {
        p_project_id,
        p_generated_spec,
        p_raw_data,
        p_agent_id,
        p_agent_title,
      } = params;
      // First, unmark any existing latest specs for this project/agent
      if (p_agent_id) {
        await db.query(
          "UPDATE project_specifications SET is_latest = false WHERE project_id = $1 AND agent_id = $2",
          [p_project_id, p_agent_id],
        );
      }
      // Get next version number
      const versionResult = await db.query(
        "SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM project_specifications WHERE project_id = $1 AND agent_id = $2",
        [p_project_id, p_agent_id || "default"],
      );
      const nextVersion = versionResult.rows[0].next_version;

      const sql = `INSERT INTO project_specifications (project_id, generated_spec, raw_data, agent_id, agent_title, version, is_latest, generated_by_user_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, true, $7, NOW(), NOW()) RETURNING *`;
      const result = await db.query(sql, [
        p_project_id,
        p_generated_spec,
        p_raw_data,
        p_agent_id || "default",
        p_agent_title,
        nextVersion,
        userId,
      ]);
      broadcast(
        `project-${p_project_id}-specifications`,
        "specification_refresh",
        { projectId: p_project_id },
      );
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_specification_with_token": {
      const { p_id } = params;
      const specDelLookup = await db.query(
        "SELECT project_id FROM project_specifications WHERE id = $1",
        [p_id],
      );
      const specDelProjectId = specDelLookup.rows[0]?.project_id;
      const sql = "DELETE FROM project_specifications WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      if (specDelProjectId) {
        broadcast(
          `project-${specDelProjectId}-specifications`,
          "specification_refresh",
          { projectId: specDelProjectId },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "set_specification_latest_with_token": {
      const { p_id } = params;
      // Get the spec to find project_id and agent_id
      const specResult = await db.query(
        "SELECT project_id, agent_id FROM project_specifications WHERE id = $1",
        [p_id],
      );
      if (specResult.rows.length === 0) {
        return res.json({ data: null, error: "Specification not found" });
      }
      const { project_id, agent_id } = specResult.rows[0];
      // Unmark all other specs for this project/agent
      await db.query(
        "UPDATE project_specifications SET is_latest = false WHERE project_id = $1 AND agent_id = $2",
        [project_id, agent_id],
      );
      // Mark this one as latest
      const sql = "UPDATE project_specifications SET is_latest = true, updated_at = NOW() WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_id]);
      broadcast(
        `project-${project_id}-specifications`,
        "specification_refresh",
        { projectId: project_id },
      );
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // FILES & REPOS (Extended)
    // ============================================================

    case "get_file_content_with_token": {
      const { p_file_id } = params;
      const sql = `SELECT rf.id, rf.repo_id, rf.path, rf.is_binary, rf.content_length, rf.last_commit_sha, rf.created_at, rf.updated_at
        FROM repo_files rf WHERE rf.id = $1`;
      const result = await db.query(sql, [p_file_id]);
      if (result.rows.length === 0) {
        return res.json({ data: [], error: null });
      }
      const row = result.rows[0];
      // Read content from committed blob storage (content column was removed from repo_files)
      const repoLookup = await db.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [row.repo_id],
      );
      const projectId = repoLookup.rows[0]?.project_id;
      let content: string | null = null;
      if (projectId) {
        content = await getRepoBlobStore().readCommitted(
          projectId,
          row.repo_id,
          row.path,
        );
      }
      return res.json({
        data: [{ ...row, content: content ?? "" }],
        error: null,
      });
    }

    case "get_repo_files_with_token": {
      const { p_repo_id } = params;
      const sql = "SELECT * FROM repo_files WHERE repo_id = $1 ORDER BY path";
      const result = await db.query(sql, [p_repo_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "rename_file_with_token": {
      const { p_file_id, p_new_path } = params;
      const sql = "UPDATE repo_files SET path = $2, updated_at = NOW() WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_file_id, p_new_path]);
      if (result.rows[0]) {
        const renameRepoLookup = await db.query(
          "SELECT project_id FROM project_repos WHERE id = $1",
          [result.rows[0].repo_id],
        );
        const renameProjectId = renameRepoLookup.rows[0]?.project_id;
        if (renameProjectId) {
          broadcast(
            `project-${renameProjectId}-repo-${result.rows[0].repo_id}`,
            "repo_files_refresh",
            { projectId: renameProjectId, repoId: result.rows[0].repo_id },
          );
        }
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "rename_folder_with_token": {
      const { p_repo_id, p_old_path, p_new_path } = params;
      // Update all files that start with the old path
      const sql = "UPDATE repo_files SET path = $3 || SUBSTRING(path FROM LENGTH($2) + 1), updated_at = NOW() WHERE repo_id = $1 AND path LIKE $2 || '%' RETURNING *";
      const result = await db.query(sql, [p_repo_id, p_old_path, p_new_path]);
      const folderRepoLookup = await db.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [p_repo_id],
      );
      const folderProjectId = folderRepoLookup.rows[0]?.project_id;
      if (folderProjectId) {
        broadcast(
          `project-${folderProjectId}-repo-${p_repo_id}`,
          "repo_files_refresh",
          { projectId: folderProjectId, repoId: p_repo_id },
        );
      }
      return res.json({ data: result.rows, error: null });
    }

    case "stage_file_change_with_token": {
      const {
        p_repo_id,
        p_token,
        p_file_path,
        p_operation_type,
        p_old_content,
        p_new_content,
        p_old_path,
      } = params;
      const result = await stageFileChangeWithToken(
        p_repo_id,
        p_token || null,
        p_file_path,
        p_operation_type,
        p_old_content ?? null,
        p_new_content ?? null,
        p_old_path ?? null,
      );
      // Get project_id for staging broadcast
      const stageRepoLookup = await db.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [p_repo_id],
      );
      const stageProjectId = stageRepoLookup.rows[0]?.project_id;
      if (stageProjectId) {
        broadcast(stagingChannel(p_repo_id), "staging_refresh", {
          projectId: stageProjectId,
          repoId: p_repo_id,
        });
      }
      return res.json({ data: result || null, error: null });
    }

    case "batch_stage_files_with_token": {
      const { p_repo_id, p_project_id, p_token, p_files } = params;
      const parsedBatchLimit = Number.parseInt(
        process.env.STAGING_BATCH_MAX_FILES || "100",
        10,
      );
      const batchLimit =
        Number.isInteger(parsedBatchLimit) && parsedBatchLimit > 0
          ? parsedBatchLimit
          : 100;

      if (!p_repo_id) {
        return res
          .status(400)
          .json({ data: null, error: "p_repo_id is required" });
      }

      if (!Array.isArray(p_files)) {
        return res
          .status(400)
          .json({ data: null, error: "p_files must be an array" });
      }

      if (p_files.length > batchLimit) {
        return res.status(400).json({
          data: null,
          error: `p_files exceeds maximum batch size of ${batchLimit}`,
        });
      }

      const files: BatchStageFileInput[] = [];
      for (const file of p_files) {
        if (!file?.file_path) {
          return res
            .status(400)
            .json({ data: null, error: "Each file requires file_path" });
        }
        if (!file.operation_type) {
          return res.status(400).json({
            data: null,
            error: `File ${file.file_path} requires operation_type`,
          });
        }
        files.push({
          filePath: file.file_path,
          operationType: file.operation_type,
          newContent: file.new_content ?? null,
          oldPath: file.old_path ?? null,
        });
      }

      const repoLookup = await db.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [p_repo_id],
      );
      const projectId = p_project_id || repoLookup.rows[0]?.project_id;
      if (!projectId) {
        return res
          .status(404)
          .json({ data: null, error: "Repository not found" });
      }

      const result = await batchStageFiles(
        p_repo_id,
        p_token || null,
        files,
        projectId,
      );
      broadcast(stagingChannel(p_repo_id), "staging_refresh", {
        projectId,
        repoId: p_repo_id,
      });
      return res.json({ data: result, error: null });
    }

    case "unstage_file_with_token": {
      const { p_repo_id, p_file_path } = params;
      const unstageRepoLookup = await db.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [p_repo_id],
      );
      const unstageProjectId = unstageRepoLookup.rows[0]?.project_id;
      const sql = "DELETE FROM repo_staging WHERE repo_id = $1 AND file_path = $2 RETURNING id";
      const result = await db.query(sql, [p_repo_id, p_file_path]);
      if (unstageProjectId) {
        try {
          await getRepoBlobStore().deleteStaged(
            unstageProjectId,
            p_repo_id,
            p_file_path,
          );
        } catch (cleanupError) {
          logger.warn("Failed to clean up discarded staged blob", {
            repo_id: p_repo_id,
            file_path: p_file_path,
            error: (cleanupError as Error).message,
          });
        }
        broadcast(stagingChannel(p_repo_id), "staging_refresh", {
          projectId: unstageProjectId,
          repoId: p_repo_id,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_staged_changes_with_token": {
      const { p_repo_id } = params;
      const sql = "SELECT * FROM repo_staging WHERE repo_id = $1 ORDER BY created_at";
      const result = await db.query(sql, [p_repo_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_staged_file_content_with_token": {
      const { p_repo_id, p_file_path } = params;

      if (!p_repo_id) {
        return res
          .status(400)
          .json({ data: null, error: "p_repo_id is required" });
      }
      if (!p_file_path) {
        return res
          .status(400)
          .json({ data: null, error: "p_file_path is required" });
      }

      const stagingRow = await db.query(
        "SELECT operation_type, is_binary FROM repo_staging WHERE repo_id = $1 AND file_path = $2",
        [p_repo_id, p_file_path],
      );
      if (stagingRow.rows.length === 0) {
        return res.json({ data: null, error: null });
      }

      const row = stagingRow.rows[0];
      if (row.operation_type === "delete") {
        return res.json({
          data: {
            content: null,
            operation_type: row.operation_type,
            is_binary: row.is_binary ?? false,
          },
          error: null,
        });
      }

      // Delegate to StagedContentStore facade — blob is the canonical source of truth
      const staged = await getStagedContent(p_repo_id, p_file_path);
      if (!staged) {
        return res.json({ data: null, error: null });
      }

      // Read committed baseline from blob storage for diff "before" side.
      // For 'add'/'create' operations, there is no committed version.
      let oldContent = "";
      if (row.operation_type !== "add" && row.operation_type !== "create") {
        const repoLookup = await db.query(
          "SELECT project_id FROM project_repos WHERE id = $1",
          [p_repo_id],
        );
        const projId = repoLookup.rows[0]?.project_id;
        if (projId) {
          oldContent =
            (await getRepoBlobStore().readCommitted(
              projId,
              p_repo_id,
              p_file_path,
            )) ?? "";
        }
      }

      return res.json({
        data: {
          content: staged.content,
          operation_type: staged.operationType,
          old_content: oldContent,
          is_binary: staged.isBinary,
        },
        error: null,
      });
    }

    case "get_file_content_by_path_with_token": {
      const { p_repo_id, p_file_path, p_token } = params;

      if (!p_repo_id) {
        return res
          .status(400)
          .json({ data: null, error: "p_repo_id is required" });
      }

      if (!p_file_path) {
        return res
          .status(400)
          .json({ data: null, error: "p_file_path is required" });
      }

      const result = await getFileContentByPathWithToken(
        p_repo_id,
        p_file_path,
        p_token || null,
      );
      return res.json({ data: result, error: null });
    }

    case "get_committed_file_content_by_path_with_token": {
      // Returns only committed repo_files content — never staged blobs.
      // Used by StagingPanel to get the diff "before" baseline without accidentally
      // returning the staged version of the same file.
      const { p_repo_id, p_file_path } = params;

      if (!p_repo_id) {
        return res
          .status(400)
          .json({ data: null, error: "p_repo_id is required" });
      }

      if (!p_file_path) {
        return res
          .status(400)
          .json({ data: null, error: "p_file_path is required" });
      }

      const committedResult = await db.query(
        "SELECT is_binary, content_length FROM repo_files WHERE repo_id = $1 AND path = $2",
        [p_repo_id, p_file_path],
      );
      if (committedResult.rows.length === 0) {
        return res.json({ data: null, error: null });
      }
      const committedRow = committedResult.rows[0];
      // Read content from committed blob storage (content column was removed from repo_files)
      const committedRepoLookup = await db.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [p_repo_id],
      );
      const committedProjectId = committedRepoLookup.rows[0]?.project_id;
      let committedContent: string | null = null;
      if (committedProjectId) {
        committedContent = await getRepoBlobStore().readCommitted(
          committedProjectId,
          p_repo_id,
          p_file_path,
        );
      }
      return res.json({
        data: { ...committedRow, content: committedContent ?? "" },
        error: null,
      });
    }

    case "get_project_files_metadata_with_token": {
      const { p_project_id } = params;
      const sql = `SELECT rf.id, rf.repo_id, rf.path, rf.content_length, rf.is_binary, rf.last_commit_sha, rf.updated_at
        FROM repo_files rf
        JOIN project_repos pr ON pr.id = rf.repo_id
        WHERE pr.project_id = $1
        ORDER BY rf.path`;
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_staged_changes_metadata_with_token": {
      const { p_repo_id } = params;
      const sql = `SELECT id, repo_id, file_path, operation_type, old_path, content_length, is_binary, created_at
        FROM repo_staging
        WHERE repo_id = $1
        ORDER BY file_path`;
      const result = await db.query(sql, [p_repo_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "delete_project_repo_with_token": {
      const { p_repo_id } = params;
      // Get project_id before deleting
      const delRepoLookup = await db.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [p_repo_id],
      );
      const delRepoProjectId = delRepoLookup.rows[0]?.project_id;
      // Delete associated files, staging, and commits first
      await db.query("DELETE FROM repo_staging WHERE repo_id = $1", [
        p_repo_id,
      ]);
      await db.query("DELETE FROM repo_files WHERE repo_id = $1", [p_repo_id]);
      await db.query("DELETE FROM repo_commits WHERE repo_id = $1", [
        p_repo_id,
      ]);
      const sql = "DELETE FROM project_repos WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_repo_id]);
      if (delRepoProjectId) {
        broadcast(`project-${delRepoProjectId}-repos`, "repos_refresh", {
          projectId: delRepoProjectId,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_project_files_with_token": {
      const { p_project_id, p_repo_id } = params;
      let sql: string, queryParams: any[];
      if (p_repo_id) {
        sql = "SELECT * FROM repo_files WHERE repo_id = $1 ORDER BY path";
        queryParams = [p_repo_id];
      } else {
        sql = "SELECT rf.* FROM repo_files rf JOIN project_repos pr ON pr.id = rf.repo_id WHERE pr.project_id = $1 ORDER BY rf.path";
        queryParams = [p_project_id];
      }
      const result = await db.query(sql, queryParams);
      return res.json({ data: result.rows, error: null });
    }

    case "commit_staged_with_token": {
      const { p_repo_id, p_commit_message, p_branch, p_file_paths } =
        params;
      const startedAt = Date.now();
      let commitFilesCount = 0;
      const selectedFilePaths = Array.isArray(p_file_paths)
        ? p_file_paths
        : null;
      if (selectedFilePaths && selectedFilePaths.length === 0) {
        return res.status(400).json({
          data: null,
          error: "Select at least one staged file to commit",
        });
      }
      const client = await db.getClient();
      const committedBlobPaths: string[] = [];
      // Resolve projectId before the transaction so it's available for rollback blob cleanup
      const commitRepoLookup = await client.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [p_repo_id],
      );
      if (commitRepoLookup.rows.length === 0) {
        client.release();
        return res.json({ data: null, error: "Repository not found" });
      }
      const projectId = commitRepoLookup.rows[0].project_id;
      try {
        await client.query("BEGIN");

        // Get staged changes
        const stagedResult = selectedFilePaths
          ? await client.query(
              "SELECT * FROM repo_staging WHERE repo_id = $1 AND file_path = ANY($2)",
              [p_repo_id, selectedFilePaths],
            )
          : await client.query(
              "SELECT * FROM repo_staging WHERE repo_id = $1",
              [p_repo_id],
            );
        const staged = stagedResult.rows;
        commitFilesCount = staged.length;

        if (staged.length === 0) {
          await client.query("ROLLBACK");
          return res.json({ data: null, error: "No staged changes to commit" });
        }

        // Generate commit SHA
        const commitSha = crypto.randomBytes(20).toString("hex");

        // Create commit record
        const commitResult = await client.query(
          `INSERT INTO repo_commits (repo_id, project_id, branch, commit_sha, commit_message, files_changed, committed_by, committed_at, created_at, files_metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), $8) RETURNING *`,
          [
            p_repo_id,
            projectId,
            p_branch || "main",
            commitSha,
            p_commit_message || "Committed changes",
            staged.length,
            userId,
            JSON.stringify(
              staged.map((s) => ({
                path: s.file_path,
                operation: s.operation_type,
              })),
            ),
          ],
        );

        // Apply staged changes to repo_files
        for (const stage of staged) {
          if (stage.operation_type === "delete") {
            await client.query(
              "DELETE FROM repo_files WHERE repo_id = $1 AND path = $2",
              [p_repo_id, stage.file_path],
            );
            // Best-effort removal of committed blob
            try {
              await getRepoBlobStore().deleteCommitted(
                projectId,
                p_repo_id,
                stage.file_path,
              );
            } catch (deleteErr) {
              logger.warn("Failed to delete committed blob for deleted file", {
                repo_id: p_repo_id,
                file_path: stage.file_path,
                error: (deleteErr as Error).message,
              });
            }
          } else if (
            ["create", "modify", "add", "edit"].includes(stage.operation_type)
          ) {
            const stagedContent = await getRepoBlobStore().readStaged(
              projectId,
              p_repo_id,
              stage.file_path,
            );
            if (stagedContent === null || stagedContent === undefined) {
              throw new Error(
                `Missing staged blob content for ${stage.file_path}; re-stage the file and try committing again.`,
              );
            }
            // Write committed blob
            await getRepoBlobStore().writeCommitted(
              projectId,
              p_repo_id,
              stage.file_path,
              stagedContent,
            );
            committedBlobPaths.push(stage.file_path);
            // Metadata-only UPSERT into repo_files (no content column)
            const { isBinary, contentLength } =
              computeContentMeta(stagedContent);
            await client.query(
              `INSERT INTO repo_files (repo_id, project_id, path, is_binary, content_length, last_commit_sha, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
               ON CONFLICT (repo_id, path) DO UPDATE SET is_binary = $4, content_length = $5, last_commit_sha = $6, updated_at = NOW()`,
              [
                p_repo_id,
                projectId,
                stage.file_path,
                isBinary,
                contentLength,
                commitSha,
              ],
            );
          } else if (stage.operation_type === "rename") {
            await client.query(
              `UPDATE repo_files
              SET path = CASE
                WHEN path = $2 THEN $3
                WHEN path LIKE $2 || '/%' THEN $3 || substring(path from length($2) + 1)
                ELSE path
              END,
              last_commit_sha = $4,
              updated_at = NOW()
              WHERE repo_id = $1 AND (path = $2 OR path LIKE $2 || '/%')`,
              [p_repo_id, stage.old_path, stage.file_path, commitSha],
            );
            // Copy committed blob from old path to new path
            try {
              const renamedContent = await getRepoBlobStore().readCommitted(
                projectId,
                p_repo_id,
                stage.old_path,
              );
              if (renamedContent !== null) {
                await getRepoBlobStore().writeCommitted(
                  projectId,
                  p_repo_id,
                  stage.file_path,
                  renamedContent,
                );
                await getRepoBlobStore().deleteCommitted(
                  projectId,
                  p_repo_id,
                  stage.old_path,
                );
              }
            } catch (renameErr) {
              logger.warn("Failed to copy committed blob during rename", {
                repo_id: p_repo_id,
                old_path: stage.old_path,
                new_path: stage.file_path,
                error: (renameErr as Error).message,
              });
            }
          }
        }

        // Clear staging
        if (selectedFilePaths) {
          await client.query(
            "DELETE FROM repo_staging WHERE repo_id = $1 AND file_path = ANY($2)",
            [p_repo_id, selectedFilePaths],
          );
        } else {
          await client.query("DELETE FROM repo_staging WHERE repo_id = $1", [
            p_repo_id,
          ]);
        }

        await client.query("COMMIT");

        for (const filePath of committedBlobPaths) {
          try {
            await getRepoBlobStore().deleteStaged(
              projectId,
              p_repo_id,
              filePath,
            );
          } catch (cleanupError) {
            logger.warn("Failed to clean up committed staged blob", {
              repo_id: p_repo_id,
              file_path: filePath,
              error: (cleanupError as Error).message,
            });
          }
        }

        // Broadcast staging cleared + files updated
        broadcast(stagingChannel(p_repo_id), "staging_refresh", {
          projectId,
          repoId: p_repo_id,
        });
        broadcast(repoFilesChannel(projectId), "repo_files_refresh", {
          projectId,
          repoId: p_repo_id,
        });
        broadcast(`project-${projectId}-repos`, "repos_refresh", { projectId });
        logger.info({
          event: "commit_complete",
          commit_duration_ms: Date.now() - startedAt,
          commit_files_count: commitFilesCount,
          success: true,
        });
        return res.json({ data: commitResult.rows[0], error: null });
      } catch (error) {
        await client.query("ROLLBACK");
        // Blob rollback: remove committed blobs written in this batch
        for (const filePath of committedBlobPaths) {
          try {
            await getRepoBlobStore().deleteCommitted(
              projectId,
              p_repo_id,
              filePath,
            );
          } catch {
            // Best-effort: orphaned committed blobs will be overwritten on next successful commit
          }
        }
        logger.info({
          event: "commit_complete",
          commit_duration_ms: Date.now() - startedAt,
          commit_files_count: commitFilesCount,
          success: false,
        });
        throw error;
      } finally {
        client.release();
      }
    }

    case "get_commit_history_with_token": {
      const { p_repo_id, p_limit } = params;
      const sql = "SELECT * FROM repo_commits WHERE repo_id = $1 ORDER BY committed_at DESC LIMIT $2";
      const result = await db.query(sql, [p_repo_id, p_limit || 50]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_repo_commits_with_token": {
      const { p_repo_id, p_branch } = params;
      let sql = "SELECT * FROM repo_commits WHERE repo_id = $1";
      const queryParams: any[] = [p_repo_id];
      if (p_branch) {
        sql += " AND branch = $2";
        queryParams.push(p_branch);
      }
      sql += " ORDER BY committed_at DESC";
      const result = await db.query(sql, queryParams);
      return res.json({ data: result.rows, error: null });
    }

    case "set_repo_prime_with_token": {
      const { p_repo_id } = params;
      // Get project_id from the repo
      const repoResult = await db.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [p_repo_id],
      );
      if (repoResult.rows.length === 0) {
        return res.json({ data: null, error: "Repository not found" });
      }
      const projectId = repoResult.rows[0].project_id;
      // Unset all other repos as prime
      await db.query(
        "UPDATE project_repos SET is_prime = false WHERE project_id = $1",
        [projectId],
      );
      // Set this one as prime
      const sql = "UPDATE project_repos SET is_prime = true, updated_at = NOW() WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_repo_id]);
      broadcast(`project-${projectId}-repos`, "repos_refresh", { projectId });
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "reset_repo_files_with_token": {
      const { p_repo_id } = params;
      // Resolve project_id for blob container
      const resetRepoLookup = await db.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [p_repo_id],
      );
      const resetProjectId = resetRepoLookup.rows[0]?.project_id;
      // Clear staging and reset to last committed state
      await db.query("DELETE FROM repo_staging WHERE repo_id = $1", [
        p_repo_id,
      ]);
      if (resetProjectId) {
        try {
          await getRepoBlobStore().deleteAllStaged(resetProjectId, p_repo_id);
        } catch (cleanupError) {
          logger.warn("Failed to clean up discarded staged blobs", {
            repo_id: p_repo_id,
            error: (cleanupError as Error).message,
          });
        }
      }
      return res.json({ data: { success: true }, error: null });
    }

    case "insert_repo_pat_with_token": {
      const { p_repo_id, p_pat } = params;
      if (!userId) {
        return res.json({ data: null, error: "User not authenticated" });
      }
      const sql = "INSERT INTO repo_pats (user_id, repo_id, pat, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, repo_id) DO UPDATE SET pat = $3 RETURNING *";
      const result = await db.query(sql, [userId, p_repo_id, p_pat]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_repo_pat_with_token": {
      const { p_repo_id } = params;
      if (!userId) {
        return res.json({ data: null, error: "User not authenticated" });
      }
      const sql = "DELETE FROM repo_pats WHERE user_id = $1 AND repo_id = $2 RETURNING id";
      const result = await db.query(sql, [userId, p_repo_id]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // AGENT OPERATIONS & MESSAGES
    // ============================================================

    case "get_agent_messages_with_token": {
      const { p_session_id, p_limit, p_offset } = params;
      const sql = "SELECT * FROM agent_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3";
      const result = await db.query(sql, [
        p_session_id,
        p_limit || 50,
        p_offset || 0,
      ]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_agent_operations_by_project_with_token": {
      const { p_project_id, p_limit, p_offset } = params;
      const sql = `
        SELECT afo.*, asess.mode, asess.task_description 
        FROM agent_file_operations afo
        JOIN agent_sessions asess ON asess.id = afo.session_id
        WHERE asess.project_id = $1
        ORDER BY afo.created_at DESC
        LIMIT $2 OFFSET $3
      `;
      const result = await db.query(sql, [
        p_project_id,
        p_limit || 50,
        p_offset || 0,
      ]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_project_agent_with_token": {
      const { p_project_id, p_agent_type } = params;
      try {
        const sql = "SELECT * FROM project_agents WHERE project_id = $1 AND agent_type = $2 LIMIT 1";
        const result = await db.query(sql, [
          p_project_id,
          p_agent_type || "coding",
        ]);
        return res.json({ data: result.rows, error: null });
      } catch {
        return res.json({ data: [], error: null });
      }
    }

    case "upsert_project_agent_with_token": {
      const { p_project_id, p_agent_type, p_config } = params;
      try {
        const sql = `INSERT INTO project_agents (project_id, agent_type, config, updated_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (project_id, agent_type) DO UPDATE SET config = $3, updated_at = NOW()
          RETURNING *`;
        const result = await db.query(sql, [
          p_project_id,
          p_agent_type || "coding",
          JSON.stringify(p_config),
        ]);
        return res.json({ data: result.rows[0] || { id: null }, error: null });
      } catch {
        return res.json({ data: { id: null }, error: null });
      }
    }

    case "delete_project_agent_with_token": {
      const { p_project_id, p_agent_type } = params;
      try {
        const sql = "DELETE FROM project_agents WHERE project_id = $1 AND agent_type = $2 RETURNING id";
        const result = await db.query(sql, [
          p_project_id,
          p_agent_type || "coding",
        ]);
        return res.json({ data: result.rows[0] || { id: null }, error: null });
      } catch {
        return res.json({ data: { id: null }, error: null });
      }
    }

    // ============================================================
    // COLLABORATION
    // ============================================================

    case "get_artifact_collaboration_with_token": {
      const { p_collaboration_id } = params;
      const sql = "SELECT * FROM artifact_collaborations WHERE id = $1";
      const result = await db.query(sql, [p_collaboration_id]);
      const collabRow = result.rows[0] || null;
      if (collabRow) {
        // current_content column was dropped (migration 006) — hydrate from blob storage
        collabRow.current_content =
          (await getRepoBlobStore().readCollabCurrent(
            collabRow.project_id,
            p_collaboration_id,
          )) ?? "";
      }
      return res.json({ data: collabRow, error: null });
    }

    case "update_artifact_collaboration_with_token": {
      const { p_collaboration_id, p_current_content, p_status } =
        params;

      // Write content to blob storage if provided (before DB update)
      if (p_current_content !== undefined) {
        try {
          // Look up project_id for the collaboration container
          const collabLookup = await db.query(
            "SELECT project_id FROM artifact_collaborations WHERE id = $1",
            [p_collaboration_id],
          );
          const collabProjectId = collabLookup.rows[0]?.project_id;
          if (!collabProjectId) {
            return res
              .status(404)
              .json({ data: null, error: "Collaboration not found" });
          }
          await getRepoBlobStore().writeCollabCurrent(
            collabProjectId,
            p_collaboration_id,
            p_current_content,
          );
        } catch (blobErr: any) {
          return res.status(500).json({
            data: null,
            error: `Failed to write collaboration content: ${blobErr.message}`,
          });
        }
      }

      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;

      // No longer write current_content to DB — it's blob-backed
      if (p_status !== undefined) {
        updates.push(`status = $${idx++}`);
        values.push(p_status);
      }
      updates.push("updated_at = NOW()");

      values.push(p_collaboration_id);
      const sql = `UPDATE artifact_collaborations SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`;
      const result = await db.query(sql, values);
      if (result.rows[0]) {
        broadcast(`collaboration-${p_collaboration_id}`, "collaboration_edit", {
          collaborationId: p_collaboration_id,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_collaboration_messages_with_token": {
      const { p_collaboration_id } = params;
      const sql = "SELECT * FROM artifact_collaboration_messages WHERE collaboration_id = $1 ORDER BY created_at ASC";
      const result = await db.query(sql, [p_collaboration_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_collaboration_message_with_token": {
      const { p_collaboration_id, p_role, p_content, p_metadata } =
        params;
      const sql = "INSERT INTO artifact_collaboration_messages (collaboration_id, role, content, metadata, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *";
      const result = await db.query(sql, [
        p_collaboration_id,
        p_role,
        p_content,
        p_metadata || {},
      ]);
      broadcast(
        `collaboration-${p_collaboration_id}`,
        "collaboration_message",
        { collaborationId: p_collaboration_id },
      );
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_collaboration_history_with_token": {
      const { p_collaboration_id } = params;
      const sql = "SELECT * FROM artifact_collaboration_history WHERE collaboration_id = $1 ORDER BY version_number ASC";
      const result = await db.query(sql, [p_collaboration_id]);
      // full_content_snapshot column was dropped (migration 006) — hydrate from blob storage
      if (result.rows.length > 0) {
        const collabLookup = await db.query(
          "SELECT project_id FROM artifact_collaborations WHERE id = $1",
          [p_collaboration_id],
        );
        const histProjectId = collabLookup.rows[0]?.project_id;
        if (histProjectId) {
          await Promise.all(
            result.rows.map(async (row: any) => {
              row.full_content_snapshot =
                (await getRepoBlobStore().readCollabSnapshot(
                  histProjectId,
                  p_collaboration_id,
                  row.version_number,
                )) ?? null;
            }),
          );
        }
      }
      return res.json({ data: result.rows, error: null });
    }

    case "insert_collaboration_edit_with_token": {
      const {
        p_collaboration_id,
        p_operation_type,
        p_start_line,
        p_end_line,
        p_old_content,
        p_new_content,
        p_new_full_content,
        p_narrative,
        p_actor_type,
        p_actor_identifier,
      } = params;
      // Get next version number
      const versionResult = await db.query(
        "SELECT COALESCE(MAX(version_number), 0) + 1 as next_version FROM artifact_collaboration_history WHERE collaboration_id = $1",
        [p_collaboration_id],
      );
      const nextVersion = versionResult.rows[0].next_version;

      // Write full content snapshot to blob storage (not DB)
      if (p_new_full_content) {
        const editCollabLookup = await db.query(
          "SELECT project_id FROM artifact_collaborations WHERE id = $1",
          [p_collaboration_id],
        );
        const editProjectId = editCollabLookup.rows[0]?.project_id;
        if (editProjectId) {
          await getRepoBlobStore().writeCollabSnapshot(
            editProjectId,
            p_collaboration_id,
            nextVersion,
            p_new_full_content,
          );
        }
      }

      const sql = `
        INSERT INTO artifact_collaboration_history (collaboration_id, version_number, actor_type, actor_identifier, operation_type, start_line, end_line, old_content, new_content, narrative, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()) RETURNING *
      `;
      const result = await db.query(sql, [
        p_collaboration_id,
        nextVersion,
        p_actor_type,
        p_actor_identifier,
        p_operation_type,
        p_start_line,
        p_end_line,
        p_old_content,
        p_new_content,
        p_narrative,
      ]);
      broadcast(`collaboration-${p_collaboration_id}`, "collaboration_edit", {
        collaborationId: p_collaboration_id,
      });
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "restore_collaboration_version_with_token": {
      const { p_collaboration_id, p_version_number } = params;
      // Look up project_id for the collaboration container
      const restoreCollabLookup = await db.query(
        "SELECT project_id FROM artifact_collaborations WHERE id = $1",
        [p_collaboration_id],
      );
      const restoreProjectId = restoreCollabLookup.rows[0]?.project_id;
      if (!restoreProjectId) {
        return res
          .status(404)
          .json({ data: null, error: "Collaboration not found" });
      }
      // Read snapshot from blob storage
      const snapshotContent = await getRepoBlobStore().readCollabSnapshot(
        restoreProjectId,
        p_collaboration_id,
        p_version_number,
      );
      if (snapshotContent === null) {
        return res
          .status(404)
          .json({ data: null, error: "Version snapshot not found" });
      }
      // Write restored content to current blob
      await getRepoBlobStore().writeCollabCurrent(
        restoreProjectId,
        p_collaboration_id,
        snapshotContent,
      );
      // Update the collaboration metadata (no current_content column)
      const sql = "UPDATE artifact_collaborations SET updated_at = NOW() WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_collaboration_id]);
      broadcast(
        `collaboration-${p_collaboration_id}`,
        "collaboration_restore",
        { collaborationId: p_collaboration_id },
      );
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_collaboration_blackboard_with_token": {
      const { p_collaboration_id } = params;
      const sql = "SELECT * FROM artifact_collaboration_blackboard WHERE collaboration_id = $1 ORDER BY created_at ASC";
      const result = await db.query(sql, [p_collaboration_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_collaboration_blackboard_with_token": {
      const {
        p_collaboration_id,
        p_entry_type,
        p_content,
        p_metadata,
      } = params;
      const sql = "INSERT INTO artifact_collaboration_blackboard (collaboration_id, entry_type, content, metadata, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *";
      const result = await db.query(sql, [
        p_collaboration_id,
        p_entry_type,
        p_content,
        p_metadata || {},
      ]);
      broadcast(
        `collaboration-${p_collaboration_id}`,
        "collaboration_blackboard",
        { collaborationId: p_collaboration_id },
      );
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // CHAT (Extended)
    // ============================================================

    case "delete_chat_message_with_token": {
      const { p_id } = params;
      const msgLookup = await db.query(
        "SELECT project_id, chat_session_id FROM chat_messages WHERE id = $1",
        [p_id],
      );
      const msgProjectId = msgLookup.rows[0]?.project_id;
      const sql = "DELETE FROM chat_messages WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      if (msgProjectId) {
        broadcast(`project-${msgProjectId}-chat`, "chat_message_refresh", {
          projectId: msgProjectId,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "clone_chat_session_with_token": {
      const { p_session_id, p_new_title } = params;
      const client = await db.getClient();
      try {
        await client.query("BEGIN");
        // Get original session
        const sessionResult = await client.query(
          "SELECT * FROM chat_sessions WHERE id = $1",
          [p_session_id],
        );
        if (sessionResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.json({ data: null, error: "Session not found" });
        }
        const original = sessionResult.rows[0];
        // Create new session
        const newSessionResult = await client.query(
          "INSERT INTO chat_sessions (project_id, title, created_by, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *",
          [
            original.project_id,
            p_new_title || `Copy of ${original.title || "Untitled"}`,
            userId,
          ],
        );
        const newSession = newSessionResult.rows[0];
        // Copy messages
        await client.query(
          `INSERT INTO chat_messages (chat_session_id, project_id, role, content, created_by, created_at)
           SELECT $1, project_id, role, content, $2, NOW() FROM chat_messages WHERE chat_session_id = $3 ORDER BY created_at`,
          [newSession.id, userId, p_session_id],
        );
        await client.query("COMMIT");
        broadcast(
          `project-${original.project_id}-chat`,
          "chat_session_refresh",
          { projectId: original.project_id },
        );
        return res.json({ data: newSession, error: null });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    // ============================================================
    // DATABASES & CONNECTIONS
    // ============================================================

    case "get_databases_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM project_databases WHERE project_id = $1 ORDER BY created_at DESC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_db_connections_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM project_database_connections WHERE project_id = $1 ORDER BY created_at DESC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    // ============================================================
    // DEPLOYMENTS
    // ============================================================

    case "get_deployments_with_token": {
      const { p_project_id } = params;
      const sql = "SELECT * FROM project_deployments WHERE project_id = $1 ORDER BY created_at DESC";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_deployment_with_token": {
      const {
        p_project_id,
        p_repo_id,
        p_name,
        p_environment,
        p_platform,
        p_project_type,
        p_run_folder,
        p_run_command,
        p_build_command,
        p_build_folder,
        p_branch,
        p_dockerfile_path,
      } = params;
      const sql = `
        INSERT INTO project_deployments (project_id, repo_id, name, environment, platform, project_type, run_folder, run_command, build_command, build_folder, branch, dockerfile_path, created_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW()) RETURNING *
      `;
      const result = await db.query(sql, [
        p_project_id,
        p_repo_id,
        p_name || "Deployment",
        p_environment || "dev",
        p_platform || "pronghorn_cloud",
        p_project_type || "node",
        p_run_folder || "/",
        p_run_command || "npm run dev",
        p_build_command || "npm run build",
        p_build_folder || "dist",
        p_branch || "main",
        p_dockerfile_path || "Dockerfile",
        userId,
      ]);
      broadcast(`project-${p_project_id}-deployments`, "deployment_refresh", {
        projectId: p_project_id,
      });
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "update_deployment_with_token": {
      const {
        p_deployment_id,
        p_name,
        p_environment,
        p_status,
        p_url,
        p_run_command,
        p_build_command,
        p_build_folder,
        p_branch,
        p_env_vars,
        p_secrets,
        p_dockerfile_path,
      } = params;
      // The frontend and the typed RPC contract pass `p_deployment_id`; alias
      // it so the row update and Key Vault write target the correct row instead
      // of resolving to `undefined` (which made `WHERE id = NULL` update zero
      // rows and `ensureGenappKeyVault` throw `appId is required`).
      const p_id = p_deployment_id;
      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (p_name !== undefined) {
        updates.push(`name = $${idx++}`);
        values.push(p_name);
      }
      if (p_environment !== undefined) {
        updates.push(`environment = $${idx++}`);
        values.push(p_environment);
      }
      if (p_status !== undefined) {
        updates.push(`status = $${idx++}`);
        values.push(p_status);
      }
      if (p_url !== undefined) {
        updates.push(`url = $${idx++}`);
        values.push(p_url);
      }
      if (p_run_command !== undefined) {
        updates.push(`run_command = $${idx++}`);
        values.push(p_run_command);
      }
      if (p_build_command !== undefined) {
        updates.push(`build_command = $${idx++}`);
        values.push(p_build_command);
      }
      if (p_build_folder !== undefined) {
        updates.push(`build_folder = $${idx++}`);
        values.push(p_build_folder);
      }
      if (p_branch !== undefined) {
        updates.push(`branch = $${idx++}`);
        values.push(p_branch);
      }
      // Env vars + secret VALUES no longer live in Postgres — they are written
      // to the per-deployment Key Vault below (after the row update).
      if (p_dockerfile_path !== undefined) {
        updates.push(`dockerfile_path = $${idx++}`);
        values.push(p_dockerfile_path);
      }
      updates.push("updated_at = NOW()");
      if (p_status === "running") updates.push("last_deployed_at = NOW()");

      values.push(p_id);
      const sql = `UPDATE project_deployments SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`;
      const result = await db.query(sql, values);

      // Persist env-var / secret VALUES into the per-deployment Key Vault.
      // The provided maps are AUTHORITATIVE for whichever kind(s) are supplied:
      // entries present are upserted, and entries of that kind that are absent
      // from the map are pruned so removed env vars/secrets do not linger. A KV
      // failure is surfaced to the caller — the values live ONLY in Key Vault,
      // so a silent success would silently lose the user's data.
      if (p_env_vars !== undefined || p_secrets !== undefined) {
        const parseMap = (v: unknown): Record<string, unknown> => {
          if (!v) return {};
          if (typeof v === "string") {
            try {
              return JSON.parse(v);
            } catch {
              return {};
            }
          }
          return v as Record<string, unknown>;
        };
        try {
          const { name: kvName, uri } = await ensureGenappKeyVault({
            appId: p_id,
          });
          const current = await getGenappSecrets(uri);
          const desired: GenappSecretEntry[] = [];
          const removed: GenappSecretEntry[] = [];

          if (p_env_vars !== undefined) {
            const envMap = parseMap(p_env_vars);
            for (const [k, val] of Object.entries(envMap))
              desired.push({
                envName: k,
                value: String(val ?? ""),
                kind: "env",
              });
            for (const [k, v] of Object.entries(current))
              if (v.kind === "env" && !(k in envMap))
                removed.push({ envName: k, value: "", kind: "env" });
          }
          if (p_secrets !== undefined) {
            const secMap = parseMap(p_secrets);
            for (const [k, val] of Object.entries(secMap))
              desired.push({
                envName: k,
                value: String(val ?? ""),
                kind: "secret",
              });
            for (const [k, v] of Object.entries(current))
              if (v.kind === "secret" && !(k in secMap))
                removed.push({ envName: k, value: "", kind: "secret" });
          }

          if (desired.length > 0) await setGenappSecrets(uri, desired);
          if (removed.length > 0) await deleteGenappSecrets(uri, removed);
          await db.query(
            "UPDATE project_deployments SET azure_key_vault_name = $1, azure_key_vault_uri = $2, updated_at = NOW() WHERE id = $3",
            [kvName, uri, p_id],
          );
        } catch (kvErr: any) {
          logger.error(
            `[update_deployment_with_token] Key Vault write failed: ${kvErr.message}`,
          );
          return res.status(502).json({
            data: null,
            error: `Failed to store secrets in Key Vault: ${kvErr.message}`,
          });
        }
      }

      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-deployments`,
          "deployment_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_deployment_with_token": {
      const { p_id } = params;
      const deployLookup = await db.query(
        "SELECT project_id FROM project_deployments WHERE id = $1",
        [p_id],
      );
      const deployProjectId = deployLookup.rows[0]?.project_id;
      // Purge the per-deployment Key Vault (best-effort) now that the app is
      // being removed entirely. Secrets must not outlive the deployment.
      try {
        await purgeGenappKeyVault({ appId: p_id });
      } catch (kvErr: any) {
        logger.warn(
          `[delete_deployment_with_token] Key Vault purge failed: ${kvErr.message}`,
        );
      }
      // Delete associated logs first
      await db.query("DELETE FROM deployment_logs WHERE deployment_id = $1", [
        p_id,
      ]);
      const sql = "DELETE FROM project_deployments WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      if (deployProjectId) {
        broadcast(
          `project-${deployProjectId}-deployments`,
          "deployment_refresh",
          { projectId: deployProjectId },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_deployment_logs_with_token": {
      const { p_deployment_id, p_limit } = params;
      const sql = "SELECT * FROM deployment_logs WHERE deployment_id = $1 ORDER BY created_at DESC LIMIT $2";
      const result = await db.query(sql, [p_deployment_id, p_limit || 100]);
      return res.json({ data: result.rows, error: null });
    }

    case "increment_build_book_deploy_count": {
      const { p_build_book_id } = params;
      const sql = "UPDATE build_books SET deploy_count = deploy_count + 1, updated_at = NOW() WHERE id = $1 RETURNING deploy_count";
      const result = await db.query(sql, [p_build_book_id]);
      broadcast("build-books-realtime", "build_books_refresh", {
        buildBookId: p_build_book_id,
      });
      broadcast(`build-book-${p_build_book_id}`, "build_book_refresh", {
        buildBookId: p_build_book_id,
      });
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // DATABASE OPERATIONS
    // ============================================================

    case "insert_database_with_token": {
      const { p_project_id, p_name, p_provider, p_plan, p_region } =
        params;
      // Map provider to valid enum value (database_provider enum only has 'render_postgres')
      // 'azure_postgres' maps to 'render_postgres' internally — the schema provisioning handler ignores this field
      const dbProvider =
        p_provider === "azure_postgres" || !p_provider
          ? "render_postgres"
          : p_provider;
      // Map plan to valid enum value (database_plan enum)
      const validPlans = [
        "free",
        "basic_256mb",
        "basic_1gb",
        "basic_4gb",
        "pro_4gb",
        "pro_8gb",
      ];
      const dbPlan = validPlans.includes(p_plan) ? p_plan : "free";
      const sql = `
        INSERT INTO project_databases (project_id, name, provider, plan, region, status, created_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'pending', $6, NOW(), NOW()) RETURNING *
      `;
      const result = await db.query(sql, [
        p_project_id,
        p_name || "Database",
        dbProvider,
        dbPlan,
        p_region || "canadacentral",
        userId,
      ]);
      broadcast(`project-${p_project_id}-databases`, "database_refresh", {
        projectId: p_project_id,
      });
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "update_database_with_token": {
      const { p_id, p_name, p_status, p_dashboard_url } = params;
      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (p_name !== undefined) {
        updates.push(`name = $${idx++}`);
        values.push(p_name);
      }
      if (p_status !== undefined) {
        updates.push(`status = $${idx++}`);
        values.push(p_status);
      }
      if (p_dashboard_url !== undefined) {
        updates.push(`dashboard_url = $${idx++}`);
        values.push(p_dashboard_url);
      }
      updates.push("updated_at = NOW()");

      values.push(p_id);
      const sql = `UPDATE project_databases SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`;
      const result = await db.query(sql, values);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-databases`,
          "database_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "insert_db_connection_with_token": {
      const {
        p_project_id,
        p_name,
        p_description,
        p_connection_string,
        p_host,
        p_port,
        p_database_name,
        p_ssl_mode,
      } = params;
      // The connection STRING lives in the project's Key Vault (keyed by the
      // new connection id), never in Postgres. Insert metadata first to obtain
      // the id, then upsert the secret.
      const sql = `
        INSERT INTO project_database_connections (project_id, name, description, host, port, database_name, ssl_mode, status, created_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'untested', $8, NOW(), NOW()) RETURNING *
      `;
      const result = await db.query(sql, [
        p_project_id,
        p_name || "Connection",
        p_description,
        p_host,
        p_port || 5432,
        p_database_name,
        p_ssl_mode || "require",
        userId,
      ]);
      const insertedConn = result.rows[0];
      if (insertedConn?.id && p_connection_string) {
        try {
          await setConnectionStringSecret({
            projectId: p_project_id,
            connectionId: insertedConn.id,
            connectionString: p_connection_string,
          });
        } catch (kvErr: any) {
          logger.error(
            `[insert_db_connection_with_token] Key Vault write failed: ${kvErr.message}`,
          );
          throw kvErr;
        }
      }
      broadcast(`project-${p_project_id}-databases`, "external_db_refresh", {
        projectId: p_project_id,
      });
      return res.json({ data: insertedConn || null, error: null });
    }

    case "update_db_connection_with_token": {
      const {
        p_id,
        p_name,
        p_description,
        p_connection_string,
        p_host,
        p_port,
        p_database_name,
        p_ssl_mode,
        p_status,
      } = params;
      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (p_name !== undefined) {
        updates.push(`name = $${idx++}`);
        values.push(p_name);
      }
      if (p_description !== undefined) {
        updates.push(`description = $${idx++}`);
        values.push(p_description);
      }
      // Connection STRING is stored in the project's Key Vault, not Postgres.
      if (p_host !== undefined) {
        updates.push(`host = $${idx++}`);
        values.push(p_host);
      }
      if (p_port !== undefined) {
        updates.push(`port = $${idx++}`);
        values.push(p_port);
      }
      if (p_database_name !== undefined) {
        updates.push(`database_name = $${idx++}`);
        values.push(p_database_name);
      }
      if (p_ssl_mode !== undefined) {
        updates.push(`ssl_mode = $${idx++}`);
        values.push(p_ssl_mode);
      }
      if (p_status !== undefined) {
        updates.push(`status = $${idx++}`);
        values.push(p_status);
      }
      updates.push("updated_at = NOW()");

      values.push(p_id);
      const sql = `UPDATE project_database_connections SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`;
      const result = await db.query(sql, values);
      const updatedConn = result.rows[0];
      if (updatedConn && p_connection_string !== undefined) {
        try {
          await setConnectionStringSecret({
            projectId: updatedConn.project_id,
            connectionId: updatedConn.id,
            connectionString: p_connection_string,
          });
        } catch (kvErr: any) {
          logger.error(
            `[update_db_connection_with_token] Key Vault write failed: ${kvErr.message}`,
          );
          throw kvErr;
        }
      }
      if (updatedConn) {
        broadcast(
          `project-${updatedConn.project_id}-databases`,
          "external_db_refresh",
          { projectId: updatedConn.project_id },
        );
      }
      return res.json({ data: updatedConn || null, error: null });
    }

    case "update_db_connection_status_with_token": {
      const { p_id, p_status, p_last_error } = params;
      const sql = "UPDATE project_database_connections SET status = $2, last_error = $3, last_connected_at = CASE WHEN $2 = 'connected' THEN NOW() ELSE last_connected_at END, updated_at = NOW() WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_id, p_status, p_last_error]);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-databases`,
          "external_db_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_db_connection_with_token": {
      const { p_id, p_connection_id } = params;
      const connId = p_id || p_connection_id;
      const connLookup = await db.query(
        "SELECT project_id FROM project_database_connections WHERE id = $1",
        [connId],
      );
      const connProjectId = connLookup.rows[0]?.project_id;
      // Remove the connection string from the project's Key Vault so it does
      // not outlive the connection record (best-effort).
      if (connProjectId) {
        try {
          await deleteConnectionStringSecret({
            projectId: connProjectId,
            connectionId: connId,
          });
        } catch (kvErr: any) {
          logger.warn(
            `[delete_db_connection_with_token] Key Vault delete failed: ${kvErr.message}`,
          );
        }
      }
      const sql = "DELETE FROM project_database_connections WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [connId]);
      if (connProjectId) {
        broadcast(`project-${connProjectId}-databases`, "external_db_refresh", {
          projectId: connProjectId,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // MIGRATIONS & SAVED QUERIES
    // ============================================================

    case "get_migrations_with_token": {
      const { p_project_id, p_connection_id } = params;
      let sql = "SELECT * FROM project_migrations WHERE project_id = $1";
      const queryParams: any[] = [p_project_id];
      if (p_connection_id) {
        sql += " AND connection_id = $2";
        queryParams.push(p_connection_id);
      }
      sql += " ORDER BY sequence_number ASC";
      const result = await db.query(sql, queryParams);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_migration_with_token": {
      const {
        p_project_id,
        p_connection_id,
        p_name,
        p_sql_content,
        p_statement_type,
        p_object_type,
        p_object_name,
      } = params;
      // Get next sequence number
      const seqResult = await db.query(
        "SELECT COALESCE(MAX(sequence_number), 0) + 1 as next_seq FROM project_migrations WHERE project_id = $1",
        [p_project_id],
      );
      const nextSeq = seqResult.rows[0].next_seq;

      const sql = `
        INSERT INTO project_migrations (project_id, connection_id, sequence_number, name, sql_content, statement_type, object_type, object_name, executed_by, executed_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW()) RETURNING *
      `;
      const result = await db.query(sql, [
        p_project_id,
        p_connection_id,
        nextSeq,
        p_name,
        p_sql_content,
        p_statement_type || "DDL",
        p_object_type || "TABLE",
        p_object_name,
        userId,
      ]);
      broadcast(`project-${p_project_id}-databases`, "database_refresh", {
        projectId: p_project_id,
      });
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_migration_with_token": {
      const { p_id } = params;
      const migLookup = await db.query(
        "SELECT project_id FROM project_migrations WHERE id = $1",
        [p_id],
      );
      const migProjectId = migLookup.rows[0]?.project_id;
      const sql = "DELETE FROM project_migrations WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      if (migProjectId) {
        broadcast(`project-${migProjectId}-databases`, "database_refresh", {
          projectId: migProjectId,
        });
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_saved_queries_with_token": {
      const { p_project_id, p_connection_id } = params;
      let sql = "SELECT * FROM project_database_sql WHERE project_id = $1";
      const queryParams: any[] = [p_project_id];
      if (p_connection_id) {
        sql += " AND connection_id = $2";
        queryParams.push(p_connection_id);
      }
      sql += " ORDER BY created_at DESC";
      const result = await db.query(sql, queryParams);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_saved_query_with_token": {
      const {
        p_project_id,
        p_connection_id,
        p_name,
        p_description,
        p_sql_content,
      } = params;
      const sql = "INSERT INTO project_database_sql (project_id, connection_id, name, description, sql_content, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *";
      const result = await db.query(sql, [
        p_project_id,
        p_connection_id,
        p_name || "Query",
        p_description,
        p_sql_content,
        userId,
      ]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "update_saved_query_with_token": {
      const { p_id, p_name, p_description, p_sql_content } = params;
      const sql = "UPDATE project_database_sql SET name = COALESCE($2, name), description = COALESCE($3, description), sql_content = COALESCE($4, sql_content), updated_at = NOW() WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [
        p_id,
        p_name,
        p_description,
        p_sql_content,
      ]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_saved_query_with_token": {
      const { p_id } = params;
      const sql = "DELETE FROM project_database_sql WHERE id = $1 RETURNING id";
      const result = await db.query(sql, [p_id]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // REQUIREMENT STANDARDS LINKING
    // ============================================================

    case "get_requirement_standards_with_token": {
      const { p_requirement_id } = params;
      const sql = `
        SELECT rs.*, s.code, s.title, s.description, sc.name as category_name
        FROM requirement_standards rs
        JOIN standards s ON s.id = rs.standard_id
        LEFT JOIN standard_categories sc ON sc.id = s.category_id
        WHERE rs.requirement_id = $1
        ORDER BY s.code
      `;
      const result = await db.query(sql, [p_requirement_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "insert_requirement_standard_with_token": {
      const { p_requirement_id, p_standard_id, p_notes } = params;
      const sql = "INSERT INTO requirement_standards (requirement_id, standard_id, notes, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (requirement_id, standard_id) DO UPDATE SET notes = $3 RETURNING *";
      const result = await db.query(sql, [
        p_requirement_id,
        p_standard_id,
        p_notes,
      ]);
      // Get project_id from requirement for broadcast
      const reqStdLookup = await db.query(
        "SELECT project_id FROM requirements WHERE id = $1",
        [p_requirement_id],
      );
      const reqStdProjectId = reqStdLookup.rows[0]?.project_id;
      if (reqStdProjectId) {
        broadcast(
          `project-${reqStdProjectId}-requirements`,
          "requirements_refresh",
          { projectId: reqStdProjectId },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "delete_requirement_standard_with_token": {
      const { p_requirement_id, p_standard_id } = params;
      // Get project_id from requirement for broadcast
      const reqStdDelLookup = await db.query(
        "SELECT project_id FROM requirements WHERE id = $1",
        [p_requirement_id],
      );
      const reqStdDelProjectId = reqStdDelLookup.rows[0]?.project_id;
      const sql = "DELETE FROM requirement_standards WHERE requirement_id = $1 AND standard_id = $2 RETURNING id";
      const result = await db.query(sql, [p_requirement_id, p_standard_id]);
      if (reqStdDelProjectId) {
        broadcast(
          `project-${reqStdDelProjectId}-requirements`,
          "requirements_refresh",
          { projectId: reqStdDelProjectId },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // ARTIFACTS (Extended)
    // ============================================================

    case "rename_artifact_folder_with_token": {
      const { p_artifact_id, p_new_name } = params;
      const sql = "UPDATE artifacts SET ai_title = $2, updated_at = NOW() WHERE id = $1 AND is_folder = true RETURNING *";
      const result = await db.query(sql, [p_artifact_id, p_new_name]);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-artifacts`,
          "artifact_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // PROJECT SHARING (Extended)
    // ============================================================

    case "save_anonymous_project_to_user": {
      const { p_project_id } = params;
      if (!userId) {
        return res.json({ data: null, error: "User not authenticated" });
      }
      // Update project's created_by to current user
      const sql = "UPDATE projects SET created_by = $2, updated_at = NOW() WHERE id = $1 AND created_by IS NULL RETURNING *";
      const result = await db.query(sql, [p_project_id, userId]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "toggle_published_project_visibility": {
      const { p_project_id } = params;
      const sql = "UPDATE published_projects SET is_visible = NOT is_visible, updated_at = NOW() WHERE project_id = $1 RETURNING *";
      const result = await db.query(sql, [p_project_id]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "unlink_shared_project": {
      const { p_project_id } = params;
      if (!userId) {
        return res.json({ data: null, error: "User not authenticated" });
      }
      const sql = "DELETE FROM profile_linked_projects WHERE user_id = $1 AND project_id = $2 RETURNING id";
      const result = await db.query(sql, [userId, p_project_id]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_project_deletion_counts": {
      const { p_project_id } = params;
      const counts: Record<string, number> = {};

      const tables = [
        { name: "artifacts", column: "project_id" },
        { name: "requirements", column: "project_id" },
        { name: "chat_sessions", column: "project_id" },
        { name: "canvas_nodes", column: "project_id" },
        { name: "project_repos", column: "project_id" },
        { name: "project_deployments", column: "project_id" },
        { name: "audit_sessions", column: "project_id" },
      ];

      for (const table of tables) {
        const result = await db.query(
          `SELECT COUNT(*) as count FROM ${table.name} WHERE ${table.column} = $1`,
          [p_project_id],
        );
        counts[table.name] = parseInt(result.rows[0].count, 10);
      }

      return res.json({ data: counts, error: null });
    }

    // ============================================================
    // GALLERY & PROJECT CLONING
    // ============================================================

    case "publish_project_to_gallery": {
      const {
        p_project_id,
        p_name,
        p_description,
        p_image_url,
        p_tags,
        p_category,
      } = params;
      // Check if already published
      const existingResult = await db.query(
        "SELECT id FROM published_projects WHERE project_id = $1",
        [p_project_id],
      );
      if (existingResult.rows.length > 0) {
        // Update existing
        const sql = "UPDATE published_projects SET name = $2, description = $3, image_url = $4, tags = $5, category = $6, updated_at = NOW() WHERE project_id = $1 RETURNING *";
        const result = await db.query(sql, [
          p_project_id,
          p_name,
          p_description,
          p_image_url,
          p_tags || [],
          p_category,
        ]);
        return res.json({ data: result.rows[0] || null, error: null });
      } else {
        // Insert new
        const sql = "INSERT INTO published_projects (project_id, name, description, image_url, tags, category, published_by, published_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING *";
        const result = await db.query(sql, [
          p_project_id,
          p_name,
          p_description,
          p_image_url,
          p_tags || [],
          p_category,
          userId,
        ]);
        return res.json({ data: result.rows[0] || null, error: null });
      }
    }

    case "clone_published_project": {
      const {
        p_published_project_id,
        p_new_name,
        p_clone_requirements,
        p_clone_artifacts,
        p_clone_canvas,
        p_clone_standards,
        p_clone_tech_stacks,
      } = params;
      const client = await db.getClient();
      try {
        await client.query("BEGIN");

        // Get published project
        const pubResult = await client.query(
          "SELECT pp.*, p.* FROM published_projects pp JOIN projects p ON p.id = pp.project_id WHERE pp.id = $1",
          [p_published_project_id],
        );
        if (pubResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.json({ data: null, error: "Published project not found" });
        }
        const original = pubResult.rows[0];
        const originalProjectId = original.project_id;

        // Create new project
        const newProjectResult = await client.query(
          `INSERT INTO projects (name, description, organization, budget, scope, status, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING id`,
          [
            p_new_name || `Clone of ${original.name}`,
            original.description,
            original.organization,
            original.budget,
            original.scope,
            "DESIGN",
            userId,
          ],
        );
        const newProjectId = newProjectResult.rows[0].id;

        // Create owner token
        await client.query(
          "INSERT INTO project_tokens (project_id, role, label, created_by, created_at) VALUES ($1, 'owner', 'Default Owner Token', $2, NOW())",
          [newProjectId, userId],
        );

        // Clone requirements
        if (p_clone_requirements !== false) {
          await client.query(
            `INSERT INTO requirements (project_id, parent_id, type, title, content, order_index, code, created_at, updated_at)
             SELECT $1, parent_id, type, title, content, order_index, code, NOW(), NOW() FROM requirements WHERE project_id = $2`,
            [newProjectId, originalProjectId],
          );
        }

        // Clone artifacts
        if (p_clone_artifacts !== false) {
          const sourceArts = await client.query(
            "SELECT id, project_id, ai_title, ai_summary, source_type, image_url, parent_id, is_folder, content_length FROM artifacts WHERE project_id = $1 ORDER BY created_at",
            [originalProjectId],
          );
          for (const a of sourceArts.rows) {
            const insertRes = await client.query(
              `INSERT INTO artifacts (project_id, ai_title, ai_summary, source_type, image_url, parent_id, is_folder, content_length, created_by, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW()) RETURNING id`,
              [
                newProjectId,
                a.ai_title,
                a.ai_summary,
                a.source_type,
                a.image_url,
                a.parent_id,
                a.is_folder,
                a.content_length,
                userId,
              ],
            );
            const newArtId = insertRes.rows[0]?.id;
            if (newArtId && !a.is_folder) {
              await cloneArtifactContent(
                originalProjectId,
                a.id,
                newProjectId,
                newArtId,
              );
            }
          }
        }

        // Clone canvas nodes
        if (p_clone_canvas !== false) {
          await client.query(
            `INSERT INTO canvas_nodes (project_id, type, position, data, created_at, updated_at)
             SELECT $1, type, position, data, NOW(), NOW() FROM canvas_nodes WHERE project_id = $2`,
            [newProjectId, originalProjectId],
          );
        }

        // Clone standards
        if (p_clone_standards !== false) {
          await client.query(
            `INSERT INTO project_standards (project_id, standard_id, created_at)
             SELECT $1, standard_id, NOW() FROM project_standards WHERE project_id = $2`,
            [newProjectId, originalProjectId],
          );
        }

        // Clone tech stacks
        if (p_clone_tech_stacks !== false) {
          await client.query(
            `INSERT INTO project_tech_stacks (project_id, tech_stack_id, created_at)
             SELECT $1, tech_stack_id, NOW() FROM project_tech_stacks WHERE project_id = $2`,
            [newProjectId, originalProjectId],
          );
        }

        // Increment clone count
        await client.query(
          "UPDATE published_projects SET clone_count = clone_count + 1 WHERE id = $1",
          [p_published_project_id],
        );

        await client.query("COMMIT");

        // Get new project to return
        const newProject = await db.query(
          "SELECT * FROM projects WHERE id = $1",
          [newProjectId],
        );
        return res.json({ data: newProject.rows[0] || null, error: null });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    case "link_shared_project": {
      const { p_token } = params;
      if (!userId || !p_token) {
        return res.json({
          data: null,
          error: "User not authenticated or token missing",
        });
      }
      // Get project_id from token
      const tokenResult = await db.query(
        "SELECT project_id FROM project_tokens WHERE token = $1 AND (expires_at IS NULL OR expires_at > NOW())",
        [p_token],
      );
      if (tokenResult.rows.length === 0) {
        return res.json({ data: null, error: "Invalid or expired token" });
      }
      const projectId = tokenResult.rows[0].project_id;
      // Link project to user
      const sql = "INSERT INTO profile_linked_projects (user_id, project_id, token, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, project_id) DO UPDATE SET token = $3 RETURNING *";
      const result = await db.query(sql, [userId, projectId, p_token]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // TESTING LOGS
    // ============================================================

    case "get_testing_logs_with_token": {
      const { p_project_id, p_deployment_id, p_is_resolved } = params;
      let sql = "SELECT * FROM project_testing_logs WHERE project_id = $1";
      const queryParams: any[] = [p_project_id];
      let idx = 2;

      if (p_deployment_id) {
        sql += ` AND deployment_id = $${idx++}`;
        queryParams.push(p_deployment_id);
      }
      if (p_is_resolved !== undefined) {
        sql += ` AND is_resolved = $${idx++}`;
        queryParams.push(p_is_resolved);
      }
      sql += " ORDER BY created_at DESC";
      const result = await db.query(sql, queryParams);
      return res.json({ data: result.rows, error: null });
    }

    case "resolve_testing_log_with_token": {
      const { p_id } = params;
      const sql = "UPDATE project_testing_logs SET is_resolved = true, resolved_at = NOW(), resolved_by = $2 WHERE id = $1 RETURNING *";
      const result = await db.query(sql, [p_id, userId]);
      if (result.rows[0]) {
        broadcast(
          `project-${result.rows[0].project_id}-testing`,
          "testing_log_refresh",
          { projectId: result.rows[0].project_id },
        );
      }
      return res.json({ data: result.rows[0] || null, error: null });
    }

    // ============================================================
    // COLLABORATION MERGE
    // ============================================================

    case "merge_collaboration_to_artifact_with_token": {
      const { p_collaboration_id, p_keep_session_active } = params;
      const client = await db.getClient();
      try {
        await client.query("BEGIN");

        // Get collaboration
        const collabResult = await client.query(
          "SELECT * FROM artifact_collaborations WHERE id = $1",
          [p_collaboration_id],
        );
        if (collabResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.json({ data: null, error: "Collaboration not found" });
        }
        const collab = collabResult.rows[0];

        // Read current collaboration content from blob storage
        const collabContent = await getRepoBlobStore().readCollabCurrent(
          collab.project_id,
          p_collaboration_id,
        );

        // Write merged content to artifact blob and update metadata
        if (collabContent !== null) {
          const { contentLength } = await putArtifactContent(
            collab.project_id,
            collab.artifact_id,
            collabContent,
          );
          await client.query(
            "UPDATE artifacts SET content_length = $2, updated_at = NOW() WHERE id = $1",
            [collab.artifact_id, contentLength],
          );
        }

        // Update collaboration status
        if (!p_keep_session_active) {
          await client.query(
            "UPDATE artifact_collaborations SET status = 'merged', merged_at = NOW(), merged_to_artifact = true, updated_at = NOW() WHERE id = $1",
            [p_collaboration_id],
          );
        }

        await client.query("COMMIT");

        // Broadcast artifact update and collaboration update
        broadcast(`collaboration-${p_collaboration_id}`, "collaboration_edit", {
          collaborationId: p_collaboration_id,
        });
        // Also notify artifact channel
        const mergeArtLookup = await db.query(
          "SELECT project_id FROM artifacts WHERE id = $1",
          [collab.artifact_id],
        );
        const mergeProjectId = mergeArtLookup.rows[0]?.project_id;
        if (mergeProjectId) {
          broadcast(`project-${mergeProjectId}-artifacts`, "artifact_refresh", {
            projectId: mergeProjectId,
          });
        }

        // Return updated artifact
        const artifactResult = await db.query(
          "SELECT * FROM artifacts WHERE id = $1",
          [collab.artifact_id],
        );
        return res.json({ data: artifactResult.rows[0] || null, error: null });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    // ============================================================
    // GLOBAL LIBRARY: STANDARDS, TECH STACKS, BUILD BOOKS
    // ============================================================

    case "get_standard_categories": {
      const sql = "SELECT * FROM standard_categories ORDER BY name";
      const result = await db.query(sql);
      return res.json({ data: result.rows, error: null });
    }

    case "get_standards_with_attachments": {
      const sql = `
        SELECT 
          s.*,
          COALESCE(
            json_agg(
              json_build_object(
                'id', sa.id,
                'type', sa.type,
                'name', sa.name,
                'url', sa.url,
                'description', sa.description
              )
            ) FILTER (WHERE sa.id IS NOT NULL),
            '[]'
          ) as attachments
        FROM standards s
        LEFT JOIN standard_attachments sa ON sa.standard_id = s.id
        GROUP BY s.id
        ORDER BY s.code
      `;
      const result = await db.query(sql);
      return res.json({ data: result.rows, error: null });
    }

    case "get_tech_stacks_root": {
      const sql = "SELECT * FROM tech_stacks WHERE parent_id IS NULL AND type IS NULL ORDER BY name";
      const result = await db.query(sql);
      return res.json({ data: result.rows, error: null });
    }

    case "get_build_books": {
      const sql = "SELECT * FROM build_books ORDER BY updated_at DESC";
      const result = await db.query(sql);
      return res.json({ data: result.rows, error: null });
    }

    case "get_build_book_by_id": {
      const { p_id } = params;
      const sql = "SELECT * FROM build_books WHERE id = $1";
      const result = await db.query(sql, [p_id]);
      return res.json({ data: result.rows[0] || null, error: null });
    }

    case "get_build_book_standards": {
      const { p_build_book_id } = params;
      const sql = "SELECT * FROM build_book_standards WHERE build_book_id = $1";
      const result = await db.query(sql, [p_build_book_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "get_build_book_tech_stacks": {
      const { p_build_book_id } = params;
      const sql = "SELECT * FROM build_book_tech_stacks WHERE build_book_id = $1";
      const result = await db.query(sql, [p_build_book_id]);
      return res.json({ data: result.rows, error: null });
    }

    case "create_artifact_collaboration_with_token": {
      const { p_artifact_id, p_project_id } = params;
      // Call the DB function to create the collaboration row
      const paramNames = Object.keys(params);
      const paramValues = Object.values(params);
      const placeholders = paramNames.map((_, i) => `$${i + 1}`).join(", ");
      const createResult = await db.query(
        `SELECT * FROM create_artifact_collaboration_with_token(${placeholders})`,
        paramValues,
      );
      const collab = createResult.rows[0];
      if (collab) {
        // Fetch the artifact's content from blob as the initial document content
        const initialContent =
          (await getArtifactContent(p_project_id, p_artifact_id)) || "";
        // Write initial content to collaboration blob storage
        await getRepoBlobStore().writeCollabCurrent(
          p_project_id,
          collab.id,
          initialContent,
        );
        await getRepoBlobStore().writeCollabBase(
          p_project_id,
          collab.id,
          initialContent,
        );
      }
      return res.json({ data: collab || null, error: null });
    }

    // ============================================================
    // DEFAULT: Try to call a real PostgreSQL function
    // ============================================================

    default: {
      // Try to call as actual PostgreSQL function
      try {
        const paramNames = Object.keys(params);
        const paramValues = Object.values(params);
        const placeholders = paramNames.map((_, i) => `$${i + 1}`).join(", ");
        const sql =
          paramNames.length > 0
            ? `SELECT * FROM ${functionName}(${placeholders})`
            : `SELECT * FROM ${functionName}()`;

        logger.info(`Calling PostgreSQL function: ${functionName}`);
        const result = await db.query(sql, paramValues);
        return res.json({ data: result.rows, error: null });
      } catch (error: any) {
        logger.warn(`Unknown RPC function: ${functionName}`, {
          error: error.message,
        });
        throw Errors.notFound(`Function '${functionName}' not found`);
      }
    }
  }
});

export default router;

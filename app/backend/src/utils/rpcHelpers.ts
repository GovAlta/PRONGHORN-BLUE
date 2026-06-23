/**
 * RPC Helper - Inline SQL
 * =============================================================================
 * Replaces `SELECT * FROM function_with_token(...)` PostgreSQL function calls
 * with direct SQL queries, since Azure PostgreSQL doesn't have these functions.
 * =============================================================================
 */
import db from "./database";
import { logger } from "./logger";
import { getRepoBlobStore } from "./repoBlobStore";
import {
  getStagedContent,
  putStagedFile,
  computeContentMeta,
} from "../staging/stagedContentStore";
import { putArtifactContent, cloneArtifactContent } from "../staging/artifactContentStore";
import { StagingOpType, assertNeverStagingOp } from "../staging/stagingTypes";

export interface BatchStageFileInput {
  filePath: string;
  operationType: string;
  newContent?: string | null;
  oldPath?: string | null;
}

/**
 * Get project by ID, optionally validating a share token
 */
export async function getProjectWithToken(
  projectId: string,
  token?: string | null,
) {
  if (token) {
    const result = await db.query(
      `SELECT p.* FROM projects p
       JOIN project_tokens pt ON pt.project_id = p.id
       WHERE p.id = $1 AND pt.token = $2 AND (pt.expires_at IS NULL OR pt.expires_at > NOW())`,
      [projectId, token],
    );
    if (result.rows.length > 0) {
      await db.query(
        "UPDATE project_tokens SET last_used_at = NOW() WHERE token = $1",
        [token],
      );
    }
    return result.rows[0] || null;
  }
  const result = await db.query("SELECT * FROM projects WHERE id = $1", [
    projectId,
  ]);
  return result.rows[0] || null;
}

/**
 * Get project repos
 */
export async function getProjectReposWithToken(
  projectId: string,
  _token?: string | null,
) {
  const result = await db.query(
    "SELECT * FROM project_repos WHERE project_id = $1 ORDER BY is_prime DESC, created_at DESC",
    [projectId],
  );
  return result.rows;
}

/**
 * Get database by ID
 */
export async function getDatabaseWithToken(
  databaseId: string,
  _token?: string | null,
) {
  const result = await db.query(
    "SELECT * FROM project_databases WHERE id = $1",
    [databaseId],
  );
  return result.rows[0] || null;
}

/**
 * Get deployment with secrets
 */
export async function getDeploymentWithSecretsWithToken(
  deploymentId: string,
  _token?: string | null,
) {
  const result = await db.query(
    "SELECT * FROM project_deployments WHERE id = $1",
    [deploymentId],
  );
  return result.rows[0] || null;
}

/**
 * Get repo by ID
 */
export async function getRepoByIdWithToken(
  repoId: string,
  _token?: string | null,
) {
  const result = await db.query("SELECT * FROM project_repos WHERE id = $1", [
    repoId,
  ]);
  return result.rows[0] || null;
}

/**
 * Get requirements for a project
 */
export async function getRequirementsWithToken(
  projectId: string,
  _token?: string | null,
) {
  const result = await db.query(
    "SELECT * FROM requirements WHERE project_id = $1 ORDER BY order_index ASC",
    [projectId],
  );
  return result.rows;
}

/**
 * Get requirement standards (linked standards for a requirement)
 */
export async function getRequirementStandardsWithToken(
  requirementId: string,
  _token?: string | null,
) {
  const result = await db.query(
    `SELECT rs.*, s.code, s.title, s.description, sc.name as category_name
     FROM requirement_standards rs
     JOIN standards s ON s.id = rs.standard_id
     LEFT JOIN standard_categories sc ON sc.id = s.category_id
     WHERE rs.requirement_id = $1
     ORDER BY s.code`,
    [requirementId],
  );
  return result.rows;
}

/**
 * Insert requirement
 */
export async function insertRequirementWithToken(
  projectId: string,
  _token: string | null,
  parentId: string | null,
  type: string,
  title: string,
) {
  const orderSql = parentId
    ? "SELECT COALESCE(MAX(order_index), -1) + 1 as next_order FROM requirements WHERE project_id = $1 AND parent_id = $2"
    : "SELECT COALESCE(MAX(order_index), -1) + 1 as next_order FROM requirements WHERE project_id = $1 AND parent_id IS NULL";
  const orderResult = await db.query(
    orderSql,
    parentId ? [projectId, parentId] : [projectId],
  );
  const nextOrder = orderResult.rows[0]?.next_order || 0;

  const result = await db.query(
    `INSERT INTO requirements (project_id, parent_id, type, title, order_index, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING *`,
    [projectId, parentId || null, type, title, nextOrder],
  );
  return result.rows[0] || null;
}

/**
 * Update requirement
 */
export async function updateRequirementWithToken(
  id: string,
  _token: string | null,
  title?: string,
  content?: string,
) {
  const result = await db.query(
    `UPDATE requirements SET title = COALESCE($2, title), content = COALESCE($3, content), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, title || null, content || null],
  );
  return result.rows[0] || null;
}

/**
 * Get staged file metadata and blob content.
 *
 * The `new_content` column is always NULL post-blob-refactor; content lives in
 * Azure Blob.  This function augments the metadata row with a `content` field
 * read from blob so callers do not need to know the storage backend.
 *
 * @example
 * const sf = await getStagedFileWithToken('repo-1', 'src/app.ts');
 * if (sf) console.log(sf.content); // blob bytes, not new_content
 */
export async function getStagedFileWithToken(
  repoId: string,
  filePath: string,
  _token?: string | null,
) {
  const result = await db.query(
    "SELECT * FROM repo_staging WHERE repo_id = $1 AND file_path = $2",
    [repoId, filePath],
  );
  const row = result.rows[0] || null;
  if (!row) return null;

  // Fetch blob content so callers get real bytes instead of the always-null new_content column
  const staged = await getStagedContent(repoId, filePath);
  return { ...row, content: staged?.content ?? null };
}

/**
 * Get repo file by path
 */
export async function getRepoFileByPathWithToken(
  repoId: string,
  filePath: string,
  _token?: string | null,
) {
  const result = await db.query(
    "SELECT * FROM repo_files WHERE repo_id = $1 AND path = $2",
    [repoId, filePath],
  );
  return result.rows[0] || null;
}

/**
 * Get committed file content by repo and path for diff baselines.
 *
 * @example
 * await getFileContentByPathWithToken('repo-id', 'src/app.ts')
 */
export async function getFileContentByPathWithToken(
  repoId: string,
  filePath: string,
  _token?: string | null,
) {
  if (!repoId) {
    throw new Error("repoId is required");
  }

  if (!filePath) {
    throw new Error("filePath is required");
  }

  // Delegate to StagedContentStore facade — no new_content fallback (always null post-refactor)
  const stagedContent = await getStagedContent(repoId, filePath);
  if (stagedContent !== null) {
    return {
      content: stagedContent.content,
      is_binary: stagedContent.isBinary,
      content_length: stagedContent.contentLength,
    };
  }

  // Resolve project_id for blob container name
  const repoLookup = await db.query(
    "SELECT project_id FROM project_repos WHERE id = $1",
    [repoId],
  );
  const projectId = repoLookup.rows[0]?.project_id;
  if (!projectId) return null;

  // Fallback to committed blob storage
  const committedContent = await getRepoBlobStore().readCommitted(
    projectId,
    repoId,
    filePath,
  );
  if (committedContent !== null) {
    return {
      content: committedContent,
      is_binary: false,
      content_length: committedContent.length,
    };
  }

  return null;
}

/**
 * Get repo files - optionally filtered by file paths array
 */
export async function getRepoFilesWithToken(
  repoId: string,
  _token?: string | null,
  filePaths?: string[] | null,
) {
  const columns =
    "id, repo_id, project_id, path, is_binary, content_length, last_commit_sha, created_at, updated_at";
  if (filePaths && filePaths.length > 0) {
    const result = await db.query(
      `SELECT ${columns} FROM repo_files WHERE repo_id = $1 AND path = ANY($2) ORDER BY path`,
      [repoId, filePaths],
    );
    return result.rows;
  }
  const result = await db.query(
    `SELECT ${columns} FROM repo_files WHERE repo_id = $1 ORDER BY path`,
    [repoId],
  );
  return result.rows;
}

/**
 * Get staged changes for a repo
 */
export async function getStagedChangesWithToken(
  repoId: string,
  _token?: string | null,
) {
  const result = await db.query(
    "SELECT * FROM repo_staging WHERE repo_id = $1 ORDER BY created_at",
    [repoId],
  );
  return result.rows;
}

/**
 * Get canvas nodes for a project
 */
export async function getCanvasNodesWithToken(
  projectId: string,
  _token?: string | null,
) {
  const result = await db.query(
    "SELECT * FROM canvas_nodes WHERE project_id = $1 ORDER BY created_at ASC",
    [projectId],
  );
  return result.rows;
}

/**
 * Get canvas edges for a project
 */
export async function getCanvasEdgesWithToken(
  projectId: string,
  _token?: string | null,
) {
  const result = await db.query(
    "SELECT * FROM canvas_edges WHERE project_id = $1 ORDER BY created_at ASC",
    [projectId],
  );
  return result.rows;
}

/**
 * Create project repo
 */
export async function createProjectRepoWithToken(
  projectId: string,
  _token: string | null,
  organization: string,
  repo: string,
  branch: string,
  isDefault: boolean,
  isPrime: boolean,
) {
  const result = await db.query(
    `INSERT INTO project_repos (project_id, organization, repo, branch, is_default, is_prime, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (project_id, organization, repo) DO UPDATE SET
       branch = EXCLUDED.branch, is_default = EXCLUDED.is_default, is_prime = EXCLUDED.is_prime, updated_at = NOW()
     RETURNING *`,
    [projectId, organization, repo, branch, isDefault, isPrime],
  );
  return result.rows[0] || null;
}

/**
 * Clone project - creates a deep copy of a project with selected components
 */
export async function cloneProjectWithToken(
  sourceProjectId: string,
  token: string | null,
  newName: string,
  cloneChat = false,
  cloneArtifacts = false,
  cloneRequirements = true,
  cloneStandards = true,
  cloneSpecifications = false,
  cloneCanvas = true,
  cloneRepoFiles = false,
  cloneRepoStaging = false,
) {
  // Get source project
  const source = await getProjectWithToken(sourceProjectId, token);
  if (!source) throw new Error("Source project not found or access denied");

  // Create new project
  const newProject = await db.query(
    `INSERT INTO projects (name, description, status, org_id, selected_model, max_tokens, thinking_enabled, thinking_budget, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW()) RETURNING *`,
    [
      newName,
      source.description,
      source.status,
      source.org_id,
      source.selected_model,
      source.max_tokens,
      source.thinking_enabled,
      source.thinking_budget,
    ],
  );
  const newProjectId = newProject.rows[0].id;

  // Create owner token for the new project
  const tokenResult = await db.query(
    "INSERT INTO project_tokens (project_id, role, label, created_at) VALUES ($1, 'owner', 'Default Owner', NOW()) RETURNING token",
    [newProjectId],
  );
  const newToken = tokenResult.rows[0].token;

  // Clone requirements
  if (cloneRequirements) {
    const reqs = await db.query(
      "SELECT * FROM requirements WHERE project_id = $1 ORDER BY order_index",
      [sourceProjectId],
    );
    const idMap = new Map<string, string>();
    for (const r of reqs.rows) {
      const newReq = await db.query(
        `INSERT INTO requirements (project_id, parent_id, type, title, content, order_index, code, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING id`,
        [
          newProjectId,
          r.parent_id ? idMap.get(r.parent_id) || null : null,
          r.type,
          r.title,
          r.content,
          r.order_index,
          r.code,
        ],
      );
      idMap.set(r.id, newReq.rows[0].id);
    }
  }

  // Clone standards links
  if (cloneStandards) {
    const stds = await db.query(
      "SELECT * FROM project_standards WHERE project_id = $1",
      [sourceProjectId],
    );
    for (const s of stds.rows) {
      await db.query(
        "INSERT INTO project_standards (project_id, standard_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING",
        [newProjectId, s.standard_id],
      );
    }
    const tss = await db.query(
      "SELECT * FROM project_tech_stacks WHERE project_id = $1",
      [sourceProjectId],
    );
    for (const t of tss.rows) {
      await db.query(
        "INSERT INTO project_tech_stacks (project_id, tech_stack_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING",
        [newProjectId, t.tech_stack_id],
      );
    }
  }

  // Clone canvas
  if (cloneCanvas) {
    const nodes = await db.query(
      "SELECT * FROM canvas_nodes WHERE project_id = $1",
      [sourceProjectId],
    );
    const nodeIdMap = new Map<string, string>();
    for (const n of nodes.rows) {
      const newNode = await db.query(
        `INSERT INTO canvas_nodes (project_id, type, position, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id`,
        [newProjectId, n.type, n.position, n.data],
      );
      nodeIdMap.set(n.id, newNode.rows[0].id);
    }
    const edges = await db.query(
      "SELECT * FROM canvas_edges WHERE project_id = $1",
      [sourceProjectId],
    );
    for (const e of edges.rows) {
      const newSource = nodeIdMap.get(e.source) || nodeIdMap.get(e.source_id);
      const newTarget = nodeIdMap.get(e.target) || nodeIdMap.get(e.target_id);
      if (newSource && newTarget) {
        await db.query(
          `INSERT INTO canvas_edges (project_id, source, target, label, edge_type, style, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
          [newProjectId, newSource, newTarget, e.label, e.edge_type, e.style],
        );
      }
    }
  }

  // Clone artifacts
  if (cloneArtifacts) {
    const arts = await db.query(
      "SELECT id, project_id, ai_title, ai_summary, source_type, content_length, is_folder FROM artifacts WHERE project_id = $1 ORDER BY created_at",
      [sourceProjectId],
    );
    for (const a of arts.rows) {
      const insertRes = await db.query(
        `INSERT INTO artifacts (project_id, ai_title, ai_summary, source_type, content_length, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING id`,
        [
          newProjectId,
          a.ai_title,
          a.ai_summary,
          a.source_type,
          a.content_length,
        ],
      );
      const newArtId = insertRes.rows[0]?.id;
      if (newArtId && !a.is_folder) {
        await cloneArtifactContent(
          sourceProjectId,
          a.id,
          newProjectId,
          newArtId,
        );
      }
    }
  }

  // Clone specifications
  if (cloneSpecifications) {
    const specs = await db.query(
      "SELECT * FROM project_specifications WHERE project_id = $1",
      [sourceProjectId],
    );
    for (const s of specs.rows) {
      await db.query(
        `INSERT INTO project_specifications (project_id, generated_spec, raw_data, agent_id, agent_title, version, is_latest, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
        [
          newProjectId,
          s.generated_spec,
          s.raw_data,
          s.agent_id,
          s.agent_title,
          s.version,
          s.is_latest,
        ],
      );
    }
  }

  return { id: newProjectId, share_token: newToken };
}

/**
 * Get project inventory — returns counts of various project resources
 */
export async function getProjectInventoryWithToken(
  projectId: string,
  _token?: string | null,
) {
  const counts = await db.query(
    `
    SELECT
      (SELECT COUNT(*) FROM requirements WHERE project_id = $1)::int as requirements_count,
      (SELECT COUNT(*) FROM canvas_nodes WHERE project_id = $1)::int as canvas_nodes_count,
      (SELECT COUNT(*) FROM canvas_edges WHERE project_id = $1)::int as canvas_edges_count,
      (SELECT COUNT(*) FROM artifacts WHERE project_id = $1)::int as artifacts_count,
      (SELECT COUNT(*) FROM project_repos WHERE project_id = $1)::int as repos_count,
      (SELECT COUNT(*) FROM project_specifications WHERE project_id = $1)::int as specifications_count,
      (SELECT COUNT(*) FROM project_standards WHERE project_id = $1)::int as standards_count,
      (SELECT COUNT(*) FROM project_tech_stacks WHERE project_id = $1)::int as tech_stacks_count,
      (SELECT COUNT(*) FROM project_databases WHERE project_id = $1)::int as databases_count,
      (SELECT COUNT(*) FROM project_deployments WHERE project_id = $1)::int as deployments_count,
      (SELECT COUNT(*) FROM chat_sessions WHERE project_id = $1)::int as chat_sessions_count
  `,
    [projectId],
  );
  return counts.rows[0] || {};
}

export async function getProjectCategoryWithToken(
  projectId: string,
  category: string,
  _token?: string | null,
) {
  const categoryQueries: Record<string, string> = {
    requirements: "SELECT id, code, title, content, type, parent_id, order_index FROM requirements WHERE project_id = $1 ORDER BY order_index",
    artifacts: "SELECT id, ai_title, ai_summary, source_type, content_length FROM artifacts WHERE project_id = $1 ORDER BY created_at DESC",
    standards: "SELECT ps.id, s.code, s.title, s.description, s.content, s.long_description FROM project_standards ps JOIN standards s ON s.id = ps.standard_id WHERE ps.project_id = $1",
    tech_stacks: "SELECT pt.id, t.name, t.type, t.version, t.description, t.long_description FROM project_tech_stacks pt JOIN tech_stacks t ON t.id = pt.tech_stack_id WHERE pt.project_id = $1",
    canvas_nodes: "SELECT id, type, position, data, layer_id FROM canvas_nodes WHERE project_id = $1",
    canvas_edges: "SELECT id, source, target, source_handle, target_handle, type, label, data FROM canvas_edges WHERE project_id = $1",
    specifications: "SELECT id, agent_type, title, content, version FROM project_specifications WHERE project_id = $1 ORDER BY version DESC",
    repos: "SELECT id, organization, repo, branch, is_prime, is_default FROM project_repos WHERE project_id = $1",
    chat_sessions: "SELECT id, title, ai_title, ai_summary, created_at FROM chat_sessions WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 20",
    databases: "SELECT id, name, type, status FROM project_databases WHERE project_id = $1",
    deployments: "SELECT id, name, status, url, provider FROM project_deployments WHERE project_id = $1",
  };

  const sql = categoryQueries[category];
  if (!sql) return [];
  const result = await db.query(sql, [projectId]);
  return result.rows;
}

export async function getProjectElementsWithToken(
  projectId: string,
  elements: Array<{ category: string; id: string }>,
  _token?: string | null,
) {
  const results: any[] = [];
  const tableMap: Record<string, string> = {
    requirements: "requirements",
    artifacts: "artifacts",
    canvas_nodes: "canvas_nodes",
    canvas_edges: "canvas_edges",
    specifications: "project_specifications",
    repos: "project_repos",
    chat_sessions: "chat_sessions",
    databases: "project_databases",
    deployments: "project_deployments",
  };

  for (const el of elements) {
    const table = tableMap[el.category];
    if (!table) continue;
    try {
      const result = await db.query(
        `SELECT * FROM ${table} WHERE id = $1 AND project_id = $2`,
        [el.id, projectId],
      );
      if (result.rows[0])
        results.push({ ...result.rows[0], _category: el.category });
    } catch {}
  }
  return results;
}

// =============================================================================
// Authorization & Role Helpers
// =============================================================================

/**
 * Authorize project access — returns role ('owner', 'editor', 'viewer') or throws
 */
export async function authorizeProjectAccess(
  projectId: string,
  token?: string | null,
): Promise<string> {
  // Check token-based access
  if (token) {
    const result = await db.query(
      "SELECT role FROM project_tokens WHERE project_id = $1 AND token = $2 AND (expires_at IS NULL OR expires_at > NOW())",
      [projectId, token],
    );
    if (result.rows.length > 0) return result.rows[0].role;
  }
  // Fallback: allow if project exists (no auth enforcement in Azure — handled by MSAL)
  const proj = await db.query("SELECT id FROM projects WHERE id = $1", [
    projectId,
  ]);
  if (proj.rows.length > 0) return "owner";
  throw new Error("Access denied");
}

/**
 * Require a minimum role level
 */
export async function requireRole(
  projectId: string,
  token: string | null,
  minRole: string,
): Promise<string> {
  const role = await authorizeProjectAccess(projectId, token);
  const levels: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
  if ((levels[role] || 0) < (levels[minRole] || 0)) {
    throw new Error("Insufficient permissions");
  }
  return role;
}

/**
 * Validate project access — returns boolean
 */
export async function validateProjectAccess(
  projectId: string,
  token?: string | null,
): Promise<boolean> {
  try {
    await authorizeProjectAccess(projectId, token);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Project Management Helpers
// =============================================================================

/**
 * Delete project and all associated data
 */
export async function deleteProjectWithToken(
  projectId: string,
  _token?: string | null,
) {
  // Cascade delete — order matters for foreign key constraints
  const tables = [
    "audit_activity_stream",
    "audit_blackboard",
    "audit_graph_edges",
    "audit_graph_nodes",
    "audit_tesseract_cells",
    "audit_sessions",
    "agent_file_operations",
    "agent_llm_logs",
    "agent_messages",
    "agent_blackboard",
    "agent_session_context",
    "agent_sessions",
    "artifact_collaboration_history",
    "artifact_collaboration_messages",
    "artifact_collaboration_blackboard",
    "artifact_collaborations",
    "build_sessions",
    "deployment_issues",
    "deployment_logs",
    "chat_messages",
    "chat_sessions",
    "canvas_edges",
    "canvas_layers",
    "canvas_nodes",
    "repo_staging",
    "repo_commits",
    "repo_files",
    "repo_pats",
    "project_repos",
    "requirement_standards",
    "requirements",
    "project_database_sql",
    "project_migrations",
    "project_database_connections",
    "project_databases",
    "project_deployments",
    "project_specifications",
    "project_presentations",
    "project_standards",
    "project_tech_stacks",
    "project_testing_logs",
    "profile_linked_projects",
    "project_tokens",
    "activity_logs",
    "artifacts",
    "published_projects",
  ];
  for (const table of tables) {
    try {
      await db.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]);
    } catch {
      /* table might not have project_id column — skip */
    }
  }
  await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
  return true;
}

// =============================================================================
// Database Connection Helpers
// =============================================================================

/**
 * Get a database connection string from the owning project's Key Vault.
 *
 * Connection-string VALUES no longer live in Postgres (they were migrated to a
 * per-project Key Vault). The `project_database_connections` row still carries
 * metadata + `project_id`, which keys the vault.
 *
 * @param connectionId - Connection UUID.
 * @returns The plaintext connection string, or `null` if not found.
 */
export async function getDbConnectionStringWithToken(
  connectionId: string,
  _token?: string | null,
) {
  const result = await db.query(
    "SELECT project_id FROM project_database_connections WHERE id = $1",
    [connectionId],
  );
  const projectId: string | undefined = result.rows[0]?.project_id;
  if (!projectId) return null;
  const { getConnectionStringSecret } =
    await import("../services/deployment/docker/genappKeyVault");
  return getConnectionStringSecret({ projectId, connectionId });
}

/**
 * Update database connection status
 */
export async function updateDbConnectionStatusWithToken(
  connectionId: string,
  _token: string | null,
  status: string,
  error?: string | null,
) {
  const result = await db.query(
    `UPDATE project_database_connections SET status = $2, last_error = $3,
     last_connected_at = CASE WHEN $2 = 'connected' THEN NOW() ELSE last_connected_at END,
     updated_at = NOW() WHERE id = $1 RETURNING *`,
    [connectionId, status, error || null],
  );
  return result.rows[0] || null;
}

// =============================================================================
// Deployment Helpers
// =============================================================================

/**
 * Update deployment
 */
export async function updateDeploymentWithToken(
  deploymentId: string,
  _token: string | null,
  updates: {
    status?: string;
    url?: string;
    azure_container_app_name?: string;
    azure_revision_name?: string;
    [key: string]: any;
  },
) {
  const sets: string[] = ["updated_at = NOW()"];
  const values: any[] = [];
  let idx = 1;

  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined) continue;
    // Column names cannot be passed as bind parameters, so they are
    // interpolated directly into the SQL. Reject anything that is not a plain
    // SQL identifier to prevent SQL injection via attacker-controlled keys.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid deployment update column: ${key}`);
    }
    sets.push(`${key} = $${idx}`);
    values.push(val);
    idx++;
  }
  if (updates.status === "running") sets.push("last_deployed_at = NOW()");

  values.push(deploymentId);
  const result = await db.query(
    `UPDATE project_deployments SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

// =============================================================================
// Admin Helpers
// =============================================================================

/**
 * Get admin users list
 */
export async function getAdminUsers() {
  const result = await db.query(`
    SELECT p.user_id, p.display_name, p.email, p.last_login,
           COALESCE(ur.role::text, 'user') as role, p.created_at
    FROM profiles p
    LEFT JOIN user_roles ur ON ur.user_id = p.user_id
    ORDER BY p.created_at DESC
  `);
  return result.rows;
}

/**
 * Set user role by email
 */
export async function setUserRoleByEmail(email: string, role: string) {
  const profile = await db.query(
    "SELECT user_id FROM profiles WHERE email = $1",
    [email],
  );
  if (profile.rows.length === 0) throw new Error("User not found");
  const userId = profile.rows[0].user_id;
  await db.query(
    `INSERT INTO user_roles (user_id, role, created_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, role) DO UPDATE SET role = $2`,
    [userId, role],
  );
  return true;
}

/**
 * Delete user by email
 */
export async function deleteUserByEmail(email: string) {
  const profile = await db.query(
    "SELECT user_id FROM profiles WHERE email = $1",
    [email],
  );
  if (profile.rows.length === 0) throw new Error("User not found");
  const userId = profile.rows[0].user_id;
  await db.query("DELETE FROM user_roles WHERE user_id = $1", [userId]);
  await db.query("DELETE FROM profiles WHERE user_id = $1", [userId]);
  return true;
}

// =============================================================================
// Agent Helpers
// =============================================================================

/**
 * Create agent session
 */
export async function createAgentSessionWithToken(
  projectId: string,
  _token: string | null,
  repoId: string,
  taskDescription: string,
  mode: string,
) {
  const result = await db.query(
    `INSERT INTO agent_sessions (project_id, status, mode, task_description, started_at, created_at, updated_at)
     VALUES ($1, 'running', $2, $3, NOW(), NOW(), NOW()) RETURNING *`,
    [projectId, mode, taskDescription],
  );
  return result.rows[0] || null;
}

/**
 * Insert agent message
 */
export async function insertAgentMessageWithToken(
  sessionId: string,
  _token: string | null,
  role: string,
  content: string,
  metadata?: any,
) {
  const result = await db.query(
    `INSERT INTO agent_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
    [sessionId, role, content, metadata ? JSON.stringify(metadata) : "{}"],
  );
  return result.rows[0] || null;
}

// =============================================================================
// Staging & Git Helpers
// =============================================================================

/**
 * Stage a file change
 */
export async function stageFileChangeWithToken(
  repoId: string,
  _token: string | null,
  filePath: string,
  operationType: string,
  oldContent?: string | null,
  newContent?: string | null,
  oldPath?: string | null,
) {
  const startedAt = Date.now();
  // Get project_id from repo
  const repo = await db.query(
    "SELECT project_id FROM project_repos WHERE id = $1",
    [repoId],
  );
  if (repo.rows.length === 0) throw new Error("Repo not found");

  // Delegate to StagedContentStore facade — single canonical write path
  const result = await putStagedFile(repoId, filePath, newContent ?? null, {
    projectId: repo.rows[0].project_id,
    operationType,
    oldPath: oldPath || null,
  });

  const stagingCount = await db.query(
    "SELECT count(*) FROM repo_staging WHERE repo_id = $1",
    [repoId],
  );
  const stagingRowCount = Number(stagingCount?.rows?.[0]?.count ?? 0);
  logger.info({
    event: "stage_complete",
    stage_duration_ms: Date.now() - startedAt,
    file_path: filePath,
    operation_type: operationType,
    staging_row_count: stagingRowCount,
  });

  return result;
}

/**
 * Stage multiple file changes atomically for AI agent batch writes.
 *
 * @example
 * await batchStageFiles('repo-id', null, [{ filePath: 'src/app.ts', operationType: 'modify', newContent: '...' }])
 */
export async function batchStageFiles(
  repoId: string,
  _token: string | null,
  files: BatchStageFileInput[],
  projectId?: string | null,
) {
  const startedAt = Date.now();

  if (!repoId) {
    throw new Error("repoId is required");
  }

  if (!Array.isArray(files)) {
    throw new Error("files must be an array");
  }

  if (files.length === 0) {
    return { staged_count: 0, files: [] as string[] };
  }

  for (const file of files) {
    if (!file?.filePath) {
      throw new Error("Each staged file requires filePath");
    }
    if (!file.operationType) {
      throw new Error(`Staged file ${file.filePath} requires operationType`);
    }
  }

  let resolvedProjectId = projectId || null;
  if (!resolvedProjectId) {
    const repo = await db.query(
      "SELECT project_id FROM project_repos WHERE id = $1",
      [repoId],
    );
    if (repo.rows.length === 0) {
      throw new Error("Repo not found");
    }
    resolvedProjectId = repo.rows[0].project_id;
  }

  await getRepoBlobStore().writeStagedBatch(
    resolvedProjectId!,
    repoId,
    files.map((file) => ({
      filePath: file.filePath,
      operationType: file.operationType,
      content: file.newContent ?? null,
    })),
  );

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    for (const file of files) {
      // Compute binary flag and byte length via shared helper from StagedContentStore
      const { isBinary, contentLength } = computeContentMeta(
        file.operationType !== "delete" ? (file.newContent ?? null) : null,
      );

      await client.query(
        `INSERT INTO repo_staging (repo_id, project_id, file_path, operation_type, old_path, is_binary, content_length, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (repo_id, file_path) DO UPDATE SET
           operation_type = CASE
             WHEN repo_staging.operation_type IN ('add', 'create') AND $4 IN ('modify', 'edit')
             THEN repo_staging.operation_type
             ELSE $4
           END,
           old_path = $5, is_binary = $6, content_length = $7, created_at = NOW()
         RETURNING *`,
        [
          repoId,
          resolvedProjectId,
          file.filePath,
          file.operationType,
          file.oldPath || null,
          isBinary,
          contentLength,
        ],
      );
    }

    const stagingCount = await client.query(
      "SELECT count(*) FROM repo_staging WHERE repo_id = $1",
      [repoId],
    );
    const stagingRowCount = Number(stagingCount?.rows?.[0]?.count ?? 0);

    await client.query("COMMIT");
    logger.info({
      event: "batch_stage_complete",
      stage_duration_ms: Date.now() - startedAt,
      staged_count: files.length,
      staging_row_count: stagingRowCount,
    });

    return {
      staged_count: files.length,
      files: files.map((file) => file.filePath),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Unstage a single file
 */
export async function unstageFileWithToken(
  repoId: string,
  filePath: string,
  _token?: string | null,
) {
  const result = await db.query(
    "DELETE FROM repo_staging WHERE repo_id = $1 AND file_path = $2 RETURNING id",
    [repoId, filePath],
  );
  return result.rowCount || 0;
}

/**
 * Unstage multiple files
 */
export async function unstageFilesWithToken(
  repoId: string,
  filePaths: string[],
  _token?: string | null,
) {
  const result = await db.query(
    "DELETE FROM repo_staging WHERE repo_id = $1 AND file_path = ANY($2) RETURNING id",
    [repoId, filePaths],
  );
  return result.rowCount || 0;
}

/**
 * Discard all staged changes for a repo
 */
export async function discardStagedWithToken(
  repoId: string,
  _token?: string | null,
) {
  const result = await db.query("DELETE FROM repo_staging WHERE repo_id = $1", [
    repoId,
  ]);
  return result.rowCount || 0;
}

/**
 * Commit staged changes
 */
export async function commitStagedWithToken(
  repoId: string,
  _token: string | null,
  commitMessage: string,
  branch: string,
  filePaths?: string[] | null,
) {
  if (Array.isArray(filePaths) && filePaths.length === 0) {
    throw new Error("At least one staged file must be selected to commit");
  }

  const client = await db.getClient();
  const hasFileFilter = Array.isArray(filePaths);
  const committedBlobPaths: string[] = [];

  // Resolve projectId before the transaction so it's available for rollback blob cleanup
  const repoLookup = await client.query(
    "SELECT project_id FROM project_repos WHERE id = $1",
    [repoId],
  );
  if (repoLookup.rows.length === 0) {
    client.release();
    throw new Error("Repo not found");
  }
  const projectId = repoLookup.rows[0].project_id;

  try {
    await client.query("BEGIN");

    // Get staged changes
    const staged = hasFileFilter
      ? await client.query(
          "SELECT * FROM repo_staging WHERE repo_id = $1 AND file_path = ANY($2)",
          [repoId, filePaths],
        )
      : await client.query("SELECT * FROM repo_staging WHERE repo_id = $1", [
          repoId,
        ]);
    if (staged.rows.length === 0)
      throw new Error("No staged changes to commit");

    const commitSha = require("crypto")
      .randomUUID()
      .replace(/-/g, "")
      .substring(0, 40);
    const filesMetadata = staged.rows.map((s: any) => ({
      path: s.file_path,
      operation: s.operation_type,
      old_path: s.old_path,
    }));

    // Create commit record
    const commit = await client.query(
      `INSERT INTO repo_commits (repo_id, project_id, branch, commit_sha, commit_message, files_changed, committed_at, created_at, files_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), $7) RETURNING *`,
      [
        repoId,
        projectId,
        branch,
        commitSha,
        commitMessage,
        staged.rows.length,
        JSON.stringify(filesMetadata),
      ],
    );

    // Apply changes to repo_files.
    // Exhaustive switch over StagingOpType — TypeScript reports missing cases at compile time.

    for (const change of staged.rows) {
      const opType = change.operation_type as StagingOpType;
      switch (opType) {
        case "delete":
          await client.query(
            "DELETE FROM repo_files WHERE repo_id = $1 AND path = $2",
            [repoId, change.file_path],
          );
          // Best-effort removal of the committed blob for the deleted file
          try {
            await getRepoBlobStore().deleteCommitted(
              projectId,
              repoId,
              change.file_path,
            );
          } catch (deleteErr) {
            logger.warn("Failed to delete committed blob for deleted file", {
              repo_id: repoId,
              file_path: change.file_path,
              error: (deleteErr as Error).message,
            });
          }
          break;

        case "rename":
          if (change.old_path) {
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
              [repoId, change.old_path, change.file_path, commitSha],
            );
            // Copy committed blob from old path to new path
            try {
              const renamedContent = await getRepoBlobStore().readCommitted(
                projectId,
                repoId,
                change.old_path,
              );
              if (renamedContent !== null) {
                await getRepoBlobStore().writeCommitted(
                  projectId,
                  repoId,
                  change.file_path,
                  renamedContent,
                );
                await getRepoBlobStore().deleteCommitted(
                  projectId,
                  repoId,
                  change.old_path,
                );
              }
            } catch (renameErr) {
              logger.warn("Failed to copy committed blob during rename", {
                repo_id: repoId,
                old_path: change.old_path,
                new_path: change.file_path,
                error: (renameErr as Error).message,
              });
            }
          }
          break;

        case "add":
        case "create":
        case "modify":
        case "edit": {
          // Read staged content from blob storage
          const blobContent = await getRepoBlobStore().readStaged(
            projectId,
            repoId,
            change.file_path,
          );
          if (blobContent === null) {
            throw new Error(
              `Missing staged blob content for ${change.file_path}; re-stage the file and try committing again.`,
            );
          }
          // Write committed blob
          await getRepoBlobStore().writeCommitted(
            projectId,
            repoId,
            change.file_path,
            blobContent,
          );
          committedBlobPaths.push(change.file_path);
          // Metadata-only UPSERT into repo_files (no content column)
          const { isBinary, contentLength } = computeContentMeta(blobContent);
          await client.query(
            `INSERT INTO repo_files (repo_id, project_id, path, is_binary, content_length, last_commit_sha, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
             ON CONFLICT (repo_id, path) DO UPDATE SET is_binary = $4, content_length = $5, last_commit_sha = $6, updated_at = NOW()`,
            [
              repoId,
              projectId,
              change.file_path,
              isBinary,
              contentLength,
              commitSha,
            ],
          );
          break;
        }

        default:
          assertNeverStagingOp(opType);
      }
    }

    // Clear staging
    if (hasFileFilter) {
      await client.query(
        "DELETE FROM repo_staging WHERE repo_id = $1 AND file_path = ANY($2)",
        [repoId, filePaths],
      );
    } else {
      await client.query("DELETE FROM repo_staging WHERE repo_id = $1", [
        repoId,
      ]);
    }
    await client.query("COMMIT");

    // Best-effort staged blob cleanup after the transaction commits
    for (const filePath of committedBlobPaths) {
      try {
        await getRepoBlobStore().deleteStaged(projectId, repoId, filePath);
      } catch (cleanupError) {
        logger.warn("Failed to clean up committed staged blob", {
          repo_id: repoId,
          file_path: filePath,
          error: (cleanupError as Error).message,
        });
      }
    }

    return commit.rows[0] || null;
  } catch (error) {
    await client.query("ROLLBACK");
    // Blob rollback: remove any committed blobs written in this batch to prevent orphans
    for (const filePath of committedBlobPaths) {
      try {
        await getRepoBlobStore().deleteCommitted(projectId, repoId, filePath);
      } catch {
        // Best-effort: orphaned committed blobs will be overwritten on next successful commit
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Upsert a single file
 */
export async function upsertFileWithToken(
  repoId: string,
  filePath: string,
  content: string,
  _token?: string | null,
  commitSha?: string | null,
) {
  const repo = await db.query(
    "SELECT project_id FROM project_repos WHERE id = $1",
    [repoId],
  );
  if (repo.rows.length === 0) throw new Error("Repo not found");
  // Write content to committed blob storage
  await getRepoBlobStore().writeCommitted(
    repo.rows[0].project_id,
    repoId,
    filePath,
    content,
  );
  const { isBinary, contentLength } = computeContentMeta(content);
  const result = await db.query(
    `INSERT INTO repo_files (repo_id, project_id, path, is_binary, content_length, last_commit_sha, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (repo_id, path) DO UPDATE SET is_binary = $4, content_length = $5, last_commit_sha = $6, updated_at = NOW()
     RETURNING *`,
    [
      repoId,
      repo.rows[0].project_id,
      filePath,
      isBinary,
      contentLength,
      commitSha || null,
    ],
  );
  return result.rows[0] || null;
}

/**
 * Upsert files in batch
 */
export async function upsertFilesBatchWithToken(
  repoId: string,
  filesJson: string,
  _token?: string | null,
) {
  const files =
    typeof filesJson === "string" ? JSON.parse(filesJson) : filesJson;
  const repo = await db.query(
    "SELECT project_id FROM project_repos WHERE id = $1",
    [repoId],
  );
  if (repo.rows.length === 0) throw new Error("Repo not found");
  const projectId = repo.rows[0].project_id;

  let upserted = 0;
  for (const file of files) {
    const contentLength = file.content
      ? Buffer.from(file.content, "utf8").length
      : 0;
    await db.query(
      `INSERT INTO repo_files (repo_id, project_id, path, is_binary, content_length, last_commit_sha, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (repo_id, path) DO UPDATE SET is_binary = $4, content_length = $5, last_commit_sha = $6, updated_at = NOW()`,
      [
        repoId,
        projectId,
        file.path,
        file.is_binary || false,
        contentLength,
        file.commit_sha || file.sha || null,
      ],
    );
    upserted++;
  }
  return upserted;
}

/**
 * Mark commits as pushed
 */
export async function markCommitsPushedWithToken(
  repoId: string,
  _token: string | null,
  githubSha: string,
  branch: string,
) {
  const result = await db.query(
    `UPDATE repo_commits SET pushed_at = NOW(), github_sha = $2
     WHERE repo_id = $1 AND branch = $3 AND pushed_at IS NULL RETURNING id`,
    [repoId, githubSha, branch],
  );
  return result.rowCount || 0;
}

/**
 * Log a repo commit
 */
export async function logRepoCommitWithToken(
  repoId: string,
  _token: string | null,
  branch: string,
  commitSha: string,
  commitMessage: string,
  filesChanged: number,
) {
  const repo = await db.query(
    "SELECT project_id FROM project_repos WHERE id = $1",
    [repoId],
  );
  const projectId = repo.rows[0]?.project_id;
  const result = await db.query(
    `INSERT INTO repo_commits (repo_id, project_id, branch, commit_sha, commit_message, files_changed, github_sha, pushed_at, committed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $4, NOW(), NOW(), NOW()) RETURNING *`,
    [repoId, projectId, branch, commitSha, commitMessage, filesChanged],
  );
  return result.rows[0] || null;
}

// =============================================================================
// Canvas Node/Edge Helpers (for orchestrate-agents)
// =============================================================================

/**
 * Upsert canvas node (for orchestrate-agents)
 */
export async function upsertCanvasNodeWithToken(
  nodeId: string,
  projectId: string,
  _token: string | null,
  type: string,
  position: any,
  data: any,
) {
  const posObj = typeof position === "string" ? JSON.parse(position) : position;
  const dataObj = typeof data === "string" ? JSON.parse(data) : data;

  // Try update first
  const update = await db.query(
    `UPDATE canvas_nodes SET type = COALESCE($2, type), position = $3, data = $4, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [nodeId, type, posObj, dataObj],
  );
  if (update.rows.length > 0) return update.rows[0];

  // Insert
  const insert = await db.query(
    `INSERT INTO canvas_nodes (id, project_id, type, position, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING *`,
    [nodeId, projectId, type || "OTHER", posObj, dataObj],
  );
  return insert.rows[0] || null;
}

/**
 * Delete canvas node
 */
export async function deleteCanvasNodeWithToken(
  nodeId: string,
  _token?: string | null,
) {
  await db.query("DELETE FROM canvas_edges WHERE source = $1 OR target = $1", [
    nodeId,
  ]);
  const result = await db.query(
    "DELETE FROM canvas_nodes WHERE id = $1 RETURNING id",
    [nodeId],
  );
  return result.rowCount || 0;
}

/**
 * Upsert canvas edge (for orchestrate-agents)
 */
export async function upsertCanvasEdgeWithToken(
  edgeId: string,
  projectId: string,
  _token: string | null,
  source: string,
  target: string,
  label?: string,
  edgeType?: string,
  data?: any,
) {
  const dataObj = data
    ? typeof data === "string"
      ? JSON.parse(data)
      : data
    : {};

  // Try update first
  const update = await db.query(
    `UPDATE canvas_edges SET source = COALESCE($2, source), target = COALESCE($3, target),
     label = COALESCE($4, label), edge_type = COALESCE($5, edge_type), data = COALESCE($6, data),
     updated_at = NOW() WHERE id = $1 RETURNING *`,
    [edgeId, source, target, label || null, edgeType || "default", dataObj],
  );
  if (update.rows.length > 0) return update.rows[0];

  // Insert
  const insert = await db.query(
    `INSERT INTO canvas_edges (id, project_id, source, target, label, edge_type, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING *`,
    [
      edgeId,
      projectId,
      source,
      target,
      label || null,
      edgeType || "default",
      dataObj,
    ],
  );
  return insert.rows[0] || null;
}

/**
 * Delete canvas edge
 */
export async function deleteCanvasEdgeWithToken(
  edgeId: string,
  _token?: string | null,
) {
  const result = await db.query(
    "DELETE FROM canvas_edges WHERE id = $1 RETURNING id",
    [edgeId],
  );
  return result.rowCount || 0;
}

/**
 * Get canvas node types
 */
export async function getCanvasNodeTypes(includeLegacy: boolean) {
  const sql = includeLegacy
    ? "SELECT * FROM canvas_node_types WHERE is_active = true ORDER BY order_score ASC"
    : "SELECT * FROM canvas_node_types WHERE is_active = true AND is_legacy = false ORDER BY order_score ASC";
  const result = await db.query(sql);
  return result.rows;
}

/**
 * Insert artifact — writes content to blob storage and metadata to DB.
 */
export async function insertArtifactWithToken(
  projectId: string,
  _token: string | null,
  content: string,
  sourceType?: string,
  sourceId?: string | null,
  imageUrl?: string | null,
  aiTitle?: string | null,
  provenanceId?: string | null,
  provenancePath?: string | null,
  provenancePage?: number | null,
) {
  const contentLength = content ? Buffer.byteLength(content, "utf8") : 0;
  const result = await db.query(
    `INSERT INTO artifacts (project_id, source_type, source_id, image_url, ai_title, provenance_id, provenance_path, provenance_page, content_length, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW()) RETURNING *`,
    [
      projectId,
      sourceType || null,
      sourceId || null,
      imageUrl || null,
      aiTitle || null,
      provenanceId || null,
      provenancePath || null,
      provenancePage || null,
      contentLength,
    ],
  );
  const inserted = result.rows[0];
  if (inserted && content) {
    await putArtifactContent(projectId, inserted.id, content);
  }
  return inserted ? { ...inserted, content } : null;
}

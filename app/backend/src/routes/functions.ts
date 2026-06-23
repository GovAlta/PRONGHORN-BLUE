/**
 * Functions Proxy Routes
 *
 * @swagger
 * tags:
 *   name: Functions
 *   description: Edge Function replacements
 */
import { Router, Request, Response } from "express";
import crypto from "crypto";
import db from "../utils/database";
import { logger } from "../utils/logger";
import { Errors } from "../middleware/errorHandler";
import { broadcast } from "../websocket";
import * as rpc from "../utils/rpcHelpers";
import { resolveGitHubToken, gitHubApiHeaders, gitHubApiFetch } from "../utils/githubAuth";
import { getAzureTokenForScope, AzureScope } from "../utils/azureCredential";
import * as dockerDeploymentService from "../services/deployment/docker/dockerDeploymentService";
import { ensureGenappKeyVault, deriveGenappKeyVaultName, deriveGenappKeyVaultUri, getGenappSecrets, setGenappSecrets, getConnectionStringSecret, setConnectionStringSecret, type GenappSecretEntry } from "../services/deployment/docker/genappKeyVault";
import { stagingChannel, repoFilesChannel } from "../utils/repoChannels";
import { getRepoBlobStore } from "../utils/repoBlobStore";
import { resolveAttachedContext } from "../utils/resolveAttachedContext";

const router = Router();
const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

/**
 * Validate a GitHub owner/organization or repository slug before interpolating
 * it into an api.github.com URL. Prevents SSRF / path-injection by rejecting any
 * value containing path separators, schemes, or traversal sequences.
 * @param value - The candidate owner or repository name.
 * @param label - Human-readable field name used in the error message.
 * @returns The validated value, URL-encoded (a no-op for valid slug characters)
 *   so it is safe to interpolate into a request URL.
 * @throws BadRequest when the value is not a safe GitHub slug.
 * @example const org = assertGitHubSlug(templateOrg, "templateOrg");
 */
function assertGitHubSlug(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    value.includes("..") ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw Errors.badRequest(`Invalid ${label}`);
  }
  // encodeURIComponent is a no-op for the validated character set above, but it
  // marks the value as sanitized for static analysis (SSRF / path-injection).
  return encodeURIComponent(value);
}

/**
 * Validate a GitHub branch/ref before interpolating it into an api.github.com
 * URL. Slightly more permissive than {@link assertGitHubSlug} to allow nested
 * refs (e.g. "feature/x") while still blocking traversal and URL manipulation.
 * @param value - The candidate ref/branch name.
 * @param label - Human-readable field name used in the error message.
 * @returns The validated ref with each path segment URL-encoded (a no-op for
 *   valid characters) while preserving the "/" structure of nested refs.
 * @throws BadRequest when the value is not a safe GitHub ref.
 */
function assertGitHubRef(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.includes("..") ||
    value.startsWith("/") ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw Errors.badRequest(`Invalid ${label}`);
  }
  // Encode each segment so the value is sanitized for static analysis while
  // keeping the "/" separators legitimately used by nested branch names.
  return value.split("/").map(encodeURIComponent).join("/");
}

/**
 * Remove leading and trailing ASCII hyphens from a string using a linear scan.
 *
 * Replaces the polynomial-backtracking regex `/^-+|-+$/g` (whose `-+$`
 * alternative is O(n^2) on long hyphen runs not anchored at the end), avoiding
 * a ReDoS sink while producing identical output.
 *
 * @param value - The string to trim.
 * @returns The input with all leading/trailing `-` characters removed.
 * @example stripEdgeHyphens("--a-b--"); // => "a-b"
 */
function stripEdgeHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45 /* '-' */) start++;
  while (end > start && value.charCodeAt(end - 1) === 45 /* '-' */) end--;
  return value.slice(start, end);
}

/**
 * Build a unique, URL/GitHub-safe repository slug from a user-supplied name.
 *
 * Lowercases, replaces disallowed characters with hyphens, trims and collapses
 * hyphens (without a polynomial regex), then appends a short random suffix to
 * avoid collisions.
 *
 * @param repoName - The user-supplied repository display name.
 * @returns A slug such as "my-repo-1a2b3c4d", URL-encoded (a no-op for the
 *   slug's `[a-z0-9-]` character set) so it is safe to interpolate into a
 *   request URL.
 * @example buildRepoSlug("My Repo!"); // => "my-repo-1a2b3c4d"
 */
function buildRepoSlug(repoName: string): string {
  const base = stripEdgeHyphens(
    repoName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, "-"),
  ).replace(/-{2,}/g, "-");
  const uniqueSuffix = crypto.randomUUID().split("-")[0];
  // encodeURIComponent is a no-op for the [a-z0-9-] slug characters, but it
  // marks the result as sanitized for static analysis (SSRF / path-injection).
  return encodeURIComponent(`${base}-${uniqueSuffix}`);
}

/**
 * Validate and safely double-quote a PostgreSQL identifier (database, role, or
 * schema name) for use in DDL/DCL statements where bind parameters are not
 * supported. Rejects anything that is not a conservative identifier, preventing
 * SQL injection via interpolated names.
 *
 * @param value - The candidate identifier.
 * @param label - Human-readable field name used in the error message.
 * @returns The identifier wrapped in double quotes, e.g. `"my_db"`.
 * @throws BadRequest when the value is not a safe identifier.
 * @example `CREATE DATABASE ${quotePgIdentifier(dbName, "database name")}`
 */
function quotePgIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > POSTGRES_IDENTIFIER_MAX_LENGTH ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
  ) {
    throw Errors.badRequest(`Invalid ${label}`);
  }
  return `"${value}"`;
}

interface ProjectDatabaseRecord {
  id: string;
  project_id: string;
  name?: string | null;
  status?: string | null;
  database_internal_name?: string | null;
  database_user?: string | null;
  has_connection_info?: boolean | null;
  connection_string?: string | null;
}

/**
 * Creates a PostgreSQL-safe identifier from a user-visible database display name.
 * Example: createPostgresIdentifierFromDisplayName("My Repo-a1b2") returns "my_repo_a1b2".
 */
export function createPostgresIdentifierFromDisplayName(
  displayName: unknown,
): string {
  if (typeof displayName !== "string" || !displayName.trim()) {
    return "database";
  }

  const sanitized = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!sanitized) {
    return "database";
  }

  const safeIdentifier = /^[a-z_]/.test(sanitized)
    ? sanitized
    : `db_${sanitized}`;
  return safeIdentifier.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH);
}

/**
 * Creates a deterministic collision-resistant database name from the display name.
 * Example: createDisplayDerivedDatabaseName("My Repo-a1b2", "db-12345678") returns "my_repo_a1b2".
 */
export function createDisplayDerivedDatabaseName(
  displayName: unknown,
  databaseId: string,
  includeSuffix = false,
): string {
  const baseIdentifier = createPostgresIdentifierFromDisplayName(displayName);
  if (!includeSuffix) {
    return baseIdentifier;
  }

  const suffix =
    databaseId
      .replace(/[^a-zA-Z0-9]+/g, "")
      .toLowerCase()
      .slice(0, 8) || crypto.randomBytes(4).toString("hex");
  const maxBaseLength = POSTGRES_IDENTIFIER_MAX_LENGTH - suffix.length - 1;
  return `${baseIdentifier.slice(0, maxBaseLength)}_${suffix}`;
}

/**
 * Creates a stable PostgreSQL role name for a project database row.
 * Example: createProjectDatabaseRoleName("db-1111") returns "role_db_1111".
 */
export function createProjectDatabaseRoleName(databaseId: string): string {
  return `role_${databaseId.replace(/-/g, "_").substring(0, 20)}`;
}

/**
 * Generic function invoke endpoint
 * Routes to specific implementations based on function name
 */
router.post("/:functionName", async (req: Request, res: Response) => {
  const { functionName } = req.params;
  const body = req.body || {};
  
  logger.info(`Function invoke: ${functionName}`);

  // Route to specific function implementations
  switch (functionName) {
    case "validate-signup-code":
      return await handleValidateSignupCode(req, res, body);

    case "send-auth-email":
      return await handleSendAuthEmail(req, res, body);

    case "update-signup-validated":
      return await handleUpdateSignupValidated(req, res, body);

    case "project-activity":
      return await handleProjectActivity(req, res, body);

    case "create-project":
      return await handleCreateProject(req, res, body);

    case "delete-project":
      return await handleDeleteProject(req, res, body);

    case "clone-project":
      return await handleCloneProject(req, res, body);

    case "manage-database":
      return await handleManageDatabase(req, res, body);

    case "render-database":
    case "cloud-database":
      return await handleDatabaseProvisioning(req, res, body);

    case "cloud-deployment":
      return await handleDeploymentService(req, res, body);

    case "deployment-preview-token":
      return await handleDeploymentPreviewToken(req, res, body);

    case "admin-management":
      return await handleAdminManagement(req, res, body);

    case "ai-create-standards":
    case "expand-requirement":
    case "decompose-requirements":
    case "expand-standards":
      return await handleAiPlaceholder(req, res, body, functionName);

    case "audit-orchestrator":
      return await handleAuditOrchestrator(req, res, body);

    case "coding-agent-orchestrator":
      return await handleCodingAgentOrchestrator(req, res, body);

    case "ai-architect":
    case "ai-architect-critic":
      body.__functionName = functionName;
      return await handleAiArchitect(req, res, body);

    case "generate-image":
      return await handleGenerateImage(req, res, body);

    case "upload-artifact-image":
      return await handleUploadArtifactImage(req, res, body);

    case "generate-local-package":
      return await handleGenerateLocalPackage(req, res, body);

    case "database-connection-secrets":
    case "deployment-secrets":
      return await handleSecretsManagement(req, res, body, functionName);

    case "staging-operations":
      return await handleStagingOperations(req, res, body);

    case "create-empty-repo":
    case "create-repo-from-template":
    case "clone-public-repo":
    case "link-existing-repo":
      return await handleRepoOperations(req, res, body, functionName);

    case "sync-repo-push":
    case "sync-repo-pull":
      return await handleRepoSync(req, res, body, functionName);

    case "database-agent-import":
      return await handleDatabaseAgentImport(req, res, body);

    case "superadmin-github-management":
    case "superadmin-cloud-management":
      return await handleSuperadminManagement(req, res, body, functionName);

    case "enhance-image":
      return await handleEnhanceImage(req, res, body);

    case "orchestrate-agents":
      return await handleOrchestrateAgents(req, res, body);

    case "chat-stream-foundry":
      return await handleChatStream(req, res, body, functionName);

    case "collaboration-agent-orchestrator":
      return await handleCollaborationOrchestrator(req, res, body);

    case "database-agent-orchestrator":
      return await handleDatabaseAgentOrchestrator(req, res, body);

    case "generate-specification":
      return await handleGenerateSpecification(req, res, body);

    case "ingest-artifacts":
      return await handleIngestArtifacts(req, res, body);

    case "presentation-agent":
      return await handlePresentationAgent(req, res, body);

    case "summarize-artifact":
    case "summarize-chat":
      return await handleSummarize(req, res, body, functionName);

    case "recast-slide-layout":
      return await handleRecastSlideLayout(req, res, body);

    case "visual-recognition":
      return await handleVisualRecognition(req, res, body);

    case "log-activity":
      return await handleLogActivity(req, res, body);

    case "report-local-issue":
      return await handleReportLocalIssue(req, res, body);

    // Audit pipeline sub-functions (called directly by frontend useAuditPipeline hook)
    case "audit-extract-concepts":
      return await handleAuditExtractConcepts(req, res, body);

    case "audit-merge-concepts-v2":
      return await handleAuditMergeConceptsV2(req, res, body);

    case "audit-build-tesseract":
      return await handleAuditBuildTesseract(req, res, body);

    case "audit-generate-venn":
      return await handleAuditGenerateVenn(req, res, body);

    case "audit-enhanced-sort":
      return await handleAuditEnhancedSort(req, res, body);

    default:
      logger.warn(`Unknown function: ${functionName}`);
      throw Errors.notFound(`Function '${functionName}' not found`);
  }
});

// ============================================================================
// Function Implementations
// ============================================================================

async function handleValidateSignupCode(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const { code } = body;

  if (!code) {
    res.status(400).json({ error: "Signup code is required" });
    return;
  }

  // For Azure API mode, validate against allowed codes
  const validCodes = (
    process.env.VALID_SIGNUP_CODES || "PRONGHORN2024,ADMIN,BETA"
  ).split(",");
  const isValid = validCodes.includes(code.toUpperCase());

  res.json({ valid: isValid });
}

async function handleSendAuthEmail(req: Request, res: Response, body: any) {
  const { type, email } = body;

  // In Azure mode, auth is handled by JWT - email sending via Azure Communication Services
  logger.info(`Send auth email: ${type} to ${email}`);

  // TODO: Implement via Azure Communication Services
  res.json({
    success: true,
    message:
      "Email functionality placeholder - implement Azure Communication Services",
  });
}

async function handleUpdateSignupValidated(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  await db.query(
    "UPDATE auth.users SET email_verified = true, updated_at = NOW() WHERE id = $1",
    [userId],
  );

  res.json({ success: true });
}

async function handleProjectActivity(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const { projectId, granularity = "week" } = body;

  logger.info(`Project activity: ${projectId}, granularity: ${granularity}`);

  if (!projectId) {
    res.json({ entities: [], periods: [], granularity });
    return;
  }

  try {
    const now = new Date();
    let startDate: Date;
    let periodCount: number;

    if (granularity === "day") {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 30);
      periodCount = 30;
    } else if (granularity === "week") {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 84);
      periodCount = 12;
    } else {
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 12);
      periodCount = 12;
    }

    // Generate periods array
    const periods: string[] = [];
    const currentPeriod = new Date(startDate);
    for (let i = 0; i < periodCount; i++) {
      periods.push(currentPeriod.toISOString().split("T")[0]);
      if (granularity === "day") {
        currentPeriod.setDate(currentPeriod.getDate() + 1);
      } else if (granularity === "week") {
        currentPeriod.setDate(currentPeriod.getDate() + 7);
      } else {
        currentPeriod.setMonth(currentPeriod.getMonth() + 1);
      }
    }

    // Query activity counts for different entities
    const entities = [
      { key: "artifacts", label: "Artifacts", table: "artifacts" },
      { key: "requirements", label: "Requirements", table: "requirements" },
      { key: "canvas_nodes", label: "Canvas Nodes", table: "canvas_nodes" },
      { key: "chat_sessions", label: "Chat Sessions", table: "chat_sessions" },
    ];

    const entityResults: any[] = [];

    for (const entity of entities) {
      const data = periods.map((period) => ({ period, count: 0 }));

      const sql = `
        SELECT 
          DATE_TRUNC('${granularity === "day" ? "day" : granularity === "week" ? "week" : "month"}', created_at) as period,
          COUNT(*) as count
        FROM ${entity.table}
        WHERE project_id = $1 AND created_at >= $2
        GROUP BY period ORDER BY period
      `;

      try {
        const result = await db.query(sql, [projectId, startDate]);
        for (const row of result.rows) {
          const periodStr = new Date(row.period).toISOString().split("T")[0];
          const idx = data.findIndex((d) => d.period === periodStr);
          if (idx >= 0) {
            data[idx].count = parseInt(row.count, 10);
          }
        }
      } catch (err: any) {
        logger.warn(`Failed to query ${entity.table}: ${err.message}`);
      }

      entityResults.push({ key: entity.key, label: entity.label, data });
    }

    res.json({ entities: entityResults, periods, granularity });
  } catch (error) {
    logger.error("Project activity error:", error);
    res.json({ entities: [], periods: [], granularity });
  }
}

async function handleCreateProject(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const userId = req.user?.id;
  const { projectData, techStackIds, standardIds, requirementsText } = body;

  const name = projectData?.name || body.name;
  const description = projectData?.description || body.description;

  if (!name) {
    res.status(400).json({ error: "Project name required", success: false });
    return;
  }

  try {
    // For anonymous users, use default "Anonymous" org
    let orgId: string;
    const existingOrg = await db.query(
      "SELECT id FROM organizations WHERE name = 'Anonymous Projects' LIMIT 1",
    );

    if (existingOrg.rows.length > 0) {
      orgId = existingOrg.rows[0].id;
    } else {
      const newOrg = await db.query(
        "INSERT INTO organizations (name, created_at, updated_at) VALUES ('Anonymous Projects', NOW(), NOW()) RETURNING id",
      );
      orgId = newOrg.rows[0].id;
    }

    const projectResult = await db.query(
      `INSERT INTO projects (
        name, description, org_id, status, organization, budget, scope, 
        timeline_start, timeline_end, priority, tags, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW()) RETURNING *`,
      [
        name,
        description || null,
        orgId,
        projectData?.status || "DESIGN",
        projectData?.organization || null,
        projectData?.budget || null,
        projectData?.scope || null,
        projectData?.timeline_start || null,
        projectData?.timeline_end || null,
        projectData?.priority || "medium",
        projectData?.tags || null,
        userId || null,
      ],
    );

    const project = projectResult.rows[0];

    // Create an owner token (the project creator should be owner)
    const tokenResult = await db.query(
      "INSERT INTO project_tokens (project_id, role, label, created_at, created_by) VALUES ($1, 'owner', 'Default Owner Token', NOW(), $2) RETURNING token",
      [project.id, userId || null],
    );

    const shareToken = tokenResult.rows[0].token;

    // Link tech stacks if provided
    if (techStackIds && techStackIds.length > 0) {
      for (const techStackId of techStackIds) {
        await db.query(
          "INSERT INTO project_tech_stacks (project_id, tech_stack_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING",
          [project.id, techStackId],
        );
      }
    }

    // Link standards if provided
    if (standardIds && standardIds.length > 0) {
      for (const standardId of standardIds) {
        await db.query(
          "INSERT INTO project_standards (project_id, standard_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING",
          [project.id, standardId],
        );
      }
    }

    // Create initial requirement if text provided
    if (requirementsText && requirementsText.trim()) {
      await db.query(
        "INSERT INTO requirements (project_id, title, description, element_type, status, created_at, updated_at) VALUES ($1, $2, $3, 'requirement', 'draft', NOW(), NOW())",
        [project.id, "Initial Requirements", requirementsText.trim()],
      );
    }

    logger.info(
      `Project created: ${project.id} by user ${userId || "anonymous"}`,
    );

    // Broadcast project creation to subscribers
    broadcast(`project-${project.id}`, "project_refresh", {
      action: "created",
      projectId: project.id,
    });

    res.json({ success: true, project: { ...project, shareToken } });
  } catch (error: any) {
    logger.error("Create project error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to create project",
    });
  }
}

async function handleDeleteProject(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
    const {
    projectId,
    project_id,
    shareToken,
    deleteGitHubRepos,
  } = body;
  const projId = projectId || project_id;

  if (!projId) {
    res.status(400).json({ success: false, error: "projectId is required" });
    return;
  }

  logger.info(`[delete-project] Starting deletion for project: ${projId}`);

  try {
    // Validate owner access
    const roleResult = await (async () => {
      const _role = await rpc.requireRole(projId, shareToken || null, "owner");
      return { rows: [{ role: _role }] };
    })();
    logger.info(
      `[delete-project] Access validated, user role: ${roleResult.rows[0]?.role}`,
    );

    const results: Array<{
      category: string;
      success: boolean;
      count?: number;
      error?: string;
    }> = [];

    // Step 1: Delete GitHub repositories if requested
    if (deleteGitHubRepos) {
      logger.info("[delete-project] Deleting GitHub repositories...");
      try {
        const reposResult = await (async () => {
          const _r = await rpc.getProjectReposWithToken(
            projId,
            shareToken || null,
          );
          return { rows: _r };
        })();

        const repos = reposResult.rows || [];
        let deletedCount = 0;
        const errors: string[] = [];
        for (const repo of repos) {
          try {
            const resolved = await resolveGitHubToken({
              userId: req.user?.id,
              repoId: repo.id,
              isDefaultRepo: repo.is_default,
            });
            if (!resolved) {
              errors.push(
                `No GitHub token available for ${repo.organization}/${repo.repo}`,
              );
              continue;
            }

            const response = await gitHubApiFetch(
              `/repos/${repo.organization}/${repo.repo}`,
              resolved.token,
              { method: "DELETE" },
            );

            if (response.ok || response.status === 404) {
              deletedCount++;
            } else {
              await response.text();
              errors.push(
                `Failed to delete ${repo.organization}/${repo.repo}: ${response.status}`,
              );
            }
          } catch (repoError: any) {
            errors.push(
              `Error deleting ${repo.organization}/${repo.repo}: ${repoError.message}`,
            );
          }
        }

        results.push({
          category: "github_repos",
          success: errors.length === 0,
          count: deletedCount,
          error: errors.length > 0 ? errors.join("; ") : undefined,
        });
      } catch (error: any) {
        results.push({
          category: "github_repos",
          success: false,
          error: error.message,
        });
      }
    }

    // Step 2: Delete project and all database records via cascade RPC
    logger.info(
      "[delete-project] Deleting project and all database records...",
    );
    await (async () => {
      await rpc.deleteProjectWithToken(projId, shareToken || null);
      return { rows: [{ result: true }] };
    })();

    results.push({ category: "project_data", success: true });
    logger.info("[delete-project] Project deletion completed successfully");

    // Broadcast project deletion to subscribers
    broadcast(`project-${projId}`, "project_refresh", {
      action: "deleted",
      projectId: projId,
    });

    res.json({
      success: true,
      results,
      message: "Project deleted successfully",
    });
  } catch (error: any) {
    logger.error("[delete-project] Error:", error.message);
    res.status(400).json({ success: false, error: error.message });
  }
}

async function handleCloneProject(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const {
    sourceProjectId,
    source_project_id,
    shareToken,
    newName,
    new_name,
    cloneChat = false,
    cloneArtifacts = false,
    cloneRequirements = true,
    cloneStandards = true,
    cloneSpecifications = false,
    cloneCanvas = true,
    cloneRepoFiles = false,
    cloneRepoStaging = false,
  } = body;

  const projectId = sourceProjectId || source_project_id;
  const name = newName || new_name;

  logger.info(
    `[clone-project] Starting project clone: ${projectId} as ${name}`,
  );

  if (!projectId) {
    res
      .status(400)
      .json({ success: false, error: "sourceProjectId is required" });
    return;
  }

  if (!name || !name.trim()) {
    res.status(400).json({ success: false, error: "newName is required" });
    return;
  }

  try {
    const cloneResult = await rpc.cloneProjectWithToken(
      projectId,
      shareToken || null,
      name.trim(),
      cloneChat,
      cloneArtifacts,
      cloneRequirements,
      cloneStandards,
      cloneSpecifications,
      cloneCanvas,
      cloneRepoFiles,
      cloneRepoStaging,
    );

    if (!cloneResult || !cloneResult.id || !cloneResult.share_token) {
      logger.error("[clone-project] Invalid clone result:", cloneResult);
      res.status(500).json({
        success: false,
        error: "Failed to clone project - invalid response from database",
      });
      return;
    }

    logger.info(
      `[clone-project] Project cloned successfully: ${cloneResult.id}`,
    );

    // Broadcast project clone to subscribers
    broadcast(`project-${cloneResult.id}`, "project_refresh", {
      action: "cloned",
      projectId: cloneResult.id,
    });

    res.json({
      success: true,
      project: {
        id: cloneResult.id,
        shareToken: cloneResult.share_token,
      },
    });
  } catch (error: any) {
    logger.error("[clone-project] Fatal error:", error);
    res.status(400).json({ success: false, error: error.message });
  }
}

async function handleManageDatabase(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const {
    action,
    databaseId,
    connectionId,
    shareToken,
    sql,
    schema,
    table,
    name,
    limit: queryLimit,
    offset: queryOffset,
    orderBy,
    orderDir,
    format,
    statements,
    wrapInTransaction,
    connectionString: directConnStr,
  } = body;

  logger.info(
    `[manage-database] Action: ${action}, Database ID: ${databaseId}, Connection ID: ${connectionId}`,
  );

  /** Derive SSL config from the connection string: only enable SSL when sslmode=require is present */
  function sslConfigFor(
    connStr: string,
  ): { rejectUnauthorized: boolean } | false {
    try {
      const url = new URL(connStr);
      const mode =
        url.searchParams.get("sslmode") || url.searchParams.get("ssl");
      if (mode && mode !== "disable" && mode !== "false")
        return { rejectUnauthorized: false };
    } catch {
      /* not a URL — fall through */
    }
    return false;
  }

  // Handle test_connection with direct connection string
  if (action === "test_connection" && directConnStr) {
    const { Client } = await import("pg");
    try {
      const client = new Client({
        connectionString: directConnStr,
        ssl: sslConfigFor(directConnStr),
      });
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
    return;
  }

  const ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY;

  function hexToBytes(hex: string): Buffer {
    return Buffer.from(hex, "hex");
  }
  function isEncrypted(value: string): boolean {
    if (!value || typeof value !== "string") return false;
    if (value.startsWith("postgresql://") || value.startsWith("postgres://"))
      return false;
    const parts = value.split(":");
    return (
      parts.length >= 2 &&
      parts[0].length === 24 &&
      /^[0-9a-f]+$/i.test(parts[0])
    );
  }
  async function decryptValue(ciphertext: string): Promise<string> {
    if (!ENCRYPTION_KEY)
      throw new Error("SECRETS_ENCRYPTION_KEY not configured");
    const [ivHex, encHex] = ciphertext.split(":");
    if (!ivHex || !encHex) throw new Error("Invalid ciphertext format");
    const keyBytes = hexToBytes(ENCRYPTION_KEY);
    const iv = hexToBytes(ivHex);
    const encBuf = hexToBytes(encHex);
    const tagLength = 16;
    const encrypted = encBuf.subarray(0, encBuf.length - tagLength);
    const tag = encBuf.subarray(encBuf.length - tagLength);
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(encrypted);
    dec = Buffer.concat([dec, decipher.final()]);
    return dec.toString("utf8");
  }

  try {
    let connectionString: string | undefined;
    let projectDatabaseName: string | undefined;
    
    if (connectionId) {
      // External database connection
      const connResult = await (async () => {
        const _cs = await rpc.getDbConnectionStringWithToken(
          connectionId,
          shareToken || null,
        );
        return { rows: [{ connection_string: _cs }] };
      })();
      const connStr = connResult.rows[0]?.connection_string;
      if (!connStr) throw new Error("Connection not found or access denied");
      connectionString = isEncrypted(connStr)
        ? await decryptValue(connStr)
        : connStr;

      if (action === "test_connection") {
        const { Client } = await import("pg");
        if (!connectionString)
          throw new Error("Connection not found or access denied");
        const externalConnectionString = connectionString;
        try {
          const client = new Client({
            connectionString: externalConnectionString,
            ssl: sslConfigFor(externalConnectionString),
          });
          await client.connect();
          await client.query("SELECT 1");
          await client.end();
          await rpc.updateDbConnectionStatusWithToken(
            connectionId,
            shareToken || null,
            "connected",
            null,
          );
          res.json({ success: true });
        } catch (error: any) {
          await rpc.updateDbConnectionStatusWithToken(
            connectionId,
            shareToken || null,
            "failed",
            error.message,
          );
          res.status(400).json({ success: false, error: error.message });
        }
        return;
      }
    } else if (databaseId) {
      // Get connection string from database record
      const dbResult = await (async () => {
        const _r = await rpc.getDatabaseWithToken(
          databaseId,
          shareToken || null,
        );
        return { rows: _r ? [_r] : [] };
      })();
      const database = dbResult.rows[0];
      if (!database) throw new Error("Database not found");

      logger.info(
        `[manage-database] Database record: status=${database.status}, internal_name=${database.database_internal_name}, has_conn=${!!database.connection_string}, has_info=${database.has_connection_info}`,
      );

      if (database.connection_string) {
        connectionString = isEncrypted(database.connection_string)
          ? await decryptValue(database.connection_string)
          : database.connection_string;
      } else if (database.database_internal_name) {
        projectDatabaseName = database.database_internal_name;
      } else {
        // Try to find an associated external connection
        const connLookup = await db.query(
          "SELECT id, project_id FROM project_database_connections WHERE project_id = $1 AND database_name = $2 LIMIT 1",
          [
            database.project_id,
            createDisplayDerivedDatabaseName(database.name, database.id),
          ],
        );
        const connRow = connLookup.rows[0];
        const cs = connRow
          ? await getConnectionStringSecret({
              projectId: connRow.project_id,
              connectionId: connRow.id,
            })
          : null;
        if (cs) {
          connectionString = cs;
        } else {
          throw new Error("No connection string available for this database.");
        }
      }
    } else {
      throw new Error("Either databaseId or connectionId is required");
    }

    const createManagedDatabaseClient = async () => {
      if (projectDatabaseName) {
        const { getPoolClient } = await import("../utils/database");
        const poolClient = await getPoolClient({
          database: projectDatabaseName,
          server: "genapps",
        });
        return {
          client: poolClient,
          close: async () => poolClient.release(),
        };
      }

      if (!connectionString) {
        throw new Error("No connection string available for this database.");
      }

      const { Client: PgClient } = await import("pg");
      const client = new PgClient({
        connectionString,
        ssl: sslConfigFor(connectionString),
      });
      await client.connect();
      return {
        client,
        close: async () => {
          await client.end();
        },
      };
    };

    // Execute the requested action
    switch (action) {
      case "get_schema": {
        const { client, close } = await createManagedDatabaseClient();
        try {
          const schemasResult = await client.query(`
            SELECT schema_name FROM information_schema.schemata
            WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            ORDER BY schema_name
          `);

          const schemas: any[] = [];
          for (const schemaRow of schemasResult.rows) {
            const schemaName = schemaRow.schema_name;

            const [
              tablesRes,
              funcsRes,
              triggersRes,
              indexesRes,
              seqsRes,
              typesRes,
              constraintsRes,
            ] = await Promise.all([
              client.query(
                "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
                [schemaName],
              ),
              client.query(
                "SELECT routine_name, routine_type FROM information_schema.routines WHERE routine_schema = $1 ORDER BY routine_name",
                [schemaName],
              ),
              client.query(
                "SELECT trigger_name, event_object_table FROM information_schema.triggers WHERE trigger_schema = $1 ORDER BY trigger_name",
                [schemaName],
              ),
              client.query(
                "SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname",
                [schemaName],
              ),
              client.query(
                "SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = $1 ORDER BY sequence_name",
                [schemaName],
              ),
              client.query(
                "SELECT t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = $1 AND t.typtype IN ('e','c','d','r') ORDER BY t.typname",
                [schemaName],
              ),
              client.query(
                "SELECT tc.constraint_name, tc.table_name, tc.constraint_type FROM information_schema.table_constraints tc WHERE tc.constraint_schema = $1 ORDER BY tc.table_name, tc.constraint_name",
                [schemaName],
              ),
            ]);

            schemas.push({
              name: schemaName,
              tables: tablesRes.rows
                .filter((t: any) => t.table_type === "BASE TABLE")
                .map((t: any) => t.table_name),
              views: tablesRes.rows
                .filter((t: any) => t.table_type === "VIEW")
                .map((t: any) => t.table_name),
              functions: funcsRes.rows
                .filter((f: any) => f.routine_type === "FUNCTION")
                .map((f: any) => f.routine_name),
              procedures: funcsRes.rows
                .filter((f: any) => f.routine_type === "PROCEDURE")
                .map((f: any) => f.routine_name),
              triggers: triggersRes.rows.map((t: any) => ({
                name: t.trigger_name,
                table: t.event_object_table,
              })),
              indexes: indexesRes.rows.map((i: any) => ({
                name: i.indexname,
                table: i.tablename,
                definition: i.indexdef,
              })),
              sequences: seqsRes.rows.map((s: any) => s.sequence_name),
              types: typesRes.rows.map((t: any) => ({
                name: t.typname,
                type:
                  t.typtype === "e"
                    ? "enum"
                    : t.typtype === "c"
                      ? "composite"
                      : t.typtype === "d"
                        ? "domain"
                        : "range",
              })),
              constraints: constraintsRes.rows.map((c: any) => ({
                name: c.constraint_name,
                table: c.table_name,
                type: c.constraint_type,
              })),
            });
          }
          res.json({ success: true, data: { schemas } });
        } finally {
          await close();
        }
        return;
      }

      case "execute_sql": {
        if (!sql) {
          res
            .status(400)
            .json({ success: false, error: "SQL query is required" });
          return;
        }
        const { client, close } = await createManagedDatabaseClient();
        try {
          const startTime = Date.now();
          const result = await client.query(sql);
          res.json({
            success: true,
            data: {
              rows: result.rows,
              rowCount: result.rows?.length || 0,
              columns: result.fields?.map((f: any) => f.name) || [],
              executionTime: Date.now() - startTime,
            },
          });
        } finally {
          await close();
        }
        return;
      }

      case "execute_sql_batch": {
        if (
          !statements ||
          !Array.isArray(statements) ||
          statements.length === 0
        ) {
          res
            .status(400)
            .json({ success: false, error: "statements array required" });
          return;
        }
        const { client, close } = await createManagedDatabaseClient();
        const results: any[] = [];
        let hasError = false;
        let errorMessage = "";
        let errorIndex = -1;

        try {
          if (wrapInTransaction !== false) await client.query("BEGIN");

          for (let i = 0; i < statements.length; i++) {
            const stmt = statements[i];
            const startTime = Date.now();
            try {
              const result = await client.query(stmt.sql);
              results.push({
                index: i,
                success: true,
                description: stmt.description,
                sql: stmt.sql,
                rowCount: result.rows?.length || 0,
                executionTime: Date.now() - startTime,
              });
            } catch (stmtErr: any) {
              results.push({
                index: i,
                success: false,
                description: stmt.description,
                sql: stmt.sql,
                executionTime: Date.now() - startTime,
                error: stmtErr.message,
              });
              hasError = true;
              errorMessage = stmtErr.message;
              errorIndex = i;
              break;
            }
          }

          if (wrapInTransaction !== false) {
            await client.query(hasError ? "ROLLBACK" : "COMMIT");
          }

          const status = hasError ? 400 : 200;
          res.status(status).json({
            success: !hasError,
            results,
            completedCount: results.filter((r: any) => r.success).length,
            totalCount: statements.length,
            error: hasError ? errorMessage : undefined,
            failedIndex: hasError ? errorIndex : undefined,
          });
        } finally {
          await close();
        }
        return;
      }

      case "get_table_data": {
        if (!schema || !table) {
          res
            .status(400)
            .json({ success: false, error: "Schema and table required" });
          return;
        }
        const { client, close } = await createManagedDatabaseClient();
        try {
          const safeSchema = schema.replace(/[^a-zA-Z0-9_]/g, "");
          const safeTable = table.replace(/[^a-zA-Z0-9_]/g, "");
          const safeLimit = Math.min(Math.max(1, queryLimit || 100), 1000);
          const safeOffset = Math.max(0, queryOffset || 0);

          let query = `SELECT * FROM "${safeSchema}"."${safeTable}"`;
          if (orderBy) {
            const safeOrderBy = orderBy.replace(/[^a-zA-Z0-9_]/g, "");
            query += ` ORDER BY "${safeOrderBy}" ${orderDir === "desc" ? "DESC" : "ASC"}`;
          }
          query += ` LIMIT ${safeLimit} OFFSET ${safeOffset}`;

          const result = await client.query(query);
          const countResult = await client.query(
            `SELECT COUNT(*) as count FROM "${safeSchema}"."${safeTable}"`,
          );
          const columns =
            result.rows.length > 0 ? Object.keys(result.rows[0]) : [];

          res.json({
            success: true,
            data: {
              rows: result.rows,
              columns,
              totalRows: parseInt(countResult.rows[0]?.count || "0"),
              limit: safeLimit,
              offset: safeOffset,
            },
          });
        } finally {
          await close();
        }
        return;
      }

      case "get_table_columns": {
        if (!schema || !table) {
          res
            .status(400)
            .json({ success: false, error: "Schema and table required" });
          return;
        }
        const { client, close } = await createManagedDatabaseClient();
        try {
          const result = await client.query(
            "SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
            [schema, table],
          );
          res.json({
            success: true,
            data: {
              columns: result.rows.map((c: any) => ({
                name: c.column_name,
                type: c.data_type,
                nullable: c.is_nullable === "YES",
                default: c.column_default,
                maxLength: c.character_maximum_length,
              })),
            },
          });
        } finally {
          await close();
        }
        return;
      }

      case "export_table": {
        if (!schema || !table) {
          res
            .status(400)
            .json({ success: false, error: "Schema and table required" });
          return;
        }
        const { client, close } = await createManagedDatabaseClient();
        try {
          const safeSchema = schema.replace(/[^a-zA-Z0-9_]/g, "");
          const safeTable = table.replace(/[^a-zA-Z0-9_]/g, "");
          const result = await client.query(
            `SELECT * FROM "${safeSchema}"."${safeTable}"`,
          );
          const exportFormat = format || "json";

          if (exportFormat === "json") {
            res.json({
              success: true,
              data: {
                format: "json",
                data: result.rows,
                rowCount: result.rows.length,
              },
            });
          } else if (exportFormat === "csv") {
            const columns = result.fields?.map((f: any) => f.name) || [];
            const header = columns.join(",");
            const rows = result.rows.map((row: any) =>
              columns
                .map((col: string) => {
                  const val = row[col];
                  if (val === null || val === undefined) return "";
                  const str = String(val);
                  return str.includes(",") ||
                    str.includes('"') ||
                    str.includes("\n")
                    ? `"${str.replace(/"/g, '""')}"`
                    : str;
                })
                .join(","),
            );
            res.json({
              success: true,
              data: {
                format: "csv",
                data: [header, ...rows].join("\n"),
                rowCount: result.rows.length,
              },
            });
          } else if (exportFormat === "sql") {
            const columns = result.fields?.map((f: any) => f.name) || [];
            const stmts = result.rows.map((row: any) => {
              const values = columns.map((col: string) => {
                const val = row[col];
                if (val === null || val === undefined) return "NULL";
                if (typeof val === "number") return String(val);
                if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
                return `'${String(val).replace(/'/g, "''")}'`;
              });
              return `INSERT INTO "${safeSchema}"."${safeTable}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${values.join(", ")});`;
            });
            res.json({
              success: true,
              data: {
                format: "sql",
                data: stmts.join("\n"),
                rowCount: result.rows.length,
              },
            });
          }
        } finally {
          await close();
        }
        return;
      }

      case "get_table_definition":
      case "get_table_structure": {
        if (!schema || !table) {
          res
            .status(400)
            .json({ success: false, error: "Schema and table required" });
          return;
        }
        const { client, close } = await createManagedDatabaseClient();
        try {
          const [colsRes, pkRes, fkRes, idxRes] = await Promise.all([
            client.query(
              "SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
              [schema, table],
            ),
            client.query(
              "SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2",
              [schema, table],
            ),
            client.query(
              "SELECT kcu.column_name, ccu.table_schema AS foreign_table_schema, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2",
              [schema, table],
            ),
            client.query(
              "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname",
              [schema, table],
            ),
          ]);

          const pkColumns = new Set(pkRes.rows.map((r: any) => r.column_name));
          const fkMap = new Map(
            fkRes.rows.map((r: any) => [
              r.column_name,
              `${r.foreign_table_schema}.${r.foreign_table_name}(${r.foreign_column_name})`,
            ]),
          );

          const columns = colsRes.rows.map((col: any) => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === "YES",
            default: col.column_default,
            maxLength: col.character_maximum_length
              ? Number(col.character_maximum_length)
              : null,
            isPrimaryKey: pkColumns.has(col.column_name),
            isForeignKey: fkMap.has(col.column_name),
            foreignKeyRef: fkMap.get(col.column_name) || null,
          }));

          const colDefs = colsRes.rows.map((col: any) => {
            let def = `  "${col.column_name}" ${col.data_type}`;
            if (col.character_maximum_length)
              def += `(${col.character_maximum_length})`;
            if (col.is_nullable === "NO") def += " NOT NULL";
            if (col.column_default) def += ` DEFAULT ${col.column_default}`;
            if (pkColumns.has(col.column_name)) def += " PRIMARY KEY";
            return def;
          });
          const definition = `CREATE TABLE "${schema}"."${table}" (\n${colDefs.join(",\n")}\n);`;
          const indexes = idxRes.rows.map((i: any) => ({
            name: i.indexname,
            definition: i.indexdef + ";",
          }));

          res.json({ success: true, data: { definition, columns, indexes } });
        } finally {
          await close();
        }
        return;
      }

      case "get_view_definition": {
        if (!schema || !name) {
          res.status(400).json({ error: "Schema and view name required" });
          return;
        }
        const { client, close } = await createManagedDatabaseClient();
        try {
          const result = await client.query(
            "SELECT view_definition FROM information_schema.views WHERE table_schema = $1 AND table_name = $2",
            [schema, name],
          );
          if (result.rows.length === 0)
            throw new Error(`View ${schema}.${name} not found`);
          res.json({
            success: true,
            data: {
              definition: `CREATE OR REPLACE VIEW "${schema}"."${name}" AS\n${result.rows[0].view_definition}`,
            },
          });
        } finally {
          await close();
        }
        return;
      }

      case "get_function_definition": {
        if (!schema || !name) {
          res.status(400).json({ error: "Schema and function name required" });
          return;
        }
        const { client, close } = await createManagedDatabaseClient();
        try {
          const result = await client.query(
            "SELECT pg_get_functiondef(p.oid) as definition FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1",
            [schema, name],
          );
          if (result.rows.length === 0)
            throw new Error(`Function ${schema}.${name} not found`);
          res.json({
            success: true,
            data: { definition: result.rows[0].definition },
          });
        } finally {
          await close();
        }
        return;
      }

      default:
        res
          .status(400)
          .json({ success: false, error: `Unknown action: ${action}` });
    }
  } catch (error: any) {
    logger.error("[manage-database] Error:", error.message);
    res.status(400).json({ success: false, error: error.message });
  }
}

/**
 * Database Provisioning Handler — Per-database isolation on Pronghorn Generated Applications server
 *
 * Creates a dedicated database per project on the Pronghorn Generated Applications PostgreSQL server.
 * Each project gets its own database (`proj_{id}`) with pre-installed extensions (`uuid-ossp`,
 * `pgcrypto`) and a dedicated login role with scoped permissions on the `public` schema.
 * Connections are made directly to the project database — no `search_path` switching.
 *
 * @param body.action - One of: create, delete, status, connectionInfo, suspend, resume, restart
 * @param body.databaseId - The `project_databases.id` record to operate on
 * @param body.shareToken - Optional project share token for access control
 *
 * @example
 * // POST /api/functions/render-database
 * // { action: 'create', databaseId: '<uuid>' }
 */
async function handleDatabaseProvisioning(
  req: Request,
  res: Response,
  body: any,
) {
  const { action, databaseId } = body;
  logger.info(
    `[database-provisioning] Action: ${action}, DatabaseId: ${databaseId}`,
  );

  if (!action || !databaseId) {
    res.json({ success: false, error: "action and databaseId are required" });
    return;
  }

  try {
    // Load the database record
    const dbResult = await db.query(
      "SELECT * FROM project_databases WHERE id = $1",
      [databaseId],
    );
    const database = dbResult.rows[0] as ProjectDatabaseRecord;
    if (!database) {
      res.json({ success: false, error: "Database not found" });
      return;
    }

    const projectId = database.project_id;
    const defaultProjectDbName = createDisplayDerivedDatabaseName(
      database.name,
      databaseId,
    );
    const projectDbName =
      database.database_internal_name || defaultProjectDbName;
    const roleName =
      database.database_user || createProjectDatabaseRoleName(databaseId);

    switch (action) {
      case "create": {
        logger.info(
          `[database-provisioning] Creating database: ${projectDbName} on Generated Applications server`,
        );

        // Generate a random password for the project role
        const crypto = await import("crypto");
        const password = crypto.randomBytes(16).toString("hex");

        // Use Pronghorn Generated Applications server connection details
        const pgHost =
          process.env.POSTGRES_GENAPPS_HOST ||
          process.env.POSTGRES_HOST ||
          "localhost";
        const pgPort =
          process.env.POSTGRES_GENAPPS_PORT ||
          process.env.POSTGRES_PORT ||
          "5432";
        const genappsSsl =
          (process.env.POSTGRES_GENAPPS_SSL ?? process.env.POSTGRES_SSL) ===
          "true";

        // Step 1: Create the project database using admin connection on Generated Applications server
        const { getPoolClient, queryWithPoolTarget } =
          await import("../utils/database");
        const adminClient = await getPoolClient({
          database: "postgres",
          server: "genapps",
        });
        let resolvedProjectDbName = projectDbName;
        try {
          if (!database.database_internal_name) {
            const metadataCollision = await db.query(
              "SELECT id FROM project_databases WHERE database_internal_name = $1 AND id <> $2 AND status <> 'deleted' LIMIT 1",
              [projectDbName, databaseId],
            );
            const databaseCollision = await adminClient.query(
              "SELECT 1 FROM pg_database WHERE datname = $1",
              [projectDbName],
            );

            if (
              metadataCollision.rows.length > 0 ||
              databaseCollision.rows.length > 0
            ) {
              resolvedProjectDbName = createDisplayDerivedDatabaseName(
                database.name,
                databaseId,
                true,
              );
              logger.info(
                `[database-provisioning] Database name ${projectDbName} already exists; using ${resolvedProjectDbName}`,
              );
            }
          }

          // CREATE DATABASE cannot run inside a transaction
          await adminClient.query(
            `CREATE DATABASE ${quotePgIdentifier(resolvedProjectDbName, "database name")}`,
          );
          logger.info(
            `[database-provisioning] Database "${resolvedProjectDbName}" created on Generated Applications server`,
          );
        } catch (createErr: any) {
          // Handle 42P04 (duplicate_database) as non-fatal
          if (
            createErr.code === "42P04" &&
            database.database_internal_name === resolvedProjectDbName
          ) {
            logger.info(
              `[database-provisioning] Database "${resolvedProjectDbName}" already exists for this row, continuing`,
            );
          } else {
            throw createErr;
          }
        } finally {
          adminClient.release();
        }

        // Step 2: Connect to the new project database and install extensions
        try {
          await queryWithPoolTarget(
            { database: resolvedProjectDbName, server: "genapps" },
            "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"",
          );
          await queryWithPoolTarget(
            { database: resolvedProjectDbName, server: "genapps" },
            "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"",
          );
        } catch (extErr: any) {
          // Mark as failed if extensions can't be installed
          await db.query(
            "UPDATE project_databases SET status = 'failed', updated_at = NOW() WHERE id = $1",
            [databaseId],
          );
          await db.query(
            `INSERT INTO project_database_connections (project_id, name, description, host, port, database_name, ssl_mode, status, last_error, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'failed', $8, NOW(), NOW())
             ON CONFLICT DO NOTHING`,
            [
              projectId,
              database.name || "Project Database",
              `Auto-provisioned database: ${resolvedProjectDbName}`,
              pgHost,
              parseInt(pgPort),
              resolvedProjectDbName,
              genappsSsl ? "require" : "disable",
              extErr.message,
            ],
          );
          throw extErr;
        }

        // Step 3: Create role and grant permissions on the Generated Applications server
        const roleClient = await getPoolClient({
          database: "postgres",
          server: "genapps",
        });
        try {
          const escapedPassword = roleClient.escapeLiteral(password);
          try {
            await roleClient.query(
              `CREATE ROLE ${quotePgIdentifier(roleName, "role name")} WITH LOGIN PASSWORD ${escapedPassword}`,
            );
          } catch (roleErr: any) {
            if (!roleErr.message?.includes("already exists")) throw roleErr;
            await roleClient.query(
              `ALTER ROLE ${quotePgIdentifier(roleName, "role name")} WITH PASSWORD ${escapedPassword}`,
            );
          }
        } catch (roleGrantErr: any) {
          // Partial failure: DB created but role/grant failed
          await db.query(
            "UPDATE project_databases SET status = 'failed', updated_at = NOW() WHERE id = $1",
            [databaseId],
          );
          await db.query(
            `INSERT INTO project_database_connections (project_id, name, description, host, port, database_name, ssl_mode, status, last_error, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'failed', $8, NOW(), NOW())
             ON CONFLICT DO NOTHING`,
            [
              projectId,
              database.name || "Project Database",
              `Auto-provisioned database: ${resolvedProjectDbName}`,
              pgHost,
              parseInt(pgPort),
              resolvedProjectDbName,
              genappsSsl ? "require" : "disable",
              roleGrantErr.message,
            ],
          );
          throw roleGrantErr;
        } finally {
          roleClient.release();
        }

        // Step 4: Grant permissions to role on the project database's public schema
        try {
          await queryWithPoolTarget(
            { database: resolvedProjectDbName, server: "genapps" },
            `GRANT USAGE ON SCHEMA public TO ${quotePgIdentifier(roleName, "role name")}`,
          );
          await queryWithPoolTarget(
            { database: resolvedProjectDbName, server: "genapps" },
            `GRANT CREATE ON SCHEMA public TO ${quotePgIdentifier(roleName, "role name")}`,
          );
          await queryWithPoolTarget(
            { database: resolvedProjectDbName, server: "genapps" },
            `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${quotePgIdentifier(roleName, "role name")}`,
          );
          await queryWithPoolTarget(
            { database: resolvedProjectDbName, server: "genapps" },
            `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${quotePgIdentifier(roleName, "role name")}`,
          );
          await queryWithPoolTarget(
            { database: resolvedProjectDbName, server: "genapps" },
            `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${quotePgIdentifier(roleName, "role name")}`,
          );
        } catch (grantErr: any) {
          // Partial failure: DB and role created but grants failed
          await db.query(
            "UPDATE project_databases SET status = 'failed', updated_at = NOW() WHERE id = $1",
            [databaseId],
          );
          await db.query(
            `INSERT INTO project_database_connections (project_id, name, description, host, port, database_name, ssl_mode, status, last_error, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'failed', $8, NOW(), NOW())
             ON CONFLICT DO NOTHING`,
            [
              projectId,
              database.name || "Project Database",
              `Auto-provisioned database: ${resolvedProjectDbName}`,
              pgHost,
              parseInt(pgPort),
              resolvedProjectDbName,
              genappsSsl ? "require" : "disable",
              grantErr.message,
            ],
          );
          throw grantErr;
        }

        // Step 5: Build connection string pointing directly to the project database
        const sslParam = genappsSsl ? "?sslmode=require" : "";
        const connectionString = `postgresql://${roleName}:${password}@${pgHost}:${pgPort}/${resolvedProjectDbName}${sslParam}`;

        // Update database record
        await db.query(
          "UPDATE project_databases SET status = 'available', database_internal_name = $1, database_user = $2, dashboard_url = $3, has_connection_info = true, updated_at = NOW() WHERE id = $4",
          [
            resolvedProjectDbName,
            roleName,
            `database:${resolvedProjectDbName}`,
            databaseId,
          ],
        );

        // Create connection entry for the Explorer. The connection STRING itself
        // lives in the project's Key Vault (not Postgres); persist only metadata
        // here, then upsert the secret keyed by the new connection id.
        const connInsert = await db.query(
          `INSERT INTO project_database_connections (project_id, name, description, host, port, database_name, ssl_mode, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'available', NOW(), NOW())
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            projectId,
            database.name || "Project Database",
            `Auto-provisioned database: ${resolvedProjectDbName}`,
            pgHost,
            parseInt(pgPort),
            resolvedProjectDbName,
            genappsSsl ? "require" : "disable",
          ],
        );
        let connId: string | undefined = connInsert.rows[0]?.id;
        if (!connId) {
          const existing = await db.query(
            "SELECT id FROM project_database_connections WHERE project_id = $1 AND database_name = $2 LIMIT 1",
            [projectId, resolvedProjectDbName],
          );
          connId = existing.rows[0]?.id;
        }

        // Persist the connection string (with the role's password) into the
        // central platform Key Vault BEFORE reporting success. The central vault
        // already exists with a working private endpoint, DNS registration, and
        // the API's RBAC grant, so this is a single fast data-plane write — there
        // is no vault-create / private-endpoint / DNS-propagation step to race
        // against (the previous per-project-vault design did, and a container
        // restart mid-provision could silently abandon the write and lose the
        // generated password forever). Awaiting it here guarantees the
        // credential is durably stored, or the operation fails loudly and the
        // records are marked `failed` so the user can retry.
        if (connId) {
          try {
            await setConnectionStringSecret({
              projectId,
              connectionId: connId,
              connectionString,
            });
          } catch (secretErr: any) {
            logger.error(
              `[database-provisioning] Key Vault write failed for database ${resolvedProjectDbName}: ${secretErr.message}`,
            );
            await db.query(
              "UPDATE project_databases SET status = 'failed', updated_at = NOW() WHERE id = $1",
              [databaseId],
            );
            await db.query(
              "UPDATE project_database_connections SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1",
              [connId, secretErr.message],
            );
            broadcast(`database-${projectId}`, "database_refresh", {
              projectId,
            });
            broadcast(`external-db-${projectId}`, "external_db_refresh", {
              projectId,
            });
            res.status(500).json({
              success: false,
              error: `Database created but storing its credentials failed: ${secretErr.message}`,
            });
            break;
          }
        }

        // Credentials are durably stored; the database is fully provisioned.
        broadcast(`database-${projectId}`, "database_refresh", { projectId });
        broadcast(`external-db-${projectId}`, "external_db_refresh", {
          projectId,
        });

        logger.info(
          `[database-provisioning] Database ${resolvedProjectDbName} created successfully`,
        );
        res.json({
          success: true,
          data: {
            databaseName: resolvedProjectDbName,
            status: "available",
            message: `Database "${resolvedProjectDbName}" provisioned successfully`,
          },
        });
        break;
      }

      case "delete": {
        logger.info(
          `[database-provisioning] Deleting database: ${projectDbName} from Generated Applications server`,
        );

        // Drop database with force (terminates active connections) on Generated Applications server
        const { getPoolClient: getDelClient } =
          await import("../utils/database");
        const delClient = await getDelClient({
          database: "postgres",
          server: "genapps",
        });
        try {
          await delClient.query(
            `DROP DATABASE IF EXISTS ${quotePgIdentifier(projectDbName, "database name")} WITH (FORCE)`,
          );
        } finally {
          delClient.release();
        }

        // Drop role from Generated Applications server (roles are server-wide)
        const { queryWithPoolTarget: delQueryWithPoolTarget } =
          await import("../utils/database");
        try {
          await delQueryWithPoolTarget(
            { database: "postgres", server: "genapps" },
            `DROP ROLE IF EXISTS ${quotePgIdentifier(roleName, "role name")}`,
          );
        } catch {}

        // Update database record
        await db.query(
          "UPDATE project_databases SET status = 'deleted', updated_at = NOW() WHERE id = $1",
          [databaseId],
        );

        // Update associated connection record
        await db.query(
          "UPDATE project_database_connections SET status = 'deleted', updated_at = NOW() WHERE project_id = $1 AND database_name = $2",
          [projectId, projectDbName],
        );

        broadcast(`database-${projectId}`, "database_refresh", { projectId });

        res.json({
          success: true,
          data: {
            status: "deleted",
            message: `Database "${projectDbName}" dropped`,
          },
        });
        break;
      }

      case "status": {
        // Check if the project database exists on the Generated Applications server
        const { queryWithPoolTarget: statusQueryWithPoolTarget } =
          await import("../utils/database");
        const dbExistsCheck = await statusQueryWithPoolTarget(
          { database: "postgres", server: "genapps" },
          "SELECT 1 FROM pg_database WHERE datname = $1",
          [projectDbName],
        );
        const exists = dbExistsCheck.rows.length > 0;
        const status = exists
          ? "available"
          : database.status === "pending"
            ? "pending"
            : "deleted";

        // Count tables in the project database's public schema
        let tableCount = 0;
        if (exists) {
          const tableCheck = await statusQueryWithPoolTarget(
            { database: projectDbName, server: "genapps" },
            "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'public'",
          );
          tableCount = parseInt(tableCheck.rows[0]?.count || "0");
        }

        // Update status
        await db.query(
          "UPDATE project_databases SET status = $1, updated_at = NOW() WHERE id = $2",
          [status, databaseId],
        );

        broadcast(`database-${projectId}`, "database_refresh", { projectId });

        res.json({
          success: true,
          data: { status, databaseName: projectDbName, tableCount, exists },
        });
        break;
      }

      case "connectionInfo": {
        if (!database.has_connection_info || database.status !== "available") {
          res.json({
            success: false,
            error:
              'Database not yet provisioned. Click "Create Database" first.',
          });
          return;
        }

        // Check if status is failed — block access
        const connCheck = await db.query(
          "SELECT status, last_error FROM project_database_connections WHERE project_id = $1 AND database_name = $2 LIMIT 1",
          [projectId, projectDbName],
        );
        if (connCheck.rows[0]?.status === "failed") {
          res.json({
            success: false,
            error: `Database provisioning failed: ${connCheck.rows[0]?.last_error || "Unknown error"}. Contact an administrator to retry.`,
          });
          return;
        }

        const pgHost =
          process.env.POSTGRES_GENAPPS_HOST ||
          process.env.POSTGRES_HOST ||
          "localhost";
        const pgPort =
          process.env.POSTGRES_GENAPPS_PORT ||
          process.env.POSTGRES_PORT ||
          "5432";
        const dbName = database.database_internal_name || projectDbName;
        const dbUser = database.database_user || roleName;
        const sslMode =
          (process.env.POSTGRES_GENAPPS_SSL ?? process.env.POSTGRES_SSL) ===
          "true"
            ? "require"
            : "disable";

        // Look up the stored connection string (contains password) from the
        // project's Key Vault, keyed by the connection row's id.
        let storedPassword = "";
        let fullConnectionString = "";
        try {
          const connLookup = await db.query(
            "SELECT id, project_id FROM project_database_connections WHERE project_id = $1 AND database_name = $2 LIMIT 1",
            [projectId, dbName],
          );
          const connRow = connLookup.rows[0];
          const rawCs = connRow
            ? await getConnectionStringSecret({
                projectId: connRow.project_id,
                connectionId: connRow.id,
              })
            : null;
          if (
            rawCs &&
            (rawCs.startsWith("postgresql://") ||
              rawCs.startsWith("postgres://"))
          ) {
            fullConnectionString = rawCs;
            const connUrl = new URL(fullConnectionString);
            storedPassword = decodeURIComponent(connUrl.password);
          }
        } catch (lookupErr: any) {
          logger.warn(
            `[database-provisioning] Could not look up stored connection string: ${lookupErr.message}`,
          );
        }

        // Build connection string if we didn't find a stored one — point to the project database directly
        if (!fullConnectionString) {
          const sslParam = sslMode === "require" ? "?sslmode=require" : "";
          fullConnectionString = `postgresql://${dbUser}@${pgHost}:${pgPort}/${dbName}${sslParam}`;
        }

        const psqlCmd = storedPassword
          ? `PGPASSWORD='${storedPassword}' psql -h ${pgHost} -p ${pgPort} -U ${dbUser} ${dbName}`
          : "";

        res.json({
          success: true,
          data: {
            host: pgHost,
            port: parseInt(pgPort),
            database: dbName,
            schema: "public",
            user: dbUser,
            password: storedPassword,
            connectionString: fullConnectionString,
            externalConnectionString: fullConnectionString,
            psqlCommand: psqlCmd,
            sslMode,
            note: `Connects directly to project database "${dbName}" using the public schema`,
          },
        });
        break;
      }

      case "suspend":
      case "resume":
      case "restart": {
        // Per-database isolation doesn't have lifecycle states — report current status
        res.json({
          success: true,
          data: {
            status: database.status,
            message: `Database-level isolation is always available. Current status: ${database.status}`,
          },
        });
        break;
      }

      default:
        res.json({ success: false, error: `Unknown action: ${action}` });
    }
  } catch (error: any) {
    logger.error("[database-provisioning] Error:", error);
    res.json({
      success: false,
      error: error.message || "Database provisioning failed",
    });
  }
}

/**
 * Generate a signed preview token for the deployment proxy.
 * The token allows unauthenticated iframe access to the proxy route
 * for a limited time (10 minutes).
 */
async function handleDeploymentPreviewToken(
  req: Request,
  res: Response,
  body: any,
) {
  const { deploymentId } = body;
  if (!deploymentId) {
    res.status(400).json({ error: "deploymentId is required" });
    return;
  }

  const { rows } = await db.query(
    "SELECT id FROM project_deployments WHERE id = $1 LIMIT 1",
    [deploymentId],
  );
  if (!rows.length) {
    res.status(404).json({ error: "Deployment not found" });
    return;
  }

  const TOKEN_TTL_MS = 10 * 60 * 1000;
  const SIGNING_SECRET =
    process.env.JWT_SECRET ||
    process.env.POSTGRES_PASSWORD ||
    "pronghorn-preview-signing-key";
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const sig = crypto
    .createHmac("sha256", SIGNING_SECRET)
    .update(`${deploymentId}:${expiresAt}`)
    .digest("hex");
  const token = `${expiresAt}.${sig}`;

  res.json({ token, expiresAt });
}

async function handleDeploymentService(req: Request, res: Response, body: any) {
  // All Docker deployment-service verbs are owned by the action registry
  // (`services/deployment/docker/dockerDeploymentService.ts`). If an
  // unknown verb arrives we surface a 400 directly.
  return dockerDeploymentService.handle(req, res, body, () => {
    const action = body?.action;
    logger.warn(`[deployment-service] Unknown action: ${action}`);
    res
      .status(400)
      .json({ success: false, error: `Unknown action: ${action}` });
  });
}

async function handleAdminManagement(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const { action, email, role } = body;
  logger.info(`Admin management action: ${action}`, { email, role });

  try {
    switch (action) {
      case "list_users": {
        const result = await (async () => {
          const _r = await rpc.getAdminUsers();
          return { rows: _r };
        })();
        res.json({ users: result.rows });
        return;
      }
      case "set_role": {
        if (!email || !role) {
          res.status(400).json({ error: "Email and role are required" });
          return;
        }
        await (async () => {
          await rpc.setUserRoleByEmail(email, role);
          return { rows: [{ result: true }] };
        })();
        res.json({ success: true, message: "Role updated" });
        return;
      }
      case "delete_user": {
        if (!email) {
          res.status(400).json({ error: "Email is required" });
          return;
        }
        await (async () => {
          await rpc.deleteUserByEmail(email);
          return { rows: [{ result: true }] };
        })();
        res.json({ success: true, message: "User deleted" });
        return;
      }
      default:
        res.status(400).json({ error: "Unknown action" });
        return;
    }
  } catch (error: any) {
    logger.error("Admin management error:", error.message);
    res.status(500).json({ error: error.message });
  }
}

async function handleAiPlaceholder(
  req: Request,
  res: Response,
  body: any,
  functionName: string,
) {
  // Route to specific implementations
  if (functionName === "decompose-requirements") {
    return await handleDecomposeRequirements(req, res, body);
  }
  if (functionName === "expand-requirement") {
    return await handleExpandRequirement(req, res, body);
  }
  if (
    functionName === "expand-standards" ||
    functionName === "ai-create-standards"
  ) {
    return await handleExpandStandards(req, res, body);
  }

  res.json({ success: true, message: `${functionName} not implemented` });
}

// ===== expand-requirement =====
async function handleExpandRequirement(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const { requirementId, projectId, shareToken } = body;
  if (!projectId) {
    res.status(400).json({ error: "Project ID is required" });
    return;
  }

  try {
    const { buildEndpointUrl, getDefaultModel } =
      await import("../config/aiModels");

    // Get project for model selection
    const defaultModel = getDefaultModel();
    const modelId = defaultModel.id;

    // Fetch all requirements
    const reqsResult = await (async () => {
      const _r = await rpc.getRequirementsWithToken(projectId, shareToken);
      return { rows: _r };
    })();
    const allRequirements = reqsResult.rows || [];
    const requirement = allRequirements.find(
      (r: any) => r.id === requirementId,
    );
    if (!requirement) throw new Error("Requirement not found");

    // Fetch linked standards
    let standardsContext = "No standards linked yet.";
    try {
      const linkedResult = await (async () => {
        const _r = await rpc.getRequirementStandardsWithToken(
          requirementId,
          shareToken,
        );
        return { rows: _r };
      })();
      const linkedStandards = linkedResult.rows || [];
      if (linkedStandards.length > 0) {
        const details: any[] = [];
        for (const ls of linkedStandards) {
          const stdResult = await db.query(
            "SELECT code, title, description FROM standards WHERE id = $1",
            [ls.standard_id],
          );
          if (stdResult.rows[0]) details.push(stdResult.rows[0]);
        }
        if (details.length > 0) {
          standardsContext = details
            .map((s: any) => `${s.code}: ${s.title}\n${s.description || ""}`)
            .join("\n\n");
        }
      }
    } catch {
      /* ignore */
    }

    // Build tree context
    let treeContext = "Root requirement";
    if (requirement.parent_id) {
      const parent = allRequirements.find(
        (r: any) => r.id === requirement.parent_id,
      );
      if (parent)
        treeContext = `Parent: ${parent.code} - ${parent.title}\n${parent.content || ""}`;
    }

    // Get existing children
    const existingSiblings = allRequirements.filter(
      (r: any) => r.parent_id === requirement.id,
    );
    const existingSiblingsContext =
      existingSiblings.length > 0
        ? `EXISTING CHILDREN (DO NOT DUPLICATE):\n${existingSiblings.map((s: any) => `- ${s.code}: ${s.title}`).join("\n")}`
        : "";

    // Determine child type
    const childTypeMap: Record<string, string> = {
      EPIC: "FEATURE",
      FEATURE: "STORY",
      STORY: "ACCEPTANCE_CRITERIA",
      ACCEPTANCE_CRITERIA: "ACCEPTANCE_CRITERIA",
    };
    const childType = childTypeMap[requirement.type] || "STORY";

    const systemPrompt = `You are an expert requirements engineer. Your task is to expand a requirement into detailed sub-requirements.
CRITICAL: Respond ONLY with valid JSON. No prose, no markdown.
Generate 4-8 logical, comprehensive sub-requirements. Each should have title, content, and type "${childType}".
For STORIES, use: "As a [role], I want to [action] so that [benefit]"
For ACCEPTANCE_CRITERIA, use: "Given [context], when [action], then [outcome]"`;

    const userPrompt = `REQUIREMENT TO EXPAND:
Code: ${requirement.code}
Type: ${requirement.type}
Title: ${requirement.title}
Content: ${requirement.content || "No detailed content"}

PARENT CONTEXT:
${treeContext}

LINKED STANDARDS:
${standardsContext}

${existingSiblingsContext}

Return JSON: { "sub_requirements": [{ "title": "...", "content": "...", "type": "${childType}" }] }`;

    const endpoint = buildEndpointUrl(modelId);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 8192,
        temperature: 0.7,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API error: ${response.status} ${errorText}`);
    }

    const aiData = (await response.json()) as any;
    const content = aiData.choices?.[0]?.message?.content || "{}";
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Try extracting JSON from markdown
      const match = content.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { sub_requirements: [] };
    }

    const suggestions = Array.isArray(parsed.sub_requirements)
      ? parsed.sub_requirements
      : [];
    logger.info(
      `[expand-requirement] Parsed ${suggestions.length} sub-requirements`,
    );

    // Insert new requirements
    const inserted: any[] = [];
    for (const s of suggestions) {
      const insertResult = await (async () => {
        const _r = await rpc.insertRequirementWithToken(
          projectId,
          shareToken,
          requirementId,
          childType,
          s.title,
        );
        return { rows: _r ? [_r] : [] };
      })();
      const newReq = insertResult.rows[0];
      if (newReq && s.content) {
        await (async () => {
          const _r = await rpc.updateRequirementWithToken(
            newReq.id,
            shareToken,
            s.title,
            s.content,
          );
          return { rows: _r ? [_r] : [] };
        })();
      }
      if (newReq) inserted.push(newReq);
    }

    // Broadcast requirements refresh to subscribers
    broadcast(`requirements-${projectId}`, "requirements_refresh", {
      action: "expanded",
      count: inserted.length,
    });

    res.json({
      success: true,
      requirements: inserted,
      count: inserted.length,
      model: modelId,
    });
  } catch (error: any) {
    logger.error("[expand-requirement] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
}

// ===== expand-standards =====
async function handleExpandStandards(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const { standardId, projectId } = body;
  if (!standardId) {
    res.status(400).json({ error: "Standard ID is required" });
    return;
  }

  try {
    const { buildEndpointUrl, getDefaultModel } =
      await import("../config/aiModels");
    const defaultModel = getDefaultModel();

    // Fetch the standard
    const stdResult = await db.query("SELECT * FROM standards WHERE id = $1", [
      standardId,
    ]);
    const standard = stdResult.rows[0];
    if (!standard) throw new Error("Standard not found");

    // Fetch siblings/context
    const allResult = await db.query(
      "SELECT * FROM standards WHERE category_id = $1 ORDER BY created_at",
      [standard.category_id],
    );
    const allStandards = allResult.rows || [];

    // Build tree context
    let treeContext = `Current Standard: ${standard.code} - ${standard.title}\n`;
    if (standard.parent_id) {
      const parent = allStandards.find((s: any) => s.id === standard.parent_id);
      if (parent) treeContext += `Parent: ${parent.code} - ${parent.title}\n`;
    }
    const siblings = allStandards.filter(
      (s: any) => s.parent_id === standard.parent_id && s.id !== standardId,
    );
    if (siblings.length > 0)
      treeContext += `\nSiblings:\n${siblings.map((s: any) => `  - ${s.code}: ${s.title}`).join("\n")}`;
    const children = allStandards.filter(
      (s: any) => s.parent_id === standardId,
    );
    if (children.length > 0)
      treeContext += `\n\nExisting Children:\n${children.map((s: any) => `  - ${s.code}: ${s.title}`).join("\n")}`;

    const prompt = `You are a standards development expert. Expand the following standard into detailed sub-standards.

STANDARD TO EXPAND:
Code: ${standard.code}
Title: ${standard.title}
Description: ${standard.description || "No description"}
Content: ${standard.content || "No detailed content"}

PARENT CONTEXT:
${treeContext}

Generate 3-7 logical sub-standards. Return ONLY JSON array:
[{ "title": "Sub-standard title", "description": "Brief description", "content": "Detailed content" }]`;

    const endpoint = buildEndpointUrl(defaultModel.id);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "You are a standards development expert. Return only valid JSON arrays.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 4096,
        temperature: 0.7,
      }),
    });

    if (!response.ok) throw new Error(`AI API error: ${response.status}`);

    const aiData = (await response.json()) as any;
    const textResponse = aiData.choices?.[0]?.message?.content || "";
    const jsonMatch = textResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("Could not extract JSON from AI response");

    const suggestions = JSON.parse(jsonMatch[0]);

    // Insert sub-standards
    const newStandards = suggestions.map((s: any, i: number) => ({
      category_id: standard.category_id,
      parent_id: standardId,
      title: s.title,
      description: s.description || null,
      content: s.content || null,
      code: `${standard.code}-${String(i + 1).padStart(3, "0")}`,
      order_index: i,
      org_id: standard.org_id,
      is_system: false,
    }));

    const insertedStandards: any[] = [];
    for (const ns of newStandards) {
      const insertResult = await db.query(
        `INSERT INTO standards (category_id, parent_id, title, description, content, code, order_index, org_id, is_system)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          ns.category_id,
          ns.parent_id,
          ns.title,
          ns.description,
          ns.content,
          ns.code,
          ns.order_index,
          ns.org_id,
          ns.is_system,
        ],
      );
      if (insertResult.rows[0]) insertedStandards.push(insertResult.rows[0]);
    }

    // Broadcast standards refresh to subscribers
    if (projectId)
      broadcast(`project-standards-${projectId}`, "project_standards_refresh", {
        action: "expanded",
        count: insertedStandards.length,
      });

    res.json({ standards: insertedStandards });
  } catch (error: any) {
    logger.error("[expand-standards] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
}

async function handleDecomposeRequirements(
  req: Request,
  res: Response,
  body: any,
) {
  const { text, projectId, attachedContext } = body;

  if (!projectId) {
    res.status(400).json({ error: "Project ID is required" });
    return;
  }

  if (!text?.trim() && !attachedContext) {
    res.status(400).json({ error: "Text or project context is required" });
    return;
  }

  try {
    // Enrich artifact content from blob storage
    const resolvedContext = attachedContext
      ? await resolveAttachedContext(attachedContext, projectId)
      : null;

    // Build the prompt with context
    let contextInfo = "";
    if (resolvedContext) {
      if (resolvedContext.projectMetadata) {
        contextInfo += `\nProject: ${resolvedContext.projectMetadata.name}\nDescription: ${resolvedContext.projectMetadata.description || "N/A"}\n`;
      }
      if (resolvedContext.artifacts?.length) {
        contextInfo += `\nProject Artifacts (documents):\n${resolvedContext.artifacts
          .map((a: any) => {
            const title = a.ai_title || "Untitled";
            const content = a.content || a.ai_summary || "";
            return `- ${title}:\n${content}`;
          })
          .join("\n\n")}\n`;
      }
      if (resolvedContext.requirements?.length) {
        contextInfo += `\nExisting Requirements (DO NOT DUPLICATE):\n${resolvedContext.requirements.map((r: any) => `- [${r.type}] ${r.title}: ${r.content || ""}`).join("\n")}\n`;
      }
      if (resolvedContext.standards?.length) {
        contextInfo += `\nStandards to follow:\n${resolvedContext.standards.map((s: any) => `- ${s.code || s.name}: ${s.title || ""} - ${s.description || ""}`).join("\n")}\n`;
      }
      if (resolvedContext.techStacks?.length) {
        contextInfo += `\nTech Stack:\n${resolvedContext.techStacks.map((t: any) => `- ${t.name}: ${t.description || ""}`).join("\n")}\n`;
      }
      if (resolvedContext.canvasNodes?.length) {
        contextInfo += `\nArchitecture (Canvas Nodes):\n${resolvedContext.canvasNodes.map((n: any) => `- [${n.type}] ${n.data?.label || n.data?.title || "unnamed"}`).join("\n")}\n`;
      }
      if (resolvedContext.chatSessions?.length) {
        contextInfo += `\nChat Sessions:\n${resolvedContext.chatSessions
          .map((s: any) => {
            const msgs = (s.messages || [])
              .map((m: any) => `  [${m.role}]: ${m.content}`)
              .join("\n");
            return `- Session: ${s.title || "Untitled"}\n${msgs}`;
          })
          .join("\n\n")}\n`;
      }
      if (resolvedContext.files?.length) {
        contextInfo += `\nRepository Files:\n${resolvedContext.files.map((f: any) => `--- ${f.path} ---\n${f.content || ""}`).join("\n\n")}\n`;
      }
      if (resolvedContext.databases?.length) {
        contextInfo += `\nDatabase Schemas:\n${resolvedContext.databases.map((d: any) => `- ${(d.type || "").toUpperCase()}: ${d.schemaName || ""}.${d.name || ""}${d.definition ? `\n${d.definition}` : ""}`).join("\n\n")}\n`;
      }
    }

    const systemPrompt = `You are a requirements analyst. Decompose the given text into a hierarchical structure of requirements.

Create Epics (high-level themes), Features (mid-level capabilities), and Stories (detailed requirements).

Output ONLY valid JSON in this exact format:
{
  "epics": [
    {
      "title": "Epic title",
      "description": "Epic description",
      "features": [
        {
          "title": "Feature title", 
          "description": "Feature description",
          "stories": [
            {
              "title": "Story title",
              "description": "As a [user], I want [goal] so that [benefit]",
              "acceptance_criteria": "Given/When/Then criteria"
            }
          ]
        }
      ]
    }
  ]
}

Rules:
- Each Epic should have 1-3 Features
- Each Feature should have 2-5 Stories
- Stories should follow user story format
- Include acceptance criteria for each story
- Be specific and actionable`;

    const userPrompt = contextInfo
      ? `Context:\n${contextInfo}\n\nText to decompose:\n${text || "Use the context to generate requirements"}`
      : `Decompose this text into requirements:\n\n${text}`;

    // Call Azure OpenAI via APIM
    const { getDefaultModel, buildEndpointUrl } =
      await import("../config/aiModels");
    const defaultModel = getDefaultModel();
    const endpoint = buildEndpointUrl(defaultModel.id);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 8192,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`AI decompose error: ${response.status} - ${errorText}`);
      throw new Error(`AI service error: ${response.status}`);
    }

    const aiResult = (await response.json()) as any;
    const content = aiResult.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No response from AI");
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      logger.error("Failed to parse AI response:", content);
      throw new Error("Invalid AI response format");
    }

    if (!parsed.epics || !Array.isArray(parsed.epics)) {
      throw new Error("AI response missing epics array");
    }

    // Save to database
    const db = (await import("../utils/database")).default;
    let epicCount = 0;
    let requirementCount = 0;

    for (const epic of parsed.epics) {
      // Get next order index for top-level
      const orderResult = await db.query(
        "SELECT COALESCE(MAX(order_index), -1) + 1 as next_order FROM requirements WHERE project_id = $1 AND parent_id IS NULL",
        [projectId],
      );
      const epicOrder = orderResult.rows[0]?.next_order || 0;

      // Insert Epic
      const epicResult = await db.query(
        `INSERT INTO requirements (project_id, parent_id, type, title, content, order_index, created_at, updated_at)
         VALUES ($1, NULL, 'EPIC', $2, $3, $4, NOW(), NOW())
         RETURNING id`,
        [projectId, epic.title, epic.description || null, epicOrder],
      );
      const epicId = epicResult.rows[0].id;
      epicCount++;
      requirementCount++;

      if (epic.features) {
        let featureOrder = 0;
        for (const feature of epic.features) {
          // Insert Feature
          const featureResult = await db.query(
            `INSERT INTO requirements (project_id, parent_id, type, title, content, order_index, created_at, updated_at)
             VALUES ($1, $2, 'FEATURE', $3, $4, $5, NOW(), NOW())
             RETURNING id`,
            [
              projectId,
              epicId,
              feature.title,
              feature.description || null,
              featureOrder++,
            ],
          );
          const featureId = featureResult.rows[0].id;
          requirementCount++;

          if (feature.stories) {
            let storyOrder = 0;
            for (const story of feature.stories) {
              // Insert Story
              const storyContent = story.acceptance_criteria
                ? `${story.description}\n\nAcceptance Criteria:\n${story.acceptance_criteria}`
                : story.description;

              await db.query(
                `INSERT INTO requirements (project_id, parent_id, type, title, content, order_index, created_at, updated_at)
                 VALUES ($1, $2, 'STORY', $3, $4, $5, NOW(), NOW())`,
                [
                  projectId,
                  featureId,
                  story.title,
                  storyContent || null,
                  storyOrder++,
                ],
              );
              requirementCount++;
            }
          }
        }
      }
    }

    logger.info(
      `Decomposed requirements: ${epicCount} epics, ${requirementCount} total items for project ${projectId}`,
    );

    // Broadcast requirements refresh to subscribers
    broadcast(`project-${projectId}-requirements`, "requirements_refresh", {
      action: "decomposed",
      epicCount,
      requirementCount,
    });

    res.json({
      success: true,
      epicCount,
      requirementCount,
      message: `Created ${epicCount} epics with ${requirementCount} total requirements`,
    });
  } catch (error) {
    logger.error("Decompose requirements error:", error);
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to decompose requirements",
    });
  }
}

async function handleAuditOrchestrator(req: Request, res: Response, body: any) {
  const { action } = body;
  logger.info(`Audit orchestrator: ${action}`);
  res.json({ success: true, action });
}

async function handleCodingAgentOrchestrator(
  req: Request,
  res: Response,
  body: any,
) {
  const {
    projectId,
    repoId,
    shareToken,
    taskDescription,
    selectedModel,
    maxTokens = 16384,
    chatHistory: chatHistoryRaw,
    sessionId: existingSessionId,
    iteration: requestedIteration = 1,
    exposeProject = false,
    attachedContext,
    attachedFiles = [],
    maxIterations: requestedMaxIterations = 100,
    autoCommit = false,
    projectContext,
  } = body;

  if (!projectId || !repoId) {
    res.status(400).json({ error: "projectId and repoId are required" });
    return;
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const sendSSE = (eventType: string, data: any) => {
    try {
      res.write(`data: ${JSON.stringify({ type: eventType, ...data })}\n\n`);
    } catch (e) {
      logger.error("[coding-agent] SSE write failed:", e);
    }
  };

  const isNewSession = !existingSessionId;
  const iteration = requestedIteration;
  const MAX_ITERATIONS = Math.min(Math.max(requestedMaxIterations, 1), 500);

  try {
    const { buildEndpointUrl, getDefaultModel, getModelConfig } =
      await import("../config/aiModels");
    const modelConfig = getModelConfig(selectedModel) || getDefaultModel();

    // Validate access
    const roleResult = await (async () => {
      const _role = await rpc.authorizeProjectAccess(
        projectId,
        shareToken || null,
      );
      return { rows: [{ role: _role }] };
    })();
    const role = roleResult.rows[0]?.role;
    if (!role || (role !== "owner" && role !== "editor")) {
      sendSSE("error", { error: "Editor role required" });
      res.end();
      return;
    }

    // Create or resume session
    let sessionId = existingSessionId;
    let session: any = null;

    if (isNewSession) {
      const sessResult = await (async () => {
        const _r = await rpc.createAgentSessionWithToken(
          projectId,
          shareToken || null,
          repoId,
          taskDescription,
          "coding",
        );
        return _r;
      })();
      sessionId = sessResult?.id || sessResult;
      session = sessResult;

      // Log user's task as first message
      try {
        await rpc.insertAgentMessageWithToken(
          sessionId,
          shareToken || null,
          "user",
          taskDescription || "",
          JSON.stringify({ attachedFiles, projectContext: attachedContext }),
        );
      } catch {}

      logger.info(`[coding-agent] Created new session: ${sessionId}`);
    } else {
      // Load existing session
      try {
        const sessResult = await db.query(
          "SELECT * FROM agent_sessions WHERE id = $1",
          [sessionId],
        );
        session = sessResult.rows[0];
        if (!session) throw new Error("Session not found");
        if (session.abort_requested || session.status === "aborted") {
          sendSSE("error", {
            error: "Session was aborted",
            status: "aborted",
            sessionId,
          });
          res.end();
          return;
        }
      } catch (e: any) {
        sendSSE("error", { error: `Failed to load session: ${e.message}` });
        res.end();
        return;
      }
      logger.info(`[coding-agent] Loaded existing session: ${sessionId}`);
    }

    // Send session info immediately
    sendSSE("session_created", { sessionId, iteration, isNewSession });

    // Build instruction manifest
    let manifest = "";
    try {
      const fs = await import("fs");
      const path = await import("path");
      const manifestPath = path.default.resolve(
        __dirname,
        "../../public/data/codingAgentToolsManifest.json",
      );
      manifest = fs.default.readFileSync(manifestPath, "utf8");
    } catch {
      manifest =
        '{"tools": ["list_files","read_file","edit_lines","create_file","delete_file","move_file","search","wildcard_search","get_staged_changes","unstage_file","discard_all_staged"]}';
    }

    let instructions = "";
    try {
      const fs = await import("fs");
      const path = await import("path");
      const instrPath = path.default.resolve(
        __dirname,
        "../../public/data/codingAgentInstructions.json",
      );
      const instrData = JSON.parse(fs.default.readFileSync(instrPath, "utf8"));
      instructions = instrData.content || JSON.stringify(instrData);
    } catch {
      instructions =
        "You are an AI coding agent. You can read, edit, create, and delete files.";
    }

    // Enrich artifact content from blob storage
    const resolvedCtx = attachedContext
      ? await resolveAttachedContext(attachedContext, projectId)
      : null;

    // Build project context
    let contextSummary = "";
    const ctx = resolvedCtx || projectContext || {};
    if (isNewSession && (exposeProject || Object.keys(ctx).length > 0)) {
      const parts: string[] = [];

      if (ctx.projectMetadata) {
        const meta = ctx.projectMetadata;
        parts.push(
          `Project: ${meta.name || ""}\n${meta.description ? `Description: ${meta.description}` : ""}`,
        );
      }
      if (ctx.artifacts?.length > 0) {
        const artifactDetails = ctx.artifacts
          .map((a: any) => {
            const title = a.ai_title || a.title || "Untitled";
            const summary = a.ai_summary || "";
            const content = a.content || "";
            if (content) {
              return `### ${title}\n${summary ? `Summary: ${summary}\n` : ""}Content:\n${content}`;
            }
            return `- ${title}: ${summary.substring(0, 160)}`;
          })
          .join("\n\n");
        parts.push(
          `Artifacts (${ctx.artifacts.length} total):\n${artifactDetails}`,
        );
      }
      if (ctx.requirements?.length > 0) {
        const preview = ctx.requirements
          .slice(0, 10)
          .map(
            (r: any) =>
              `- ${r.code || ""} ${r.title}: ${(r.content || "").substring(0, 160)}`,
          )
          .join("\n");
        parts.push(
          `Requirements (${ctx.requirements.length} total):\n${preview}`,
        );
      }
      if (ctx.standards?.length > 0) {
        const allStandards = ctx.standards
          .map((s: any) => {
            let str = `### STANDARD: ${s.code || "STD"} - ${s.title || "Untitled"}`;
            if (s.description) str += `\n**Description:** ${s.description}`;
            if (s.content) str += `\n\n**Content:**\n${s.content}`;
            if (s.long_description && s.long_description !== s.content)
              str += `\n\n**Extended:**\n${s.long_description}`;
            return str;
          })
          .join("\n\n---\n\n");
        parts.push(
          `Standards (${ctx.standards.length} attached - FULL CONTENT):\n\n${allStandards}`,
        );
      }
      if (ctx.techStacks?.length > 0) {
        const allStacks = ctx.techStacks
          .map(
            (t: any) =>
              `### ${t.name}${t.type ? ` [${t.type}]` : ""}${t.version ? ` v${t.version}` : ""}${t.description ? `\n${t.description}` : ""}${t.long_description ? `\n\n${t.long_description}` : ""}`,
          )
          .join("\n\n---\n\n");
        parts.push(
          `Tech Stacks (${ctx.techStacks.length} attached):\n\n${allStacks}`,
        );
      }
      if (ctx.canvasNodes?.length > 0) {
        const preview = ctx.canvasNodes
          .slice(0, 20)
          .map(
            (n: any) =>
              `- [${(n.data || {}).type || n.type || "node"}] ${(n.data || {}).label || n.id}`,
          )
          .join("\n");
        parts.push(
          `Canvas Nodes (${ctx.canvasNodes.length} total):\n${preview}`,
        );
      }
      if (ctx.canvasEdges?.length > 0) {
        const preview = ctx.canvasEdges
          .slice(0, 20)
          .map(
            (e: any) =>
              `- ${e.source_id} -> ${e.target_id}${e.label ? ` (${e.label})` : ""}`,
          )
          .join("\n");
        parts.push(
          `Canvas Edges (${ctx.canvasEdges.length} total):\n${preview}`,
        );
      }
      if (ctx.files?.length > 0) {
        const allFiles = ctx.files
          .map(
            (f: any) =>
              `### FILE: ${f.path}\n\`\`\`\n${f.content || ""}\n\`\`\``,
          )
          .join("\n\n");
        parts.push(
          `Repository Files (${ctx.files.length} attached):\n\n${allFiles}`,
        );
      }
      if (ctx.databases?.length > 0) {
        const dbItems = ctx.databases
          .map(
            (d: any) =>
              `### ${(d.type || "").toUpperCase()}: ${d.schemaName || ""}.${d.name || ""}${d.definition ? `\n\`\`\`sql\n${d.definition}\n\`\`\`` : ""}`,
          )
          .join("\n\n");
        parts.push(
          `Database Schemas (${ctx.databases.length} items):\n\n${dbItems}`,
        );
      }

      if (ctx.standards?.length > 0) {
        parts.push(
          `\n⚠️ REMINDER: ${ctx.standards.length} MANDATORY STANDARD(S) attached. Follow them exactly.`,
        );
      }

      contextSummary = parts.join("\n\n");
    }

    // Build attached files section
    let attachedFilesSection = "";
    if (isNewSession && attachedFiles?.length > 0) {
      const attachedList = attachedFiles
        .map((f: any) => `- ${f.path} (file_id: ${f.id})`)
        .join("\n");
      attachedFilesSection = `\n\n🔗 USER HAS ATTACHED ${attachedFiles.length} FILE(S):\n${attachedList}\n\nUse read_file directly with these IDs.`;
    }

    // Build chat history section
    let chatHistorySection = "";
    if (
      isNewSession &&
      chatHistoryRaw &&
      typeof chatHistoryRaw === "string" &&
      chatHistoryRaw.trim()
    ) {
      chatHistorySection = `\n\n📜 RECENT CONVERSATION:\n${chatHistoryRaw}\n--- END ---`;
    }

    // Fetch blackboard entries
    let blackboardSummary = "";
    try {
      const bbResult = await db.query(
        "SELECT entry_type, content FROM agent_blackboard WHERE session_id = $1 ORDER BY created_at DESC LIMIT 10",
        [sessionId],
      );
      if (bbResult.rows.length > 0) {
        blackboardSummary = bbResult.rows
          .reverse()
          .map((e: any) => `[${e.entry_type}] ${e.content}`)
          .join("\n");
      }
    } catch {}

    // Build system prompt
    const systemPrompt = [
      instructions,
      `\n\nAVAILABLE TOOLS:\n${manifest}`,
      contextSummary ? `\n\nPROJECT CONTEXT:\n${contextSummary}` : "",
      attachedFilesSection,
      chatHistorySection,
      blackboardSummary
        ? `\n\n=== YOUR WORKING MEMORY ===\n${blackboardSummary}\n=== END MEMORY ===`
        : "",
      `\n\nCurrent iteration: ${iteration} of ${MAX_ITERATIONS}`,
      `\nAuto-commit mode: ${autoCommit}`,
      '\n\nIMPORTANT: Always respond in valid JSON format with { "reasoning": "...", "operations": [...], "status": "in_progress"|"completed", "blackboard_entry": { "entry_type": "...", "content": "..." } }',
    ]
      .filter(Boolean)
      .join("");

    // Build conversation history from DB for continuations
    const conversationHistory: { role: string; content: string }[] = [];

    if (!isNewSession) {
      // Add original task
      if (session?.task_description) {
        conversationHistory.push({
          role: "user",
          content: `Task: ${session.task_description}`,
        });
      }
      // Load previous messages from DB
      try {
        const prevMsgs = await db.query(
          "SELECT role, content, metadata FROM agent_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 50",
          [sessionId],
        );
        for (const msg of prevMsgs.rows) {
          if (msg.role === "user") {
            conversationHistory.push({ role: "user", content: msg.content });
          } else if (msg.role === "assistant" || msg.role === "agent") {
            conversationHistory.push({
              role: "assistant",
              content: msg.content,
            });
          } else if (msg.role === "system") {
            const meta =
              typeof msg.metadata === "string"
                ? JSON.parse(msg.metadata)
                : msg.metadata;
            if (meta?.type === "operation_results") {
              conversationHistory.push({ role: "user", content: msg.content });
            }
          }
        }
      } catch {}
      logger.info(
        `[coding-agent] Loaded ${conversationHistory.length} messages from DB for continuation`,
      );
    } else {
      conversationHistory.push({
        role: "user",
        content: `Task: ${taskDescription || ""}`,
      });
    }

    // Session file registry
    type SessionFileState = {
      id?: string;
      content: string | null;
      isNew: boolean;
      operationType?: string;
      oldPath?: string | null;
    };
    const sessionFileRegistry = new Map<string, SessionFileState>();

    // Robust JSON parser
    function parseAgentResponse(text: string): any {
      const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch)
        try {
          return JSON.parse(jsonMatch[1]);
        } catch {}
      try {
        return JSON.parse(text);
      } catch {}
      let bc = 0,
        si = -1;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "{") {
          if (bc === 0) si = i;
          bc++;
        } else if (text[i] === "}") {
          bc--;
          if (bc === 0 && si !== -1)
            try {
              return JSON.parse(text.substring(si, i + 1));
            } catch {
              si = -1;
            }
        }
      }
      return {
        operations: [],
        status: "error",
        message: "Failed to parse",
        reasoning: text.substring(0, 500),
      };
    }

    const knownOperationTypes = new Set([
      "list_files",
      "search",
      "wildcard_search",
      "read_file",
      "edit_lines",
      "create_file",
      "delete_file",
      "move_file",
      "get_staged_changes",
      "unstage_file",
      "discard_all_staged",
      "project_inventory",
    ]);

    /**
     * Normalizes AI tool calls into the internal `{ type, params }` operation shape.
     *
     * @example
     * normalizeAgentOperation({ create_file: 'src/app.ts', content: 'export {}' });
     */
    function normalizeAgentOperation(operation: any): any | null {
      if (!operation || typeof operation !== "object") {
        return null;
      }

      if (!operation.type && operation.operation) {
        operation.type = operation.operation;
      }

      if (!operation.type) {
        const operationKey = Object.keys(operation).find((key) =>
          knownOperationTypes.has(key),
        );
        if (operationKey) {
          const { params, ...rest } = operation;
          operation.type = operationKey;
          operation.params = {
            ...(params && typeof params === "object" ? params : {}),
            ...rest,
          };
          delete operation.params[operationKey];
          const operationValue = operation[operationKey];
          if (typeof operationValue === "string" && operationValue.length > 0) {
            operation.params.path = operation.params.path || operationValue;
          }
        }
      }

      if (!operation.params) {
        const paramlessOps = [
          "list_files",
          "get_staged_changes",
          "discard_all_staged",
          "project_inventory",
        ];
        if (paramlessOps.includes(operation.type)) {
          operation.params = {};
        } else {
          const { type, operation: operationName, ...rest } = operation;
          if (Object.keys(rest).length > 0) {
            operation.params = rest;
          } else {
            return null;
          }
        }
      }

      if (operation.params && !operation.params.path) {
        const topLevelPath =
          operation.file_path ||
          operation.file ||
          operation.file_name ||
          operation.filename ||
          operation.filepath;
        if (topLevelPath) operation.params.path = topLevelPath;
      }

      if (!operation.type) {
        return null;
      }

      return operation;
    }

    // File resolution helper
    async function resolveFile(filePath: string) {
      if (sessionFileRegistry.has(filePath)) {
        const reg = sessionFileRegistry.get(filePath)!;
        if (reg.operationType === "delete") {
          return null;
        }
        return {
          id: reg.id,
          path: filePath,
          content: reg.content || "",
          source: "registry",
          isNew: reg.isNew,
          operationType: reg.operationType,
        };
      }
      const stagingResult = await (async () => {
        const _r = await rpc.getStagedFileWithToken(
          repoId,
          filePath,
          shareToken || null,
        );
        return { rows: _r ? [_r] : [] };
      })();
      if (stagingResult.rows[0]) {
        const sf = stagingResult.rows[0];
        // sf.content is blob-backed (populated by getStagedFileWithToken); new_content is always null post-refactor
        return {
          id: sf.id,
          path: filePath,
          content: sf.content ?? "",
          source: "staging",
          isNew: sf.operation_type === "create",
          operationType: sf.operation_type,
        };
      }
      const fileResult = await (async () => {
        const _r = await rpc.getRepoFileByPathWithToken(
          repoId,
          filePath,
          shareToken || null,
        );
        return { rows: _r ? [_r] : [] };
      })();
      if (fileResult.rows[0]) {
        // Read committed content from blob storage (repo_files row is metadata-only)
        const committedContent = await getRepoBlobStore().readCommitted(
          projectId,
          repoId,
          filePath,
        );
        if (committedContent === null) {
          return null;
        }
        return {
          id: fileResult.rows[0].id,
          path: filePath,
          content: committedContent,
          source: "repo",
          isNew: false,
          operationType: "modify",
        };
      }
      return null;
    }

    // === SINGLE ITERATION ===
    logger.info(`[coding-agent] === Iteration ${iteration} ===`);

    // Call AI with streaming
    const endpoint = buildEndpointUrl(modelConfig.id);
    logger.info(`[coding-agent] Calling AI at: ${endpoint}`);

    const aiMessages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
    ];

    let aiRespRaw: globalThis.Response;
    try {
      aiRespRaw = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: aiMessages,
          max_tokens: Math.min(maxTokens, 16384),
          response_format: { type: "json_object" },
          stream: true,
        }),
      });
    } catch (fetchErr: any) {
      throw new Error(`AI fetch failed: ${fetchErr?.message || fetchErr}`);
    }

    if (!aiRespRaw.ok) {
      const errBody = await aiRespRaw.text().catch(() => "unable to read body");
      logger.error(
        `[coding-agent] AI returned ${aiRespRaw.status}: ${errBody.substring(0, 500)}`,
      );
      throw new Error(`AI API Error ${aiRespRaw.status}`);
    }

    // Stream AI response tokens to client
    let rawOutputText = "";
    const aiReader = aiRespRaw.body?.getReader();
    if (aiReader) {
      const decoder = new TextDecoder();
      let textBuffer = "";

      while (true) {
        const { done, value } = await aiReader.read();
        if (done) break;

        textBuffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;

        while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta?.content || "";
            if (delta) {
              rawOutputText += delta;
              sendSSE("llm_streaming", {
                iteration,
                charsReceived: rawOutputText.length,
                delta,
              });
            }
          } catch {}
        }
      }
      aiReader.releaseLock();
    } else {
      // Non-streaming fallback
      const aiData = (await aiRespRaw.json()) as any;
      rawOutputText = aiData.choices?.[0]?.message?.content || "";
    }

    sendSSE("llm_complete", { iteration, totalChars: rawOutputText.length });
    logger.info(
      `[coding-agent] AI responded, content length: ${rawOutputText.length}`,
    );

    // Log to agent_llm_logs
    try {
      await db.query(
        "INSERT INTO agent_llm_logs (session_id, project_id, iteration, model, input_prompt, input_char_count, output_raw, output_char_count, was_parse_success, api_response_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        [
          sessionId,
          projectId,
          iteration,
          modelConfig.id,
          systemPrompt.substring(0, 50000),
          systemPrompt.length,
          rawOutputText,
          rawOutputText.length,
          true,
          200,
        ],
      );
    } catch (llmLogErr: any) {
      logger.warn(
        `[coding-agent] LLM log insert failed (non-fatal): ${llmLogErr?.message || llmLogErr}`,
      );
    }

    // Parse response
    const parsed = parseAgentResponse(rawOutputText);
    logger.info(
      `[coding-agent] Parsed. Operations: ${parsed.operations?.length || 0}, Status: ${parsed.status || "unknown"}`,
    );
    if (parsed.operations?.length > 0) {
      logger.info(
        `[coding-agent] First operation: ${JSON.stringify(parsed.operations[0]).substring(0, 300)}`,
      );
    }

    // Handle blackboard entry
    if (parsed.blackboard_entry) {
      const validTypes = [
        "planning",
        "progress",
        "decision",
        "reasoning",
        "next_steps",
        "reflection",
      ];
      let entryType = parsed.blackboard_entry.entry_type || "progress";
      if (!validTypes.includes(entryType)) entryType = "progress";
      try {
        await db.query(
          "INSERT INTO agent_blackboard (session_id, entry_type, content) VALUES ($1, $2, $3)",
          [sessionId, entryType, parsed.blackboard_entry.content || ""],
        );
      } catch {}
    }

    // Log agent message
    try {
      await rpc.insertAgentMessageWithToken(
        sessionId,
        shareToken || null,
        "agent",
        rawOutputText,
        JSON.stringify({
          reasoning: parsed.reasoning,
          status: parsed.status,
          iteration,
        }),
      );
    } catch (msgErr: any) {
      logger.warn(
        `[coding-agent] Agent message insert failed: ${msgErr?.message || msgErr}`,
      );
    }

    // Broadcast message refresh
    broadcast(
      `agent-messages-project-${projectId}-coding`,
      "agent_message_refresh",
      { sessionId, iteration },
    );

    // Execute operations
    const operations = parsed.operations || [];
    const operationResults: any[] = [];
    let filesChanged = false;

    // Sort edit_lines back-to-front per file
    const sortedOps = [...operations];
    const editGroups = new Map<string, any[]>();
    const nonEditOps: any[] = [];
    for (const rawOperation of sortedOps) {
      const op = normalizeAgentOperation(rawOperation);
      if (!op) {
        logger.warn(
          `[coding-agent] Skipping operation with no params: ${JSON.stringify(rawOperation)}`,
        );
        continue;
      }
      if (!op.type) {
        logger.warn(
          `[coding-agent] Skipping invalid operation (no type): ${JSON.stringify(op)}`,
        );
        continue;
      }
      logger.info(
        `[coding-agent] Operation: ${op.type}, params keys: ${Object.keys(op.params || {}).join(",")}`,
      );
      if (op.type === "edit_lines") {
        const key = op.params.file_id || op.params.path || "unknown";
        if (!editGroups.has(key)) editGroups.set(key, []);
        editGroups.get(key)!.push(op);
      } else {
        nonEditOps.push(op);
      }
    }
    const finalOps: any[] = [...nonEditOps];
    for (const [, edits] of editGroups) {
      edits.sort(
        (a: any, b: any) =>
          (b.params.start_line || 0) - (a.params.start_line || 0),
      );
      finalOps.push(...edits);
    }

    logger.info(`[coding-agent] Executing ${finalOps.length} operations`);

    for (let opIndex = 0; opIndex < finalOps.length; opIndex++) {
      const op = finalOps[opIndex];
      const opPath =
        op.params?.path ||
        op.params?.file_path ||
        op.params?.filepath ||
        op.params?.file ||
        op.params?.file_name ||
        op.params?.filename ||
        op.params?.file_id ||
        null;
      // Normalize: ensure op.params.path is always set if we have a path
      if (opPath) op.params.path = opPath;

      sendSSE("operation_start", {
        iteration,
        operation: op.type,
        operationIndex: opIndex,
        totalOperations: finalOps.length,
        path: opPath,
      });

      // Log operation in DB
      let logEntryId: string | null = null;
      try {
        const logResult = await db.query(
          "INSERT INTO agent_file_operations (session_id, operation_type, file_path, status, details) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [
            sessionId,
            op.type,
            opPath,
            "in_progress",
            JSON.stringify(op.params),
          ],
        );
        logEntryId = logResult.rows[0]?.id;
      } catch {}

      broadcast(
        `agent-operations-project-${projectId}-coding`,
        "agent_operation_refresh",
        { sessionId, operationId: logEntryId, status: "in_progress" },
      );

      try {
        let result: any;

        switch (op.type) {
          case "list_files": {
            const filesResult = await (async () => {
              const _r = await rpc.getRepoFilesWithToken(
                repoId,
                shareToken || null,
              );
              return { rows: _r };
            })();
            // Start with repo_files metadata, excluding files marked as deleted in the session registry
            const files = (filesResult.rows || [])
              .filter((f: any) => {
                const reg = sessionFileRegistry.get(f.path);
                return !reg || reg.operationType !== "delete";
              })
              .map((f: any) => ({ id: f.id, path: f.path }));
            // Add new files from session registry that aren't already in repo_files
            for (const [path, reg] of sessionFileRegistry) {
              if (
                reg.isNew &&
                reg.operationType !== "delete" &&
                !files.find((f: any) => f.path === path)
              )
                files.push({ id: reg.id || "new", path });
            }
            result = { data: files };
            break;
          }
          case "search": {
            const filesResult = await (async () => {
              const _r = await rpc.getRepoFilesWithToken(
                repoId,
                shareToken || null,
              );
              return { rows: _r };
            })();
            const keyword = (op.params.keyword || "").toLowerCase();
            // Read committed blob content for each file in parallel
            const filesWithContent = await Promise.all(
              (filesResult.rows || []).map(async (f: any) => {
                // Check session registry first (may have in-session edits)
                if (sessionFileRegistry.has(f.path)) {
                  const reg = sessionFileRegistry.get(f.path)!;
                  if (reg.operationType === "delete") return null;
                  return { id: f.id, path: f.path, content: reg.content || "" };
                }
                const content = await getRepoBlobStore().readCommitted(
                  projectId,
                  repoId,
                  f.path,
                );
                return content !== null
                  ? { id: f.id, path: f.path, content }
                  : null;
              }),
            );
            // Also include new session registry entries not in repo_files
            const repoFilePaths = new Set(
              (filesResult.rows || []).map((f: any) => f.path),
            );
            const registryOnlyFiles = [...sessionFileRegistry.entries()]
              .filter(
                ([path, reg]) =>
                  !repoFilePaths.has(path) && reg.operationType !== "delete",
              )
              .map(([path, reg]) => ({
                id: reg.id || "new",
                path,
                content: reg.content || "",
              }));
            const allFiles = [
              ...(filesWithContent.filter(Boolean) as {
                id: string;
                path: string;
                content: string;
              }[]),
              ...registryOnlyFiles,
            ];
            const matches = allFiles
              .filter((f) => f.content.toLowerCase().includes(keyword))
              .map((f) => {
                const lines = f.content.split("\n");
                const matchLines = lines
                  .map((l: string, i: number) => ({
                    line: i + 1,
                    content: l.trim().slice(0, 200),
                  }))
                  .filter((l: any) =>
                    l.content.toLowerCase().includes(keyword),
                  );
                return {
                  id: f.id,
                  path: f.path,
                  match_count: matchLines.length,
                  matches: matchLines.slice(0, 20),
                };
              });
            result = { data: matches };
            break;
          }
          case "wildcard_search": {
            const queryTerms = (op.params.query || "")
              .toLowerCase()
              .split(/[,\s]+/)
              .filter(Boolean);
            const filesResult = await (async () => {
              const _r = await rpc.getRepoFilesWithToken(
                repoId,
                shareToken || null,
              );
              return { rows: _r };
            })();
            // Read committed blob content for each file in parallel
            const wcFilesWithContent = await Promise.all(
              (filesResult.rows || []).map(async (f: any) => {
                if (sessionFileRegistry.has(f.path)) {
                  const reg = sessionFileRegistry.get(f.path)!;
                  if (reg.operationType === "delete") return null;
                  return { id: f.id, path: f.path, content: reg.content || "" };
                }
                const content = await getRepoBlobStore().readCommitted(
                  projectId,
                  repoId,
                  f.path,
                );
                return content !== null
                  ? { id: f.id, path: f.path, content }
                  : null;
              }),
            );
            const wcRepoFilePaths = new Set(
              (filesResult.rows || []).map((f: any) => f.path),
            );
            const wcRegistryOnlyFiles = [...sessionFileRegistry.entries()]
              .filter(
                ([path, reg]) =>
                  !wcRepoFilePaths.has(path) && reg.operationType !== "delete",
              )
              .map(([path, reg]) => ({
                id: reg.id || "new",
                path,
                content: reg.content || "",
              }));
            const wcAllFiles = [
              ...(wcFilesWithContent.filter(Boolean) as {
                id: string;
                path: string;
                content: string;
              }[]),
              ...wcRegistryOnlyFiles,
            ];
            const matches = wcAllFiles
              .filter((f) => {
                const content = f.content.toLowerCase();
                return queryTerms.some((t: string) => content.includes(t));
              })
              .map((f) => {
                const lines = f.content.split("\n");
                const matchLines: any[] = [];
                lines.forEach((l: string, i: number) => {
                  const ll = l.toLowerCase();
                  const matched = queryTerms.filter((t: string) =>
                    ll.includes(t),
                  );
                  if (matched.length > 0)
                    matchLines.push({
                      line: i + 1,
                      content: l.trim().slice(0, 200),
                      terms: matched,
                    });
                });
                return {
                  id: f.id,
                  path: f.path,
                  match_count: matchLines.length,
                  matches: matchLines.slice(0, 20),
                };
              });
            result = { data: matches };
            break;
          }
          case "read_file": {
            const filePath = op.params.path;
            const file = await resolveFile(filePath);
            if (file) {
              const lines = file.content
                .split("\n")
                .map((l: string, i: number) => `<<${i + 1}>>${l}`)
                .join("\n");
              result = {
                data: [
                  {
                    path: file.path,
                    content: lines,
                    total_lines: file.content.split("\n").length,
                  },
                ],
              };
            } else {
              throw new Error(`File not found: ${filePath}`);
            }
            break;
          }
          case "edit_lines": {
            const filePath = op.params.path || op.params.file_path;
            if (!filePath)
              throw new Error(
                `edit_lines: no path provided. Params: ${JSON.stringify(op.params).substring(0, 200)}`,
              );
            const file = await resolveFile(filePath);
            if (!file) throw new Error(`File not found: ${filePath}`);
            const lines = file.content.split("\n");
            const startIdx = Math.max((op.params.start_line || 1) - 1, 0);
            const endIdx = Math.min(
              (op.params.end_line || startIdx + 1) - 1,
              lines.length - 1,
            );
            const newContentLines = (op.params.new_content || "").split("\n");
            const newLines = [...lines];
            const deleteCount = startIdx <= endIdx ? endIdx - startIdx + 1 : 0;
            newLines.splice(startIdx, deleteCount, ...newContentLines);
            const newContent = newLines.join("\n");

            const operationType =
              file.isNew || file.operationType === "create"
                ? "create"
                : "modify";
            sessionFileRegistry.set(filePath, {
              id: file.id,
              content: newContent,
              isNew: operationType === "create",
              operationType,
            });

            const numberedContent = newContent
              .split("\n")
              .map((l: string, i: number) => `<<${i + 1}>>${l}`)
              .join("\n");
            result = {
              data: [
                {
                  path: filePath,
                  total_lines: newLines.length,
                  verification: {
                    start_line: op.params.start_line,
                    end_line: op.params.end_line,
                    lines_replaced: deleteCount,
                    lines_inserted: newContentLines.length,
                    line_delta: newContentLines.length - deleteCount,
                    total_lines: newLines.length,
                  },
                  fresh_content: numberedContent,
                },
              ],
            };
            filesChanged = true;
            break;
          }
          case "create_file": {
            const content = op.params.content || "";
            sessionFileRegistry.set(op.params.path, {
              content,
              isNew: true,
              operationType: "create",
            });
            result = { data: [{ path: op.params.path }] };
            filesChanged = true;
            break;
          }
          case "delete_file": {
            const filePath = op.params.path;
            const file = await resolveFile(filePath);
            if (file) {
              if (file.isNew || file.operationType === "create") {
                sessionFileRegistry.delete(filePath);
              } else {
                sessionFileRegistry.set(filePath, {
                  id: file.id,
                  content: null,
                  isNew: false,
                  operationType: "delete",
                });
              }
            }
            result = { data: [{ path: filePath }] };
            filesChanged = true;
            break;
          }
          case "move_file": {
            const filePath = op.params.path;
            const file = await resolveFile(filePath);
            if (file) {
              if (!file.isNew && file.operationType !== "create") {
                sessionFileRegistry.set(filePath, {
                  id: file.id,
                  content: null,
                  isNew: false,
                  operationType: "delete",
                });
              } else {
                sessionFileRegistry.delete(filePath);
              }
              sessionFileRegistry.set(op.params.new_path, {
                content: file.content,
                isNew: true,
                operationType: "create",
              });
            }
            result = { data: [{ path: op.params.new_path }] };
            filesChanged = true;
            break;
          }
          case "get_staged_changes": {
            const stagedResult = await (async () => {
              const _r = await rpc.getStagedChangesWithToken(
                repoId,
                shareToken || null,
              );
              return { rows: _r };
            })();
            result = {
              data: (stagedResult.rows || []).map((s: any) => ({
                id: s.id,
                file_path: s.file_path,
                operation_type: s.operation_type,
              })),
            };
            break;
          }
          case "unstage_file": {
            await rpc.unstageFileWithToken(
              repoId,
              op.params.file_path,
              shareToken || null,
            );
            if (sessionFileRegistry.has(op.params.file_path))
              sessionFileRegistry.delete(op.params.file_path);
            result = { data: [{ file_path: op.params.file_path }] };
            filesChanged = true;
            break;
          }
          case "discard_all_staged": {
            await rpc.discardStagedWithToken(repoId, shareToken || null);
            sessionFileRegistry.clear();
            result = { data: [] };
            filesChanged = true;
            break;
          }
          case "project_inventory": {
            if (!exposeProject)
              throw new Error("project_inventory not enabled");
            const invResult = await (async () => {
              const _r = await rpc.getProjectInventoryWithToken(
                projectId,
                shareToken || null,
              );
              return _r;
            })();
            result = { data: invResult };
            break;
          }
          default:
            result = { data: null, error: `Unknown operation: ${op.type}` };
        }

        // Update operation status
        if (logEntryId) {
          try {
            await db.query(
              "UPDATE agent_file_operations SET status = 'completed' WHERE id = $1",
              [logEntryId],
            );
          } catch {}
        }
        broadcast(
          `agent-operations-project-${projectId}-coding`,
          "agent_operation_refresh",
          { sessionId, operationId: logEntryId, status: "completed" },
        );
        operationResults.push({
          type: op.type,
          success: true,
          data: result.data,
        });
        sendSSE("operation_complete", {
          iteration,
          operation: op.type,
          success: true,
        });
      } catch (opError: any) {
        const errorMessage =
          opError instanceof Error ? opError.message : String(opError);
        if (logEntryId) {
          try {
            await db.query(
              "UPDATE agent_file_operations SET status = 'failed', error_message = $2 WHERE id = $1",
              [logEntryId, errorMessage],
            );
          } catch {}
        }
        broadcast(
          `agent-operations-project-${projectId}-coding`,
          "agent_operation_refresh",
          { sessionId, operationId: logEntryId, status: "failed" },
        );
        operationResults.push({
          type: op.type,
          success: false,
          error: errorMessage,
        });
        sendSSE("operation_complete", {
          iteration,
          operation: op.type,
          success: false,
          error: errorMessage,
        });
      }
    }

    // Broadcast file changes
    if (filesChanged) {
      const filesToStage = Array.from(sessionFileRegistry.entries())
        .filter(([, file]) => Boolean(file.operationType))
        .map(([filePath, file]) => ({
          filePath,
          operationType: file.operationType!,
          newContent: file.operationType === "delete" ? null : file.content,
          oldPath: file.oldPath || null,
        }));

      if (filesToStage.length > 0) {
        try {
          await rpc.batchStageFiles(
            repoId,
            shareToken || null,
            filesToStage,
            projectId,
          );
        } catch (batchError: any) {
          logger.warn(
            "[coding-agent] Batch staging failed; falling back to individual staging",
            {
              repoId,
              filesCount: filesToStage.length,
              error: batchError?.message || batchError,
            },
          );
          for (const file of filesToStage) {
            await rpc.stageFileChangeWithToken(
              repoId,
              shareToken || null,
              file.filePath,
              file.operationType,
              null,
              file.newContent ?? null,
              file.oldPath ?? null,
            );
          }
        }
      }

      broadcast(stagingChannel(repoId), "staging_refresh", {
        repoId,
        action: "agent_edit",
      });
      broadcast(repoFilesChannel(projectId), "repo_files_refresh", {
        projectId,
        repoId,
      });
    }

    // Build operation results summary for next iteration context
    const summarizedResults = operationResults.map((r: any) => {
      const summary: any = { type: r.type, success: r.success };
      if (r.error) summary.error = r.error;
      if (r.success && r.data) {
        switch (r.type) {
          case "list_files":
            summary.summary = `Listed ${Array.isArray(r.data) ? r.data.length : 0} files`;
            summary.files = r.data;
            break;
          case "search":
          case "wildcard_search":
            summary.summary = `Found ${Array.isArray(r.data) ? r.data.length : 0} files`;
            summary.results = r.data;
            break;
          case "read_file":
            if (r.data?.[0]) {
              summary.summary = `Read ${r.data[0].path}`;
              summary.path = r.data[0].path;
              summary.content = r.data[0].content;
              summary.total_lines = r.data[0].total_lines;
            }
            break;
          case "edit_lines":
            if (r.data?.[0]?.verification) {
              const v = r.data[0].verification;
              summary.summary = `Edited lines ${v.start_line}-${v.end_line}`;
              summary.verification = v;
              if (r.data[0].fresh_content) {
                summary.fresh_content = r.data[0].fresh_content;
                summary.total_lines = r.data[0].total_lines;
              }
            }
            break;
          case "get_staged_changes":
            summary.summary = `${Array.isArray(r.data) ? r.data.length : 0} staged`;
            summary.files = r.data;
            break;
          default:
            summary.summary = `Completed ${r.type}`;
            break;
        }
      }
      return summary;
    });

    // Store operation results as system message for next iteration
    try {
      await rpc.insertAgentMessageWithToken(
        sessionId,
        shareToken || null,
        "system",
        `Operation results:\n${JSON.stringify(summarizedResults, null, 2)}`,
        JSON.stringify({ type: "operation_results", iteration, hidden: true }),
      );
    } catch {}

    // Determine status
    const agentStatus =
      parsed.status === "completed" || parsed.status === "done"
        ? "completed"
        : "in_progress";

    // Update session if completed
    if (agentStatus === "completed") {
      try {
        await db.query(
          "UPDATE agent_sessions SET status = 'completed', updated_at = NOW() WHERE id = $1",
          [sessionId],
        );
      } catch {}

      broadcast(
        `agent-messages-project-${projectId}-coding`,
        "agent_message_refresh",
        { sessionId, status: "completed" },
      );
      broadcast(
        `agent-operations-project-${projectId}-coding`,
        "agent_operation_refresh",
        { sessionId, status: "completed" },
      );
    }

    // Send iteration complete
    sendSSE("iteration_complete", {
      sessionId,
      iteration,
      status: agentStatus,
      operationCount: operationResults.length,
      filesChanged,
      maxIterations: MAX_ITERATIONS,
    });

    logger.info(
      `[coding-agent] Iteration ${iteration} complete, status: ${agentStatus}`,
    );
  } catch (error: any) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("[coding-agent-orchestrator] Error:", errMsg);
    if (error instanceof Error && error.stack)
      logger.error("[coding-agent-orchestrator] Stack:", error.stack);

    try {
      if (existingSessionId || body.sessionId) {
        await db.query(
          "UPDATE agent_sessions SET status = 'failed', updated_at = NOW() WHERE id = $1",
          [existingSessionId || body.sessionId],
        );
      }
    } catch {}

    sendSSE("error", {
      sessionId: existingSessionId,
      iteration,
      error: errMsg,
    });
  } finally {
    res.end();
  }
}

async function handleAiArchitect(req: Request, res: Response, body: any) {
  const {
    description,
    existingNodes,
    existingEdges,
    drawEdges = true,
    attachedContext,
    projectId,
    shareToken,
  } = body;
  const functionName = body.__functionName || "ai-architect";
  const isCritic = functionName === "ai-architect-critic";

  logger.info(`[${functionName}] Starting...`);

  try {
    const { buildEndpointUrl, getDefaultModel } =
      await import("../config/aiModels");
    const defaultModel = getDefaultModel();

    // Validate project access
    if (projectId) {
      const accessResult = await (async () => {
        const _r = await rpc.getProjectWithToken(projectId, shareToken || null);
        return { rows: _r ? [_r] : [] };
      })();
      if (!accessResult.rows[0]) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
    }

    // Fetch node types from database
    let nodeTypes: any[] = [];
    try {
      const ntResult = await (async () => {
        const _r = await rpc.getCanvasNodeTypes(true);
        return { rows: _r };
      })();
      nodeTypes = ntResult.rows || [];
    } catch {
      nodeTypes = [];
    }
    logger.info(`[${functionName}] Loaded ${nodeTypes.length} node types`);

    // Build dynamic positioning and type prompts
    const activeTypes = nodeTypes.filter(
      (nt: any) => nt.is_active && !nt.is_legacy,
    );
    const nodeTypePrompt = activeTypes
      .map(
        (nt: any) =>
          `- ${nt.system_name}: ${nt.description || nt.display_label}`,
      )
      .join("\n");

    const X_POSITIONS: Record<string, number> = {};
    nodeTypes.forEach((nt: any) => {
      X_POSITIONS[nt.system_name] =
        nt.order_score + Math.floor(nt.order_score * 0.5);
    });

    if (isCritic) {
      // AI Architect Critic - streaming analysis
      const nodes = body.nodes || [];
      const edges = body.edges || [];

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const nodesSummary = nodes
        .map(
          (n: any) =>
            `${n.data?.label || "Unnamed"} (${n.data?.type || "UNKNOWN"}): ${n.data?.description || "No description"}`,
        )
        .join("\n");
      const edgesSummary = edges
        .map(
          (e: any) =>
            `${e.source} → ${e.target}${e.data?.label ? ` (${e.data.label})` : ""}`,
        )
        .join("\n");

      let systemPrompt = `You are an expert software architect and systems analyst. Analyze the provided application architecture and provide detailed, constructive feedback.

NODE TYPES:\n${nodeTypePrompt}

Focus on: Architectural Patterns, Component Organization, Separation of Concerns, Data Flow, Security, Database Design, Missing Components, Edge Direction.
Provide specific, actionable recommendations.`;

      if (attachedContext) {
        const resolvedCtx = projectId
          ? await resolveAttachedContext(attachedContext, projectId)
          : attachedContext;
        const jsonString = JSON.stringify(resolvedCtx, null, 2);
        const truncated =
          jsonString.length > 50000
            ? jsonString.slice(0, 50000) + "\n...[truncated]"
            : jsonString;
        systemPrompt += `\n\n===== ATTACHED PROJECT CONTEXT =====\n${truncated}`;
      }

      const userPrompt = `Analyze this application architecture:\n\nNODES (${nodes.length}):\n${nodesSummary}\n\nCONNECTIONS (${edges.length}):\n${edgesSummary}\n\nProvide a comprehensive critique with specific recommendations.`;

      const endpoint = buildEndpointUrl(defaultModel.id);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 8192,
          temperature: 0.7,
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI API error: ${response.status} ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") continue;
          if (!jsonStr) continue;
          // Pass through the SSE data directly
          res.write(`data: ${jsonStr}\n\n`);
        }
      }
      reader.releaseLock();
      res.end();
    } else {
      // AI Architect - generate architecture JSON
      const typeNames = activeTypes.map((nt: any) => nt.system_name).join("|");

      let systemPrompt = `You are an expert software architect. Generate a comprehensive application architecture.

NODE TYPES (use exact values):\n${nodeTypePrompt}

${drawEdges ? "EDGES: Define connections between nodes. All edges must flow LEFT to RIGHT." : "DO NOT return any edges."}

Return ONLY valid JSON:
{
  "nodes": [{ "label": "Name", "type": "${typeNames}", "subtitle": "Brief", "description": "Detailed", "x": 100, "y": 100 }]${
    drawEdges
      ? `,
  "edges": [{ "source": "Source Label", "target": "Target Label", "relationship": "fetches data from" }]`
      : ""
  }
}

Be comprehensive. Include all major components.`;

      if (attachedContext) {
        const resolvedCtx = projectId
          ? await resolveAttachedContext(attachedContext, projectId)
          : attachedContext;
        const jsonString = JSON.stringify(resolvedCtx, null, 2);
        const truncated =
          jsonString.length > 50000
            ? jsonString.slice(0, 50000) + "\n...[truncated]"
            : jsonString;
        systemPrompt += `\n\n===== ATTACHED PROJECT CONTEXT =====\n${truncated}`;
      }

      let existingContextInfo = "";
      if (existingNodes?.length > 0) {
        const nodesList = existingNodes
          .map(
            (n: any) =>
              `${n.data?.label} (${n.data?.type}): ${n.data?.description || ""}`,
          )
          .join("\n");
        existingContextInfo += `\nEXISTING NODES (${existingNodes.length}):\n${nodesList}\n\n⚠️ DO NOT recreate existing nodes. Only generate NEW complementary nodes.`;
      }
      if (existingEdges?.length > 0) {
        const edgesList = existingEdges
          .map((e: any) => `${e.source} → ${e.target}`)
          .join("\n");
        existingContextInfo += `\nEXISTING CONNECTIONS (${existingEdges.length}):\n${edgesList}`;
      }

      const userPrompt = `Generate a complete application architecture for: ${description}${existingContextInfo}`;

      const endpoint = buildEndpointUrl(defaultModel.id);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 8192,
          temperature: 0.7,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI API error: ${response.status} ${errorText}`);
      }

      const aiData = (await response.json()) as any;
      const content = aiData.choices?.[0]?.message?.content || "{}";
      let architecture: any;
      try {
        architecture = JSON.parse(content);
      } catch {
        const match = content.match(/```json\n?([\s\S]*?)\n?```/);
        architecture = match ? JSON.parse(match[1]) : JSON.parse(content);
      }

      // Post-process nodes to fix X positions
      if (architecture.nodes) {
        architecture.nodes = architecture.nodes.map((node: any) => ({
          ...node,
          x: X_POSITIONS[node.type] ?? node.x ?? 700,
        }));
      }

      res.json(architecture);
    }
  } catch (error: any) {
    logger.error(`[${functionName}] Error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(
        `data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`,
      );
      res.end();
    }
  }
}

async function handleGenerateImage(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const { getImageModelConfig, getDefaultImageModel, buildImageEndpointUrl } =
    await import("../config/aiModels");

  const defaultModel = getDefaultImageModel();
  const {
    prompt,
    model = defaultModel.id,
    size = defaultModel.defaultSize,
  } = body;

  if (!prompt) {
    res.status(400).json({ error: "Prompt is required" });
    return;
  }

  // Get model configuration
  const modelConfig = getImageModelConfig(model);
  if (!modelConfig) {
    res.status(400).json({ error: `Unknown image model: ${model}` });
    return;
  }

  try {
    // Build endpoint URL from configuration
    const fullUrl = buildImageEndpointUrl(model);
    logger.info(`Calling image generation URL: ${fullUrl}`);

    // Parse size (e.g., "1024x1024") into width and height
    const [width, height] = size.split("x").map(Number);

    const token = await getAzureTokenForScope(AzureScope.CognitiveServices);

    // Use BFL service provider API for FLUX with correct body format
    // Model name (foundryDeploymentId) must be lowercase as required by API
    const response = await fetch(fullUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        prompt,
        model: modelConfig.foundryDeploymentId,
        n: 1,
        width: width || 1024,
        height: height || 1024,
        output_format: "jpeg",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        `Image generation failed: ${response.status} - ${errorText}`,
      );
      res.status(response.status).json({
        error: "Image generation failed",
        details: errorText,
      });
      return;
    }

    // BFL API can return various formats - try to parse as JSON first
    const responseData = (await response.json()) as any;
    logger.info(
      `Image generation response: ${JSON.stringify(responseData).substring(0, 500)}`,
    );

    // Handle BFL service provider API response format
    let imageUrl =
      responseData.sample || responseData.image || responseData.url;

    // Also handle OpenAI-compatible response format
    if (!imageUrl && responseData.data?.[0]?.url) {
      imageUrl = responseData.data[0].url;
    }
    if (!imageUrl && responseData.data?.[0]?.b64_json) {
      imageUrl = `data:image/jpeg;base64,${responseData.data[0].b64_json}`;
    }

    // Handle base64 image directly in response
    if (
      !imageUrl &&
      typeof responseData === "string" &&
      responseData.startsWith("/9j/")
    ) {
      imageUrl = `data:image/jpeg;base64,${responseData}`;
    }

    if (!imageUrl) {
      logger.error(`No image in response: ${JSON.stringify(responseData)}`);
      res.status(500).json({
        error: "No image returned from model",
        response: responseData,
      });
      return;
    }

    res.json({ success: true, imageUrl });
  } catch (error) {
    logger.error("Image generation error:", error);
    res
      .status(500)
      .json({ error: "Image generation failed", details: String(error) });
  }
}

async function handleUploadArtifactImage(
  req: Request,
  res: Response,
  body: any,
) {
  const {
    projectId,
    shareToken,
    imageData,
    fileName,
    content,
    sourceType,
    sourceId,
    title,
    provenanceId,
    provenancePath,
    provenancePage,
    uploadOnly,
  } = body;

  if (!projectId) {
    res.status(400).json({ error: "Project ID is required" });
    return;
  }
  if (!content && !uploadOnly) {
    res.status(400).json({ error: "Content is required" });
    return;
  }

  try {
    // Validate project access
    const accessResult = await (async () => {
      const _r = await rpc.validateProjectAccess(projectId, shareToken || null);
      return { rows: [{ has_access: _r }] };
    })();
    if (!accessResult.rows[0]?.has_access)
      throw new Error("Unauthorized: Invalid project access");

    let publicUrl: string | null = null;

    // Upload image if provided (store locally or to Azure Blob Storage)
    if (imageData) {
      const fs = await import("fs");
      const path = await import("path");
      const base64Data = imageData.includes(",")
        ? imageData.split(",")[1]
        : imageData;
      const binaryData = Buffer.from(base64Data, "base64");

      const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const baseName = fileName ? fileName.replace(/\.[^.]+$/, "") : "image";
      const extension = fileName?.split(".").pop() || "png";
      const uniqueFileName = `${baseName}-${uniqueId}.${extension}`;

      // Store in local uploads directory
      const uploadsDir = path.join(
        process.cwd(),
        "storage",
        "artifact-images",
        projectId,
      );
      fs.mkdirSync(uploadsDir, { recursive: true });
      const filePath = path.join(uploadsDir, uniqueFileName);
      fs.writeFileSync(filePath, binaryData);

      // Build URL that the API can serve
      publicUrl = `/api/v1/storage/artifact-images/${projectId}/${uniqueFileName}`;
      logger.info(
        `[upload-artifact-image] Saved to ${filePath}, URL: ${publicUrl}`,
      );
    }

    if (uploadOnly) {
      res.json({ artifact: null, url: publicUrl });
      return;
    }

    // Create artifact via RPC
    const artifactResult = await (async () => {
      const _r = await rpc.insertArtifactWithToken(
        projectId,
        shareToken || null,
        content,
        sourceType || null,
        sourceId || null,
        publicUrl,
        title || null,
        provenanceId || null,
        provenancePath || null,
        provenancePage || null,
      );
      return { rows: [{ artifact_id: _r?.id }] };
    })();
    const artifactId = artifactResult.rows[0]?.artifact_id;

    logger.info(`[upload-artifact-image] Created artifact ${artifactId}`);
    // Broadcast artifact refresh to subscribers
    broadcast(`project-${projectId}-artifacts`, "artifact_refresh", {
      action: "created",
      artifactId,
      projectId,
    });
    res.json({ artifact: artifactId, url: publicUrl });
  } catch (error: any) {
    logger.error("[upload-artifact-image] Error:", error.message);
    res.status(400).json({ error: error.message });
  }
}

async function handleGenerateLocalPackage(
  req: Request,
  res: Response,
  body: any,
) {
  const { deploymentId, shareToken, mode = "full" } = body;

  if (!deploymentId) {
    res.status(400).json({ error: "deploymentId is required" });
    return;
  }

  try {
    // Get deployment details
    const deployResult = await (async () => {
      const _r = await rpc.getDeploymentWithSecretsWithToken(
        deploymentId,
        shareToken || null,
      );
      return { rows: _r ? [_r] : [] };
    })();
    const deployment = deployResult.rows[0];
    if (!deployment) throw new Error("Deployment not found or access denied");

    // Env-var / secret VALUES live in the per-deployment Key Vault (single
    // source of truth), not in Postgres. Read them back keyed by their original
    // env-var name; treat both "env" and user "secret" kinds as env vars for
    // the local package.
    const decryptedEnvVars: Record<string, string> = {};
    try {
      const vaultUri = deriveGenappKeyVaultUri(
        deriveGenappKeyVaultName(deployment.id),
      );
      const all = await getGenappSecrets(vaultUri);
      for (const [key, v] of Object.entries(all)) {
        if (v.kind === "env" || v.kind === "secret") {
          decryptedEnvVars[key] = v.value;
        }
      }
    } catch (e) {
      logger.warn(
        "[generate-local-package] Failed to read env vars from Key Vault",
      );
    }

    // Get repo details
    let repo: any = null;
    if (deployment.repo_id) {
      const repoResult = await (async () => {
        const _r = await rpc.getRepoByIdWithToken(
          deployment.repo_id,
          shareToken || null,
        );
        return { rows: _r ? [_r] : [] };
      })();
      repo = repoResult.rows[0];
    }
    if (!repo) {
      const reposResult = await (async () => {
        const _r = await rpc.getProjectReposWithToken(
          deployment.project_id,
          shareToken || null,
        );
        return { rows: _r };
      })();
      repo =
        reposResult.rows?.find((r: any) => r.is_prime) || reposResult.rows?.[0];
    }

    // Get project details
    const projResult = await (async () => {
      const _r = await rpc.getProjectWithToken(
        deployment.project_id,
        shareToken || null,
      );
      return { rows: _r ? [_r] : [] };
    })();
    const project = projResult.rows[0];

    // Generate .env file content
    const envLines = [
      "# ===== Pronghorn Local Development Environment =====",
      `PRONGHORN_PROJECT_ID=${deployment.project_id}`,
      `PRONGHORN_DEPLOYMENT_ID=${deploymentId}`,
      `PRONGHORN_ENVIRONMENT=${deployment.environment || "development"}`,
      `PRONGHORN_API_URL=${process.env.API_BASE_URL || "https://api.pronghorn.red"}`,
      shareToken ? `PRONGHORN_SHARE_TOKEN=${shareToken}` : "",
      repo ? `PRONGHORN_REPO_ID=${repo.id}` : "",
      "",
      "# ===== Runtime Configuration =====",
      `PROJECT_TYPE=${deployment.project_type || "node"}`,
      `RUN_COMMAND=${deployment.run_command || "npm start"}`,
      `BUILD_COMMAND=${deployment.build_command || "npm run build"}`,
      "",
      "# ===== User Environment Variables =====",
      ...Object.entries(decryptedEnvVars).map(([k, v]) => `${k}=${v}`),
    ]
      .filter(Boolean)
      .join("\n");

    if (mode === "env-only") {
      res.json({
        success: true,
        data: envLines,
        filename: ".env",
        contentType: "text/plain",
      });
      return;
    }

    // Generate full package (without JSZip, return as JSON with file contents)
    const packageJson = {
      name: `pronghorn-local-${deployment.name || "runner"}`,
      version: "1.0.0",
      private: true,
      scripts: {
        start: "node pronghorn-runner.js",
        dev: "node pronghorn-runner.js --watch",
      },
      dependencies: { dotenv: "^16.3.1", ws: "^8.14.2", chokidar: "^3.5.3" },
    };

    const readme = `# Pronghorn Local Development Runner\n\n## Setup\n1. Run \`npm install\`\n2. Configure \`.env\` with your credentials\n3. Run \`npm start\`\n\n## Project: ${project?.name || "Unknown"}\n## Environment: ${deployment.environment || "development"}\n`;

    const runnerScript = `#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
console.log('Pronghorn Local Runner v1.0');
console.log('Project:', process.env.PRONGHORN_PROJECT_ID);
console.log('Environment:', process.env.PRONGHORN_ENVIRONMENT);
console.log('\\nConnect to ${process.env.API_BASE_URL || "https://api.pronghorn.red"} for file sync and real-time updates.');
console.log('Runner ready. Use the Pronghorn web UI for file management and deployments.');
`;

    // Return as base64 JSON (frontend handles ZIP creation)
    const files = {
      ".env": envLines,
      "package.json": JSON.stringify(packageJson, null, 2),
      "README.md": readme,
      "pronghorn-runner.js": runnerScript,
    };

    // Encode as base64 for consistency with original
    const jsonContent = JSON.stringify(files);
    const base64Content = Buffer.from(jsonContent).toString("base64");

    res.json({
      success: true,
      data: base64Content,
      filename: `${deployment.environment}-${deployment.name}-local.zip`,
      contentType: "application/json",
      files, // Also include raw files for easier frontend use
    });
  } catch (error: any) {
    logger.error("[generate-local-package] Error:", error.message);
    res.status(400).json({ success: false, error: error.message });
  }
}

async function handleSecretsManagement(
  req: Request,
  res: Response,
  body: any,
  functionName: string,
): Promise<void> {
  const { action, shareToken } = body;
  logger.info(`${functionName}: ${action}`);

  try {
    if (functionName === "database-connection-secrets") {
      const { connectionId } = body;
      if (!connectionId) {
        res.status(400).json({ error: "connectionId is required" });
        return;
      }

      // Connection strings live in the owning PROJECT's Key Vault.
      const projRes = await db.query(
        "SELECT project_id FROM project_database_connections WHERE id = $1",
        [connectionId],
      );
      const projectId: string | undefined = projRes.rows[0]?.project_id;
      if (!projectId) {
        res.status(404).json({ error: "Connection not found" });
        return;
      }

      if (action === "get") {
        const connStr = await getConnectionStringSecret({
          projectId,
          connectionId,
        });
        res.json({ success: true, connectionString: connStr ?? undefined });
        return;
      }

      if (action === "set") {
        const { connectionString } = body;
        if (!connectionString) {
          res.status(400).json({ error: "connectionString is required" });
          return;
        }
        await setConnectionStringSecret({
          projectId,
          connectionId,
          connectionString,
        });
        res.json({ success: true });
        return;
      }
    }

    if (functionName === "deployment-secrets") {
      const { deploymentId } = body;
      if (!deploymentId) {
        res.status(400).json({ error: "deploymentId is required" });
        return;
      }

      if (action === "get") {
        const deployment = await rpc.getDeploymentWithSecretsWithToken(
          deploymentId,
          shareToken || null,
        );
        if (!deployment) {
          res.status(404).json({ error: "Deployment not found" });
          return;
        }

        const vaultUri =
          deployment.azure_key_vault_uri ||
          deriveGenappKeyVaultUri(deriveGenappKeyVaultName(deploymentId));

        const secrets: Record<string, string> = {};
        const envVars: Record<string, string> = {};
        try {
          const all = await getGenappSecrets(vaultUri);
          for (const [name, entry] of Object.entries(all)) {
            if (entry.kind === "secret") secrets[name] = entry.value;
            else if (entry.kind === "env") envVars[name] = entry.value;
          }
        } catch (readErr) {
          // Vault may not exist yet for a freshly-created deployment.
          logger.warn(
            `deployment-secrets get: vault read failed (${(readErr as Error).message})`,
          );
        }

        res.json({ success: true, secrets, envVars });
        return;
      }

      if (action === "set") {
        const { secrets, envVars } = body;
        const { name: vaultName, uri } = await ensureGenappKeyVault({
          appId: deploymentId,
        });

        const entries: GenappSecretEntry[] = [];
        if (secrets && typeof secrets === "object") {
          for (const [k, v] of Object.entries(secrets)) {
            entries.push({
              envName: k,
              value: String(v ?? ""),
              kind: "secret",
            });
          }
        }
        if (envVars && typeof envVars === "object") {
          for (const [k, v] of Object.entries(envVars)) {
            entries.push({ envName: k, value: String(v ?? ""), kind: "env" });
          }
        }
        if (entries.length > 0) {
          await setGenappSecrets(uri, entries);
        }

        // Persist vault coordinates so subsequent reads + Terraform can find it.
        await db.query(
          `UPDATE project_deployments
             SET azure_key_vault_name = $1, azure_key_vault_uri = $2, updated_at = NOW()
           WHERE id = $3`,
          [vaultName, uri, deploymentId],
        );

        res.json({ success: true });
        return;
      }
    }

    res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (error: any) {
    logger.error(`${functionName} error:`, error.message);
    res.status(500).json({ error: error.message });
  }
}

async function handleStagingOperations(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const {
    action,
    repoId,
    shareToken,
    filePath,
    operationType,
    oldContent,
    newContent,
    oldPath,
    filePaths,
    commitMessage,
    branch,
  } = body;

  logger.info(`[staging-operations] Action: ${action}, RepoId: ${repoId}`);

  if (!action || !repoId) {
    res
      .status(400)
      .json({ success: false, error: "action and repoId are required" });
    return;
  }

  try {
    let result: any = null;

    switch (action) {
      case "stage": {
        if (!filePath || !operationType) {
          res.status(400).json({
            success: false,
            error: "filePath and operationType required for stage action",
          });
          return;
        }
        const stageResult = await (async () => {
          const _r = await rpc.stageFileChangeWithToken(
            repoId,
            shareToken || null,
            filePath,
            operationType,
            oldContent ?? null,
            newContent ?? null,
            oldPath ?? null,
          );
          return { rows: [{ result: _r }] };
        })();
        result = stageResult.rows[0]?.result;
        break;
      }
      case "unstage": {
        if (!filePath) {
          res.status(400).json({
            success: false,
            error: "filePath required for unstage action",
          });
          return;
        }
        const unstageResult = await (async () => {
          const _r = await rpc.unstageFileWithToken(
            repoId,
            filePath,
            shareToken || null,
          );
          return { rows: [{ result: _r }] };
        })();
        result = unstageResult.rows[0]?.result;
        break;
      }
      case "unstage_selected": {
        if (!filePaths || filePaths.length === 0) {
          res.status(400).json({
            success: false,
            error: "filePaths required for unstage_selected action",
          });
          return;
        }
        const unstageSelectedResult = await (async () => {
          const _r = await rpc.unstageFilesWithToken(
            repoId,
            filePaths,
            shareToken || null,
          );
          return { rows: [{ result: _r }] };
        })();
        result = unstageSelectedResult.rows[0]?.result;
        break;
      }
      case "discard_all": {
        const discardResult = await (async () => {
          const _r = await rpc.discardStagedWithToken(
            repoId,
            shareToken || null,
          );
          return { rows: [{ result: _r }] };
        })();
        result = discardResult.rows[0]?.result;
        break;
      }
      case "commit": {
        if (!commitMessage) {
          res.status(400).json({
            success: false,
            error: "commitMessage required for commit action",
          });
          return;
        }
        if (Array.isArray(filePaths) && filePaths.length === 0) {
          res.status(400).json({
            success: false,
            error: "Select at least one staged file to commit",
          });
          return;
        }
        const commitResult = await (async () => {
          const _r = await rpc.commitStagedWithToken(
            repoId,
            shareToken || null,
            commitMessage,
            branch || "main",
            Array.isArray(filePaths) ? filePaths : null,
          );
          return { rows: [{ result: _r }] };
        })();
        result = commitResult.rows[0]?.result;
        break;
      }
      default:
        res
          .status(400)
          .json({ success: false, error: `Unknown action: ${action}` });
        return;
    }

    // Broadcast staging and file refresh to frontend subscribers
    // Get projectId from repo for the file refresh channel
    let broadcastProjectId: string | null = null;
    try {
      const repoLookup = await db.query(
        "SELECT project_id FROM project_repos WHERE id = $1",
        [repoId],
      );
      broadcastProjectId = repoLookup.rows[0]?.project_id;
    } catch {}

    // Broadcast to staging channel (file tree listens on this)
    broadcast(stagingChannel(repoId), "staging_refresh", {
      repoId,
      action: action,
    });

    // If commit, also broadcast repo_files_refresh so the file tree reloads committed files
    if (action === "commit" && broadcastProjectId) {
      broadcast(repoFilesChannel(broadcastProjectId), "repo_files_refresh", {
        projectId: broadcastProjectId,
        repoId,
      });
    }

    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error("[staging-operations] Error:", error);
    res.status(400).json({ success: false, error: error.message });
  }
}

async function handleRepoOperations(
  req: Request,
  res: Response,
  body: any,
  functionName: string,
): Promise<void> {
  const { projectId, shareToken } = body;

  if (!projectId) {
    res.status(400).json({ success: false, error: "projectId is required" });
    return;
  }

  // Resolve GitHub token using centralized chain: repo_pats → GitHub App → system env
  const resolvedGh = await resolveGitHubToken({ userId: req.user?.id });
  if (!resolvedGh) {
    res.status(400).json({
      success: false,
      error:
        "GitHub is not configured. Configure the GitHub App or a system token.",
    });
    return;
  }
  const githubPat = resolvedGh.token;
  // Repos are always created in the configured GitHub organization.
  const organization = process.env.GITHUB_ORG;
  if (!organization) {
    res.status(400).json({
      success: false,
      error:
        "GITHUB_ORG is not set; cannot determine the organization for repositories",
    });
    return;
  }

  const ghHeaders = gitHubApiHeaders(githubPat);

  try {
    // Validate project access and editor role
    const roleResult = await (async () => {
      const _role = await rpc.authorizeProjectAccess(
        projectId,
        shareToken || null,
      );
      return { rows: [{ role: _role }] };
    })();
    const role = roleResult.rows[0]?.role;
    if (!role || (role !== "owner" && role !== "editor")) {
      res.status(403).json({ success: false, error: "Editor role required" });
      return;
    }

    switch (functionName) {
      case "create-empty-repo": {
        const { repoName, isPrivate } = body;
        if (!repoName) {
          res
            .status(400)
            .json({ success: false, error: "repoName is required" });
          return;
        }

        // Validate the configured org before interpolating it into the
        // api.github.com URL to prevent SSRF / path injection.
        assertGitHubSlug(organization, "organization");

        // Generate unique slug
        const finalRepoName = buildRepoSlug(repoName);

        // Get project data for description
        const projectResult = await (async () => {
          const _r = await rpc.getProjectWithToken(
            projectId,
            shareToken || null,
          );
          return { rows: _r ? [_r] : [] };
        })();
        const project = projectResult.rows[0];

        // Create GitHub repo in the configured organization.
        const createRepoApiUrl = `https://api.github.com/orgs/${organization}/repos`;
        const createResp = await fetch(createRepoApiUrl, {
          method: "POST",
          headers: ghHeaders,
          body: JSON.stringify({
            name: finalRepoName,
            private: isPrivate ?? true,
            auto_init: true,
            description: `Repository for ${project?.name || "project"}`,
          }),
        });

        if (!createResp.ok) {
          const errorData = (await createResp.json()) as any;
          throw new Error(
            `GitHub API error: ${errorData.message || "Failed to create repository"}`,
          );
        }
        const repoData = (await createResp.json()) as any;

        // Link to project
        const linkResult = await (async () => {
          const _r = await rpc.createProjectRepoWithToken(
            projectId,
            shareToken || null,
            organization,
            finalRepoName,
            "main",
            true,
            true,
          );
          return { rows: _r ? [_r] : [] };
        })();
        const newRepo = linkResult.rows[0];

        // Get latest commit SHA and store initial files
        const refResp = await fetch(
          `https://api.github.com/repos/${organization}/${finalRepoName}/git/ref/heads/main`,
          {
            headers: ghHeaders,
          },
        );
        const refData = (await refResp.json()) as any;
        const latestCommitSha = refData.object?.sha;

        if (latestCommitSha) {
          const initialFiles = [
            {
              path: "README.md",
              content: `# ${project?.name || "Project"}\n\n${project?.description || "Project repository"}\n`,
            },
            { path: ".gitkeep", content: "" },
          ];
          for (const file of initialFiles) {
            await rpc.upsertFileWithToken(
              newRepo.id,
              file.path,
              file.content,
              shareToken || null,
              latestCommitSha,
            );
          }
        }

        // Broadcast repo creation to subscribers
        broadcast(`project_repos-${projectId}`, "repos_refresh", {
          action: "created",
          repoId: newRepo?.id,
        });

        res.json({
          success: true,
          repo: newRepo,
          githubUrl: repoData.html_url,
          visibility: repoData.private ? "private" : "public",
        });
        return;
      }

      case "create-repo-from-template": {
        const {
          repoName,
          templateOrg: rawTemplateOrg,
          templateRepo: rawTemplateRepo,
          isPrivate,
        } = body;
        if (!repoName || !rawTemplateOrg || !rawTemplateRepo) {
          res.status(400).json({
            success: false,
            error: "repoName, templateOrg, templateRepo required",
          });
          return;
        }

        // Validate + sanitize GitHub identifiers before they are interpolated
        // into the api.github.com URL to prevent SSRF / path injection.
        const templateOrg = assertGitHubSlug(rawTemplateOrg, "templateOrg");
        const templateRepo = assertGitHubSlug(rawTemplateRepo, "templateRepo");
        assertGitHubSlug(organization, "organization");

        const finalRepoName = buildRepoSlug(repoName);

        const projectResult = await (async () => {
          const _r = await rpc.getProjectWithToken(
            projectId,
            shareToken || null,
          );
          return { rows: _r ? [_r] : [] };
        })();
        const project = projectResult.rows[0];

        const createResp = await fetch(
          `https://api.github.com/repos/${templateOrg}/${templateRepo}/generate`,
          {
            method: "POST",
            headers: ghHeaders,
            body: JSON.stringify({
              owner: organization,
              name: finalRepoName,
              description: `Repository for ${project?.name || "project"} (from ${templateOrg}/${templateRepo})`,
              private: isPrivate ?? true,
            }),
          },
        );

        if (!createResp.ok) {
          const errorText = await createResp.text();
          throw new Error(`GitHub API error: ${errorText}`);
        }
        const repoData = (await createResp.json()) as any;

        await new Promise((resolve) => setTimeout(resolve, 2000));

        const linkResult = await (async () => {
          const _r = await rpc.createProjectRepoWithToken(
            projectId,
            shareToken || null,
            organization,
            finalRepoName,
            "main",
            true,
            true,
          );
          return { rows: _r ? [_r] : [] };
        })();
        const newRepo = linkResult.rows[0];

        // Pull files from newly created repo into database (invoke sync-repo-pull internally)
        try {
          await pullRepoFilesToDatabase(
            newRepo.id,
            organization,
            finalRepoName,
            "main",
            githubPat,
            shareToken,
          );
        } catch (pullError: any) {
          logger.error(
            "[create-repo-from-template] Pull error (non-fatal):",
            pullError.message,
          );
        }

        // Broadcast repo creation to subscribers
        broadcast(`project_repos-${projectId}`, "repos_refresh", {
          action: "created",
          repoId: newRepo?.id,
        });

        res.json({
          success: true,
          repo: newRepo,
          githubUrl: repoData.html_url,
        });
        return;
      }

      case "clone-public-repo": {
        const {
          repoName,
          sourceOrg: rawSourceOrg,
          sourceRepo: rawSourceRepo,
          sourceBranch,
          isPrivate,
        } = body;
        if (!repoName || !rawSourceOrg || !rawSourceRepo) {
          res.status(400).json({
            success: false,
            error: "repoName, sourceOrg, sourceRepo required",
          });
          return;
        }

        // Validate + sanitize GitHub identifiers before they are interpolated
        // into the api.github.com URL to prevent SSRF / path injection.
        const sourceOrg = assertGitHubSlug(rawSourceOrg, "sourceOrg");
        const sourceRepo = assertGitHubSlug(rawSourceRepo, "sourceRepo");
        assertGitHubSlug(organization, "organization");
        const branch = assertGitHubRef(sourceBranch || "main", "sourceBranch");

        const finalRepoName = buildRepoSlug(repoName);

        // Create empty repo in the configured organization.
        const createRepoApiUrl = `https://api.github.com/orgs/${organization}/repos`;
        const createResp = await fetch(createRepoApiUrl, {
          method: "POST",
          headers: ghHeaders,
          body: JSON.stringify({
            name: finalRepoName,
            private: isPrivate ?? true,
            auto_init: true,
            description: `Cloned from ${sourceOrg}/${sourceRepo}`,
          }),
        });

        if (!createResp.ok) {
          const errorData = (await createResp.json()) as any;
          throw new Error(`GitHub API error: ${errorData.message}`);
        }
        const newRepoData = (await createResp.json()) as any;

        // Fetch source tree
        const treeResp = await fetch(
          `https://api.github.com/repos/${sourceOrg}/${sourceRepo}/git/trees/${branch}?recursive=1`,
          { headers: ghHeaders },
        );
        if (!treeResp.ok)
          throw new Error("Failed to fetch source repository tree");
        const treeData = (await treeResp.json()) as any;

        const files = (treeData.tree || []).filter(
          (item: any) => item.type === "blob",
        );
        logger.info(`[clone-public-repo] Found ${files.length} files to clone`);

        // Fetch file contents and push to new repo
        const binaryExtensions = [
          ".png",
          ".jpg",
          ".jpeg",
          ".gif",
          ".ico",
          ".webp",
          ".pdf",
          ".zip",
          ".tar",
          ".gz",
          ".woff",
          ".woff2",
          ".ttf",
          ".eot",
          ".mp3",
          ".mp4",
          ".exe",
          ".dll",
          ".lock",
          ".lockb",
        ];

        const BATCH_SIZE = 50;
        const tree: any[] = [];

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          const batch = files.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.all(
            batch.map(async (file: any) => {
              try {
                const blobResp = await fetch(
                  `https://api.github.com/repos/${sourceOrg}/${sourceRepo}/git/blobs/${file.sha}`,
                  {
                    headers: ghHeaders,
                  },
                );
                if (!blobResp.ok) return null;
                const blobData = (await blobResp.json()) as any;
                const ext = file.path
                  .toLowerCase()
                  .substring(file.path.lastIndexOf("."));
                const isBinary = binaryExtensions.includes(ext);

                if (isBinary) {
                  // Create blob in target repo for binary files
                  const createBlobResp = await fetch(
                    `https://api.github.com/repos/${organization}/${finalRepoName}/git/blobs`,
                    {
                      method: "POST",
                      headers: ghHeaders,
                      body: JSON.stringify({
                        content: blobData.content.replace(/\n/g, ""),
                        encoding: "base64",
                      }),
                    },
                  );
                  if (!createBlobResp.ok) return null;
                  const newBlobData = (await createBlobResp.json()) as any;
                  return {
                    path: file.path,
                    mode: "100644",
                    type: "blob",
                    sha: newBlobData.sha,
                  };
                }

                // Text file - decode and add inline
                let content = blobData.content;
                if (blobData.encoding === "base64") {
                  content = Buffer.from(
                    blobData.content.replace(/\n/g, ""),
                    "base64",
                  ).toString("utf8");
                }
                return {
                  path: file.path,
                  mode: "100644",
                  type: "blob",
                  content,
                };
              } catch {
                return null;
              }
            }),
          );
          tree.push(...batchResults.filter(Boolean));
        }

        if (tree.length === 0)
          throw new Error("No files could be fetched from source");

        // Get initial commit
        const refResp = await fetch(
          `https://api.github.com/repos/${organization}/${finalRepoName}/git/ref/heads/main`,
          {
            headers: ghHeaders,
          },
        );
        const refData = (await refResp.json()) as any;
        const latestSha = refData.object.sha;
        const commitResp = await fetch(
          `https://api.github.com/repos/${organization}/${finalRepoName}/git/commits/${latestSha}`,
          {
            headers: ghHeaders,
          },
        );
        const commitData = (await commitResp.json()) as any;

        // Create tree, commit, update ref
        const createTreeResp = await fetch(
          `https://api.github.com/repos/${organization}/${finalRepoName}/git/trees`,
          {
            method: "POST",
            headers: ghHeaders,
            body: JSON.stringify({ base_tree: commitData.tree.sha, tree }),
          },
        );
        if (!createTreeResp.ok) throw new Error("Failed to create tree");
        const newTreeData = (await createTreeResp.json()) as any;

        const newCommitResp = await fetch(
          `https://api.github.com/repos/${organization}/${finalRepoName}/git/commits`,
          {
            method: "POST",
            headers: ghHeaders,
            body: JSON.stringify({
              message: `Clone from ${sourceOrg}/${sourceRepo}`,
              tree: newTreeData.sha,
              parents: [latestSha],
            }),
          },
        );
        if (!newCommitResp.ok) throw new Error("Failed to create commit");
        const newCommitData = (await newCommitResp.json()) as any;

        await fetch(
          `https://api.github.com/repos/${organization}/${finalRepoName}/git/refs/heads/main`,
          {
            method: "PATCH",
            headers: ghHeaders,
            body: JSON.stringify({ sha: newCommitData.sha, force: true }),
          },
        );

        // Link repo to project
        const linkResult = await (async () => {
          const _r = await rpc.createProjectRepoWithToken(
            projectId,
            shareToken || null,
            organization,
            finalRepoName,
            "main",
            true,
            true,
          );
          return { rows: _r ? [_r] : [] };
        })();
        const newRepo = linkResult.rows[0];

        // Pull files into database
        try {
          await pullRepoFilesToDatabase(
            newRepo.id,
            organization,
            finalRepoName,
            "main",
            githubPat,
            shareToken,
          );
        } catch (pullError: any) {
          logger.error(
            "[clone-public-repo] Pull error (non-fatal):",
            pullError.message,
          );
        }

        // Broadcast repo creation to subscribers
        broadcast(`project_repos-${projectId}`, "repos_refresh", {
          action: "cloned",
          repoId: newRepo?.id,
        });

        res.json({
          success: true,
          repo: newRepo,
          githubUrl: newRepoData.html_url,
          filesCloned: tree.length,
        });
        return;
      }

      case "link-existing-repo": {
        const {
          repoOrganization,
          repo: rawRepo,
          branch: rawBranch,
          pat,
        } = body;
        // Also accept 'organization' param
        const rawOrg = repoOrganization || body.organization;
        if (!rawOrg || !rawRepo || !rawBranch) {
          res.status(400).json({
            success: false,
            error: "organization, repo, branch required",
          });
          return;
        }

        const testPat = pat || githubPat;

        // Validate + sanitize GitHub identifiers before interpolating them into
        // the api.github.com URL to prevent SSRF / path injection.
        const org = assertGitHubSlug(rawOrg, "organization");
        const repo = assertGitHubSlug(rawRepo, "repo");
        const branch = assertGitHubRef(rawBranch, "branch");

        // Verify repo exists
        const repoCheckResp = await fetch(
          `https://api.github.com/repos/${org}/${repo}`,
          {
            headers: {
              Authorization: `token ${testPat}`,
              Accept: "application/vnd.github.v3+json",
            },
          },
        );
        if (!repoCheckResp.ok)
          throw new Error("Repository not found or not accessible");
        const repoCheckData = (await repoCheckResp.json()) as any;

        // Verify branch exists
        const branchCheckResp = await fetch(
          `https://api.github.com/repos/${org}/${repo}/branches/${branch}`,
          {
            headers: {
              Authorization: `token ${testPat}`,
              Accept: "application/vnd.github.v3+json",
            },
          },
        );
        if (!branchCheckResp.ok)
          throw new Error(`Branch '${branch}' not found`);

        // Link repository
        const linkResult = await (async () => {
          const _r = await rpc.createProjectRepoWithToken(
            projectId,
            shareToken || null,
            org,
            repo,
            branch,
            false,
            false,
          );
          return { rows: _r ? [_r] : [] };
        })();
        const newRepo = linkResult.rows[0];

        // Store PAT if provided
        if (pat && req.user?.id) {
          await db.query(
            "INSERT INTO repo_pats (user_id, repo_id, pat) VALUES ($1, $2, $3) ON CONFLICT (repo_id) DO UPDATE SET pat = $3",
            [req.user.id, newRepo.id, pat],
          );
        }

        // Pull files from repo into database
        try {
          await pullRepoFilesToDatabase(
            newRepo.id,
            org,
            repo,
            branch,
            testPat,
            shareToken,
          );
        } catch (pullError: any) {
          logger.error(
            "[link-existing-repo] Pull error (non-fatal):",
            pullError.message,
          );
        }

        // Broadcast repo creation to subscribers
        broadcast(`project_repos-${projectId}`, "repos_refresh", {
          action: "linked",
          repoId: newRepo?.id,
        });

        res.json({
          success: true,
          repo: newRepo,
          githubUrl: repoCheckData.html_url,
        });
        return;
      }

      default:
        res.status(400).json({
          success: false,
          error: `Unknown repo operation: ${functionName}`,
        });
    }
  } catch (error: any) {
    logger.error(`[${functionName}] Error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Helper: Pull all files from a GitHub repo into the database
 */
async function pullRepoFilesToDatabase(
  repoId: string,
  org: string,
  repo: string,
  branch: string,
  pat: string,
  shareToken: string | null,
  projectId?: string,
): Promise<{ filesCount: number; commitSha: string }> {
  // Validate + sanitize GitHub identifiers before interpolating them into
  // api.github.com request URLs (defense in depth; covers all callers).
  org = assertGitHubSlug(org, "organization");
  repo = assertGitHubSlug(repo, "repo");
  branch = assertGitHubRef(branch, "branch");

  // Resolve projectId if not provided
  let resolvedProjectId = projectId;
  if (!resolvedProjectId) {
    const repoLookup = await db.query(
      "SELECT project_id FROM project_repos WHERE id = $1",
      [repoId],
    );
    resolvedProjectId = repoLookup.rows[0]?.project_id;
    if (!resolvedProjectId)
      throw new Error(`No project found for repo ${repoId}`);
  }

  const binaryExtensions = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".ico",
    ".webp",
    ".bmp",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".rar",
    ".7z",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".otf",
    ".mp3",
    ".mp4",
    ".wav",
    ".exe",
    ".dll",
    ".lock",
    ".lockb",
  ];

  const ghHeaders = gitHubApiHeaders(pat, "Pronghorn-Sync");

  // Get latest commit SHA
  const refResp = await fetch(
    `https://api.github.com/repos/${org}/${repo}/git/refs/heads/${branch}`,
    {
      headers: ghHeaders,
    },
  );
  if (!refResp.ok) throw new Error("Failed to get branch reference");
  const refData = (await refResp.json()) as any;
  const targetSha = refData.object.sha;

  // Get tree
  const commitResp = await fetch(
    `https://api.github.com/repos/${org}/${repo}/git/commits/${targetSha}`,
    {
      headers: ghHeaders,
    },
  );
  if (!commitResp.ok) throw new Error("Failed to get commit");
  const commitData = (await commitResp.json()) as any;

  const treeResp = await fetch(
    `https://api.github.com/repos/${org}/${repo}/git/trees/${commitData.tree.sha}?recursive=1`,
    {
      headers: ghHeaders,
    },
  );
  if (!treeResp.ok) throw new Error("Failed to get tree");
  const treeData = (await treeResp.json()) as any;

  const files = (treeData.tree || []).filter(
    (item: any) => item.type === "blob",
  );

  // Fetch file contents in batches
  const BATCH_SIZE = 50;
  const validFiles: any[] = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (file: any) => {
        try {
          const blobResp = await fetch(
            `https://api.github.com/repos/${org}/${repo}/git/blobs/${file.sha}`,
            {
              headers: ghHeaders,
            },
          );
          if (!blobResp.ok) return null;
          const blobData = (await blobResp.json()) as any;
          const ext = file.path
            .toLowerCase()
            .substring(file.path.lastIndexOf("."));
          const isBinary = binaryExtensions.includes(ext);

          let content = blobData.content;
          if (blobData.encoding === "base64") {
            if (isBinary) {
              content = blobData.content.replace(/\n/g, "");
            } else {
              try {
                content = Buffer.from(
                  blobData.content.replace(/\n/g, ""),
                  "base64",
                ).toString("utf8");
              } catch {
                return {
                  path: file.path,
                  content: blobData.content.replace(/\n/g, ""),
                  commit_sha: targetSha,
                  is_binary: true,
                };
              }
            }
          }

          return {
            path: file.path,
            content,
            commit_sha: targetSha,
            is_binary: isBinary,
          };
        } catch {
          return null;
        }
      }),
    );
    validFiles.push(...results.filter(Boolean));
  }

  // Batch upsert — write committed blobs then metadata-only DB rows
  if (validFiles.length > 0) {
    // Write all file content to committed blob storage in parallel
    await Promise.all(
      validFiles.map(async (file: any) => {
        await getRepoBlobStore().writeCommitted(
          resolvedProjectId!,
          repoId,
          file.path,
          file.content,
        );
      }),
    );
    // Upsert metadata-only rows (no content column)
    await rpc.upsertFilesBatchWithToken(
      repoId,
      JSON.stringify(validFiles),
      shareToken || null,
    );
  }

  logger.info(
    `[pullRepoFilesToDatabase] Pulled ${validFiles.length} files for repo ${repoId}`,
  );
  return { filesCount: validFiles.length, commitSha: targetSha };
}

async function handleRepoSync(
  req: Request,
  res: Response,
  body: any,
  functionName: string,
): Promise<void> {
  const {
    repoId,
    projectId,
    shareToken,
    branch,
    commitMessage,
    filePaths,
    deletePaths,
    forcePush,
    sourceRepoId,
  } = body;

  if (!repoId || !projectId) {
    res
      .status(400)
      .json({ success: false, error: "repoId and projectId are required" });
    return;
  }

  try {
    // Validate access - editor role required
    const roleResult = await (async () => {
      const _role = await rpc.authorizeProjectAccess(
        projectId,
        shareToken || null,
      );
      return { rows: [{ role: _role }] };
    })();
    const role = roleResult.rows[0]?.role;
    if (!role || (role !== "owner" && role !== "editor")) {
      res.status(403).json({ success: false, error: "Editor role required" });
      return;
    }

    // Get repo details
    const repoResult = await (async () => {
      const _r = await rpc.getRepoByIdWithToken(repoId, shareToken || null);
      return { rows: _r ? [_r] : [] };
    })();
    const repo = repoResult.rows[0];
    if (!repo) {
      res.status(404).json({ success: false, error: "Repository not found" });
      return;
    }

    // Resolve GitHub token using centralized chain: repo_pats → GitHub App → system env
    const resolved = await resolveGitHubToken({
      userId: req.user?.id,
      repoId,
      isDefaultRepo: repo.is_default,
    });
    if (!resolved) {
      res.status(400).json({
        success: false,
        error:
          "GitHub is not configured. Configure the GitHub App, a per-repo PAT, or a system token.",
      });
      return;
    }
    const pat = resolved.token;
    logger.info(
      `[${functionName}] Using GitHub token from source: ${resolved.source}`,
    );

    if (functionName === "sync-repo-pull") {
      // Pull files from GitHub into database
      const result = await pullRepoFilesToDatabase(
        repoId,
        repo.organization,
        repo.repo,
        repo.branch || branch || "main",
        pat,
        shareToken,
        projectId,
      );
      res.json({
        success: true,
        commitSha: result.commitSha,
        filesCount: result.filesCount,
      });
      return;
    }

    // sync-repo-push
    const fileSourceRepoId = sourceRepoId || repoId;
    const targetBranchRaw = branch || repo.branch || "main";

    // Validate + sanitize GitHub identifiers before interpolating them into
    // api.github.com request URLs to prevent SSRF / path injection. The sanitized
    // ref is reassigned so the validated value flows to every downstream URL.
    assertGitHubSlug(repo.organization, "organization");
    assertGitHubSlug(repo.repo, "repo");
    const targetBranch = assertGitHubRef(targetBranchRaw, "branch");

    // Always get ALL files from database to ensure complete sync
    // Even when filePaths is provided, we push all files to prevent GitHub from
    // having stale/missing files after partial pushes
    const filesResult = await (async () => {
      const _r = await rpc.getRepoFilesWithToken(
        fileSourceRepoId,
        shareToken || null,
      );
      return { rows: _r };
    })();
    const filesToPush = filesResult.rows;

    const hasFilesToPush = filesToPush && filesToPush.length > 0;
    const hasDeletions = deletePaths && deletePaths.length > 0;
    if (!hasFilesToPush && !hasDeletions) {
      res.status(400).json({ success: false, error: "No files to push" });
      return;
    }

    logger.info(
      `[sync-repo-push] Pushing ${filesToPush?.length || 0} files, deleting ${deletePaths?.length || 0} to ${repo.organization}/${repo.repo} on ${targetBranch}`,
    );
    logger.info(
      `[sync-repo-push] File paths being pushed: ${filesToPush?.map((f: any) => f.path).join(", ")}`,
    );
    logger.info(
      `[sync-repo-push] isFullSync: ${!filePaths || filePaths.length === 0}, filePaths param: ${JSON.stringify(filePaths || "undefined")}`,
    );

    // Check if target branch exists, create if not
    const targetBranchResp = await fetch(
      `https://api.github.com/repos/${repo.organization}/${repo.repo}/git/refs/heads/${targetBranch}`,
      {
        headers: {
          Authorization: `token ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Pronghorn-Sync",
        },
      },
    );

    let currentSha: string;
    if (!targetBranchResp.ok) {
      // Create branch from main
      const mainRefResp = await fetch(
        `https://api.github.com/repos/${repo.organization}/${repo.repo}/git/refs/heads/main`,
        {
          headers: {
            Authorization: `token ${pat}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Pronghorn-Sync",
          },
        },
      );
      if (!mainRefResp.ok) {
        const errBody = await mainRefResp.text().catch(() => "");
        throw new Error(
          `Failed to get main branch (${mainRefResp.status}): ${errBody}`,
        );
      }
      const mainRefData = (await mainRefResp.json()) as any;
      currentSha = mainRefData.object.sha;

      const createBranchResp = await fetch(
        `https://api.github.com/repos/${repo.organization}/${repo.repo}/git/refs`,
        {
          method: "POST",
          headers: {
            Authorization: `token ${pat}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "Pronghorn-Sync",
          },
          body: JSON.stringify({
            ref: `refs/heads/${targetBranch}`,
            sha: currentSha,
          }),
        },
      );
      if (!createBranchResp.ok) {
        const errBody = await createBranchResp.text().catch(() => "");
        throw new Error(
          `Failed to create branch ${targetBranch} (${createBranchResp.status}): ${errBody}`,
        );
      }
    } else {
      const refData = (await targetBranchResp.json()) as any;
      currentSha = refData.object.sha;
    }

    // Get current commit
    const commitResp = await fetch(
      `https://api.github.com/repos/${repo.organization}/${repo.repo}/git/commits/${currentSha}`,
      {
        headers: {
          Authorization: `token ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Pronghorn-Sync",
        },
      },
    );
    if (!commitResp.ok) {
      const errBody = await commitResp.text().catch(() => "");
      throw new Error(
        `Failed to get current commit (${commitResp.status}): ${errBody}`,
      );
    }

    // Create blobs for files — read content from committed blob storage
    const tree: any[] = [];
    if (hasFilesToPush) {
      const filesWithContent = await Promise.all(
        filesToPush.map(async (file: any) => {
          const content = await getRepoBlobStore().readCommitted(
            projectId,
            fileSourceRepoId,
            file.path,
          );
          return { path: file.path, content };
        }),
      );
      const pushableFiles = filesWithContent.filter((f) => f.content !== null);
      const fileBlobs = await Promise.all(
        pushableFiles.map(async (file) => {
          const isBase64 =
            /^[A-Za-z0-9+/\n\r]+=*$/.test(
              (file.content || "").replace(/\s/g, ""),
            ) && (file.content || "").length > 100;
          const blobResp = await fetch(
            `https://api.github.com/repos/${repo.organization}/${repo.repo}/git/blobs`,
            {
              method: "POST",
              headers: {
                Authorization: `token ${pat}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "Pronghorn-Sync",
              },
              body: JSON.stringify({
                content: file.content,
                encoding: isBase64 ? "base64" : "utf-8",
              }),
            },
          );
          if (!blobResp.ok) {
            const errBody = await blobResp.text().catch(() => "");
            throw new Error(
              `Failed to create blob for ${file.path} (${blobResp.status}): ${errBody}`,
            );
          }
          const blobData = (await blobResp.json()) as any;
          return {
            path: file.path,
            mode: "100644",
            type: "blob",
            sha: blobData.sha,
          };
        }),
      );
      tree.push(...fileBlobs);
      logger.info(
        `[sync-repo-push] Created ${fileBlobs.length} blob entries: ${fileBlobs.map((b: any) => b.path).join(", ")}`,
      );
    }

    // Explicit deletions from the request (for files explicitly removed by user)
    // These are handled implicitly: since we create a clean tree without base_tree,
    // only files in the tree array will exist in the new commit. Deleted files
    // simply won't be in filesToPush (they were removed from repo_files).

    logger.info(
      `[sync-repo-push] Final tree entries (clean tree - no base_tree): ${tree.map((t: any) => t.path).join(", ")}`,
    );

    // Create tree WITHOUT base_tree — this creates a clean tree containing ONLY
    // the files we specify. No stale files from the previous tree carry over,
    // and no deletion detection is needed.
    const createTreeResp = await fetch(
      `https://api.github.com/repos/${repo.organization}/${repo.repo}/git/trees`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "Pronghorn-Sync",
        },
        body: JSON.stringify({ tree }),
      },
    );
    if (!createTreeResp.ok) {
      const errBody = await createTreeResp.text().catch(() => "");
      throw new Error(
        `Failed to create tree (${createTreeResp.status}): ${errBody}`,
      );
    }
    const newTreeData = (await createTreeResp.json()) as any;

    const totalChanges =
      (filesToPush?.length || 0) + (deletePaths?.length || 0);
    const newCommitResp = await fetch(
      `https://api.github.com/repos/${repo.organization}/${repo.repo}/git/commits`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "Pronghorn-Sync",
        },
        body: JSON.stringify({
          message:
            commitMessage || `Update ${totalChanges} file(s) via Pronghorn`,
          tree: newTreeData.sha,
          parents: [currentSha],
        }),
      },
    );
    if (!newCommitResp.ok) {
      const errBody = await newCommitResp.text().catch(() => "");
      throw new Error(
        `Failed to create commit (${newCommitResp.status}): ${errBody}`,
      );
    }
    const newCommitData = (await newCommitResp.json()) as any;

    const updateRefResp = await fetch(
      `https://api.github.com/repos/${repo.organization}/${repo.repo}/git/refs/heads/${targetBranch}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `token ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "Pronghorn-Sync",
        },
        body: JSON.stringify({
          sha: newCommitData.sha,
          force: forcePush || false,
        }),
      },
    );
    if (!updateRefResp.ok) {
      const errBody = await updateRefResp.text().catch(() => "");
      throw new Error(
        `Failed to update branch (${updateRefResp.status}): ${errBody}`,
      );
    }

    // Log commit
    try {
      const updateCount = await (async () => {
        const _r = await rpc.markCommitsPushedWithToken(
          repoId,
          shareToken || null,
          newCommitData.sha,
          targetBranch,
        );
        return { rows: [{ count: _r }] };
      })();
      if (!updateCount.rows[0]?.count) {
        await rpc.logRepoCommitWithToken(
          repoId,
          shareToken || null,
          targetBranch,
          newCommitData.sha,
          commitMessage || `Update ${totalChanges} file(s) via Pronghorn`,
          totalChanges,
        );
      }
    } catch (logError: any) {
      logger.error("[sync-repo-push] Failed to log commit:", logError.message);
    }

    res.json({
      success: true,
      commitSha: newCommitData.sha,
      filesCount: filesToPush?.length || 0,
      deletedCount: deletePaths?.length || 0,
    });
  } catch (error: any) {
    const errorMessage =
      error?.message || error?.toString?.() || "Unknown sync error";
    logger.error(
      `[${functionName}] Error: ${errorMessage}`,
      error?.stack || "",
    );
    res.status(500).json({ success: false, error: errorMessage });
  }
}

async function handleDatabaseAgentImport(
  req: Request,
  res: Response,
  body: any,
) {
  const {
    projectId,
    shareToken,
    sampleData,
    fileType,
    intent,
    targetTable,
    existingSchema,
    userInstructions,
  } = body;

  try {
    // Validate access
    const roleResult = await (async () => {
      const _role = await rpc.authorizeProjectAccess(
        projectId,
        shareToken || null,
      );
      return { rows: [{ role: _role }] };
    })();
    if (!roleResult.rows[0]?.role) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const { buildEndpointUrl, getDefaultModel } =
      await import("../config/aiModels");
    const defaultModel = getDefaultModel();

    const systemPrompt = `You are a database schema and data import expert. Analyze sample data and propose optimal table structures or field mappings for PostgreSQL.

GUIDELINES:
1. Sanitize column names (lowercase, underscores, no special chars)
2. Infer PostgreSQL types: integers→INTEGER/BIGINT, decimals→NUMERIC, true/false→BOOLEAN, dates→DATE/TIMESTAMP, else→TEXT
3. Suggest primary keys, indexes for likely query columns
4. Default to nullable unless data clearly requires NOT NULL
5. For mapping, match columns semantically (firstName→first_name)

Return JSON with: action, proposed_table_name, columns[], column_mappings[], create_table_sql, indexes[], explanation.`;

    let userPrompt = `Analyze this ${fileType?.toUpperCase() || "CSV"} data for database import.
INTENT: ${intent === "create_new" ? "Create new table(s)" : "Map to existing table"}
TOTAL ROWS: ${sampleData?.totalRows || 0}
HEADERS: ${sampleData?.headers?.join(", ") || "none"}
SAMPLE DATA:
${(sampleData?.rows || [])
  .slice(0, 10)
  .map((row: any, i: number) => `Row ${i + 1}: ${JSON.stringify(row)}`)
  .join("\n")}`;

    if (intent === "import_existing" && targetTable && existingSchema) {
      const tableSchema = existingSchema.find(
        (t: any) => t.table_name === targetTable,
      );
      if (tableSchema) {
        userPrompt += `\nTARGET TABLE: ${targetTable}\nTARGET COLUMNS:\n${tableSchema.columns.map((c: any) => `- ${c.column_name} (${c.data_type}, ${c.is_nullable === "YES" ? "nullable" : "not null"})`).join("\n")}`;
      }
    }
    if (userInstructions)
      userPrompt += `\nUSER INSTRUCTIONS: ${userInstructions}`;

    const endpoint = buildEndpointUrl(defaultModel.id);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 4096,
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) throw new Error(`AI API error: ${response.status}`);

    const aiData = (await response.json()) as any;
    const content = aiData.choices?.[0]?.message?.content || "{}";
    const result = JSON.parse(content);

    // Transform to match frontend expectations
    res.json({
      action: result.action,
      proposedTableName: result.proposed_table_name,
      columns: result.columns?.map((col: any) => ({
        name: col.name,
        inferredType: col.type,
        nullable: col.nullable ?? true,
        isPrimaryKey: col.is_primary_key ?? false,
        isUnique: col.is_unique ?? false,
        shouldIndex: col.should_index ?? false,
      })),
      columnMappings: result.column_mappings?.map((m: any) => ({
        sourceColumn: m.source_column,
        targetColumn: m.target_column || null,
        ignored: m.ignored ?? false,
        casting: m.casting || null,
      })),
      createTableSQL: result.create_table_sql,
      indexes: result.indexes || [],
      explanation: result.explanation,
    });
  } catch (error: any) {
    logger.error("[database-agent-import] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
}

async function handleSuperadminManagement(
  req: Request,
  res: Response,
  body: any,
  functionName: string,
) {
  const { action } = body;
  logger.info(`${functionName}: ${action}`);

  try {
    if (functionName === "superadmin-github-management") {
      const GITHUB_PAT = process.env.GITHUB_PAT;
      const GITHUB_ORG = process.env.GITHUB_ORG;
      if (!GITHUB_PAT) throw new Error("GITHUB_PAT not configured");
      if (!GITHUB_ORG) throw new Error("GITHUB_ORG not configured");

      const githubHeaders = {
        Authorization: `token ${GITHUB_PAT}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Pronghorn-API",
      };

      switch (action) {
        case "list_repos": {
          const repos: any[] = [];
          let page = 1;
          let hasMore = true;
          while (hasMore) {
            const response = await fetch(
              `https://api.github.com/orgs/${GITHUB_ORG}/repos?per_page=100&page=${page}`,
              { headers: githubHeaders },
            );
            if (!response.ok)
              throw new Error(`GitHub API error: ${response.status}`);
            const pageRepos = (await response.json()) as any[];
            repos.push(
              ...pageRepos.map((r: any) => ({
                name: r.name,
                full_name: r.full_name,
                private: r.private,
                created_at: r.created_at,
                updated_at: r.updated_at,
                html_url: r.html_url,
              })),
            );
            hasMore = pageRepos.length === 100;
            page++;
          }
          res.json({ success: true, repos, count: repos.length });
          return;
        }
        case "delete_repo": {
          const { repoName } = body;
          if (!repoName) throw new Error("repoName is required");
          // Validate + sanitize the repo name before interpolating it into the
          // api.github.com URL to prevent SSRF / path injection.
          const safeRepoName = assertGitHubSlug(repoName, "repoName");
          const response = await fetch(
            `https://api.github.com/repos/${GITHUB_ORG}/${safeRepoName}`,
            { method: "DELETE", headers: githubHeaders },
          );
          if (!response.ok && response.status !== 404)
            throw new Error(`Failed to delete repo: ${response.status}`);
          res.json({
            success: true,
            message: `Repository ${repoName} deleted`,
          });
          return;
        }
        default:
          res
            .status(400)
            .json({ success: false, error: `Unknown action: ${action}` });
          return;
      }
    } else if (functionName === "superadmin-cloud-management") {
      // Cloud resource management
      res.json({
        success: true,
        message: "Cloud resource management",
        action,
        services: [],
        databases: [],
      });
    } else {
      res
        .status(400)
        .json({ success: false, error: `Unknown function: ${functionName}` });
    }
  } catch (error: any) {
    logger.error(`[${functionName}] Error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

async function handleEnhanceImage(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const { getImageModelConfig, getDefaultImageModel, buildImageEndpointUrl } =
    await import("../config/aiModels");

  const defaultModel = getDefaultImageModel();
  const { images = [], prompt, model = defaultModel.id } = body;

  if (!prompt) {
    res.status(400).json({ error: "Prompt is required" });
    return;
  }

  // Get model configuration
  const modelConfig = getImageModelConfig(model);
  if (!modelConfig) {
    res.status(400).json({ error: `Unknown image model: ${model}` });
    return;
  }

  try {
    // Build endpoint URL - routes through APIM which handles Managed Identity auth
    const fullUrl = buildImageEndpointUrl(model);
    logger.info(`Calling image generation via APIM: ${fullUrl}`);

    // Build request body for BFL service provider API format
    const hasInputImages = images && images.length > 0;

    const requestBody: any = {
      model: modelConfig.providerModelId, // e.g. "FLUX.2-pro"
      prompt,
      width: 1024,
      height: 1024,
      safety_tolerance: 2,
      output_format: "jpeg",
    };

    // Add input images if provided for editing (BFL supports up to 8)
    if (hasInputImages) {
      const imageData = images[0]?.base64 || images[0];
      // Strip data URL prefix if present
      const base64Image = imageData.replace(/^data:image\/[a-z]+;base64,/, "");
      requestBody.input_image = base64Image;
    }

    // No Authorization header needed - APIM policy adds MI token automatically
    const response = await fetch(fullUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        `Image enhancement failed: ${response.status} - ${errorText}`,
      );

      // Check if this is a text-only response issue
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.message?.includes("text")) {
          res.status(422).json({
            error: "Model returned text instead of image",
            textResponse: errorJson.error.message,
            retryPrompt: `Create a visual image showing: ${prompt}`,
          });
          return;
        }
      } catch (e) {
        // Not JSON, continue with generic error
      }

      res.status(response.status).json({
        error: "Image enhancement failed",
        details: errorText,
      });
      return;
    }

    // Parse response - BFL service provider API format
    const responseData = (await response.json()) as any;
    logger.info(
      `Image generation response keys: ${Object.keys(responseData).join(", ")}`,
    );

    // BFL response format: { sample: "url" } or { image: "url" }
    let imageUrl =
      responseData.sample || responseData.image || responseData.url;

    // Fallback: OpenAI images/generations response format
    if (!imageUrl && responseData.data?.[0]?.url) {
      imageUrl = responseData.data[0].url;
    }
    if (!imageUrl && responseData.data?.[0]?.b64_json) {
      imageUrl = `data:image/png;base64,${responseData.data[0].b64_json}`;
    }

    if (!imageUrl) {
      res.status(500).json({
        error: "No image returned from model",
        response: responseData,
      });
      return;
    }

    res.json({ success: true, imageUrl });
  } catch (error) {
    logger.error("Image enhancement error:", error);
    res
      .status(500)
      .json({ error: "Image enhancement failed", details: String(error) });
  }
}

async function handleOrchestrateAgents(req: Request, res: Response, body: any) {
  const {
    projectId,
    shareToken,
    agentFlow,
    attachedContext,
    iterations = 1,
    orchestratorEnabled = true,
    drawEdges = true,
    startFromNodeId,
    agentPrompts = {},
    selectedModel,
    maxTokens = 32768,
  } = body;

  if (!projectId || !agentFlow?.nodes?.length) {
    res
      .status(400)
      .json({ error: "projectId and agentFlow with nodes required" });
    return;
  }

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (data: any) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  };

  try {
    const { buildEndpointUrl, getDefaultModel, getModelConfig } =
      await import("../config/aiModels");
    const modelConfig = getModelConfig(selectedModel) || getDefaultModel();

    // Validate access
    const roleResult = await (async () => {
      const _role = await rpc.authorizeProjectAccess(
        projectId,
        shareToken || null,
      );
      return { rows: [{ role: _role }] };
    })();
    const role = roleResult.rows[0]?.role;
    if (!role || (role !== "owner" && role !== "editor")) {
      send({ type: "error", message: "Editor role required" });
      res.end();
      return;
    }

    // Fetch node types
    const ntResult = await (async () => {
      const _r = await rpc.getCanvasNodeTypes(true);
      return { rows: _r };
    })();
    const nodeTypes = ntResult.rows || [];
    const allowedNodeTypes = nodeTypes
      .filter((nt: any) => nt.is_active)
      .map((nt: any) => nt.system_name);
    const FLOW_ORDER: Record<string, number> = {};
    const X_POSITIONS: Record<string, number> = {};
    nodeTypes.forEach((nt: any) => {
      FLOW_ORDER[nt.system_name] = Math.floor(nt.order_score / 100);
      X_POSITIONS[nt.system_name] =
        nt.order_score + Math.floor(nt.order_score * 0.5);
    });
    const getFlowRank = (t: string) => FLOW_ORDER[(t || "").toUpperCase()] || 5;

    const flowHierarchy = (() => {
      const groups = new Map<number, string[]>();
      nodeTypes
        .filter((nt: any) => nt.is_active && !nt.is_legacy)
        .forEach((nt: any) => {
          const rank = Math.floor(nt.order_score / 100);
          if (!groups.has(rank)) groups.set(rank, []);
          groups.get(rank)!.push(nt.system_name);
        });
      return Array.from(groups.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([rank, types]) => `Level ${rank}: ${types.join(", ")}`)
        .join("\n");
    })();

    const nodeTypeDescriptions = nodeTypes
      .filter((nt: any) => !nt.is_legacy && nt.is_active)
      .map(
        (nt: any) =>
          `- ${nt.system_name}: ${nt.description || nt.display_label}`,
      )
      .join("\n");

    // Build execution order (topological sort)
    function buildExecutionOrder(nodes: any[], edges: any[]) {
      const graph = new Map<string, string[]>();
      nodes.forEach((n: any) => graph.set(n.id, []));
      edges.forEach((e: any) => {
        const t = graph.get(e.source) || [];
        t.push(e.target);
        graph.set(e.source, t);
      });
      const incoming = new Map<string, number>();
      nodes.forEach((n: any) => incoming.set(n.id, 0));
      edges.forEach((e: any) =>
        incoming.set(e.target, (incoming.get(e.target) || 0) + 1),
      );
      const start =
        nodes.find((n: any) => (incoming.get(n.id) || 0) === 0) || nodes[0];
      const order: any[] = [],
        visited = new Set<string>();
      const traverse = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        const n = nodes.find((nd: any) => nd.id === id);
        if (n) {
          order.push(n);
          (graph.get(id) || []).forEach(traverse);
        }
      };
      traverse(start.id);
      nodes.forEach((n: any) => {
        if (!visited.has(n.id)) order.push(n);
      });
      return order;
    }

    // Robust JSON parser
    function parseAIResponse(content: string): any {
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch)
        try {
          return JSON.parse(jsonMatch[1]);
        } catch {}
      try {
        return JSON.parse(content);
      } catch {}
      let braceCount = 0,
        startIdx = -1;
      for (let i = 0; i < content.length; i++) {
        if (content[i] === "{") {
          if (braceCount === 0) startIdx = i;
          braceCount++;
        } else if (content[i] === "}") {
          braceCount--;
          if (braceCount === 0 && startIdx !== -1)
            try {
              return JSON.parse(content.substring(startIdx, i + 1));
            } catch {
              startIdx = -1;
            }
        }
      }
      throw new Error("Failed to parse AI response");
    }

    let executionOrder = buildExecutionOrder(
      agentFlow.nodes,
      agentFlow.edges || [],
    );
    if (startFromNodeId) {
      const idx = executionOrder.findIndex(
        (n: any) => n.id === startFromNodeId,
      );
      if (idx > 0) executionOrder = executionOrder.slice(idx);
    }

    const changeLogs: any[] = [],
      metrics: any[] = [],
      blackboard: string[] = [];

    // Enrich artifact content from blob storage before agents use it
    const resolvedAttached = attachedContext
      ? await resolveAttachedContext(attachedContext, projectId)
      : null;

    const deltaNodes = resolvedAttached?.canvasNodes
      ? [...resolvedAttached.canvasNodes]
      : [];
    const deltaEdges = resolvedAttached?.canvasEdges
      ? [...resolvedAttached.canvasEdges]
      : [];
    const deltaNodeIds = new Set(deltaNodes.map((n: any) => n.id));
    const deltaEdgeIds = new Set(deltaEdges.map((e: any) => e.id));

    // Execute a single agent
    async function executeAgent(agentNode: any, ctx: any) {
      const systemPrompt =
        ctx.customPrompt?.system || agentNode.data.systemPrompt;
      const userAddition = ctx.customPrompt?.user || "";
      const capabilities = ctx.capabilities || [];
      let contextPrompt = `Current Canvas Delta (Cumulative Changes):\n- Nodes: ${ctx.currentNodes.length}\n- Edges: ${ctx.currentEdges.length}\n\n`;

      if (blackboard.length > 0) {
        contextPrompt += `=== SHARED BLACKBOARD MEMORY ===\n${blackboard.join("\n\n")}\n=== END BLACKBOARD ===\n\n`;
      }

      // Project context
      if (ctx.attachedContext) {
        const ac = ctx.attachedContext;
        if (ac.projectMetadata)
          contextPrompt += `=== PROJECT ===\nName: ${ac.projectMetadata.name}\n${ac.projectMetadata.description ? `Description: ${ac.projectMetadata.description}\n` : ""}\n`;
        if (ac.artifacts?.length) {
          contextPrompt += `=== ARTIFACTS (${ac.artifacts.length}) ===\n`;
          ac.artifacts.forEach((a: any) => {
            contextPrompt += `- ${a.ai_title || "Untitled"}${a.ai_summary ? `: ${a.ai_summary}` : ""}\n`;
            if (a.content) {
              const preview =
                a.content.length > 2000
                  ? a.content.substring(0, 2000) + "..."
                  : a.content;
              contextPrompt += `  Content:\n${preview}\n`;
            }
          });
          contextPrompt += "\n";
        }
        if (ac.requirements?.length) {
          contextPrompt += `=== REQUIREMENTS (${ac.requirements.length}) ===\n`;
          ac.requirements.forEach((r: any) => {
            contextPrompt += `- ${r.code || ""} ${r.title}: ${r.content || ""}\n`;
          });
          contextPrompt += "\n";
        }
        if (ac.standards?.length) {
          contextPrompt += `=== STANDARDS (${ac.standards.length}) ===\n`;
          ac.standards.forEach((s: any) => {
            contextPrompt += `- ${s.code || ""} ${s.title}: ${s.description || ""}\n`;
          });
          contextPrompt += "\n";
        }
        if (ac.techStacks?.length) {
          contextPrompt += `=== TECH STACKS (${ac.techStacks.length}) ===\n`;
          ac.techStacks.forEach((t: any) => {
            contextPrompt += `- ${t.name}: ${t.description || ""}\n`;
          });
          contextPrompt += "\n";
        }
        if (ac.canvasNodes?.length) {
          contextPrompt += `=== SELECTED CANVAS NODES (${ac.canvasNodes.length}) ===\n`;
          ac.canvasNodes.forEach((n: any) => {
            contextPrompt += `- ${n.data?.label || "Unnamed"} (${n.type})\n`;
          });
          contextPrompt += "\n";
        }
        if (ac.files?.length) {
          contextPrompt += `=== REPOSITORY FILES (${ac.files.length}) ===\n`;
          ac.files.forEach((f: any) => {
            contextPrompt += `--- ${f.path} ---\n${f.content?.substring(0, 500)}${f.content?.length > 500 ? "..." : ""}\n\n`;
          });
          contextPrompt += "\n";
        }
      }

      contextPrompt += `=== NODE TYPE & ID RULES ===\nAllowed node types:\n${nodeTypeDescriptions}\n\nFlow hierarchy:\n${flowHierarchy}\n\n`;
      contextPrompt += "Current Nodes in Delta:\n";
      ctx.currentNodes.forEach((node: any) => {
        contextPrompt += `- ${node.id}: ${node.data?.label || "Unnamed"} (Type: ${node.type || node.data?.type || "UNKNOWN"}, FlowRank: ${getFlowRank(node.type || node.data?.type || "")})\n`;
      });
      contextPrompt += "\nCurrent Edges in Delta:\n";
      if (ctx.currentEdges?.length)
        ctx.currentEdges.forEach((e: any) => {
          contextPrompt += `- ${e.id}: ${e.source_id || e.source} -> ${e.target_id || e.target}${e.label ? ` (${e.label})` : ""}\n`;
        });
      else contextPrompt += "(No edges)\n";
      contextPrompt += "\nIMPORTANT: Do NOT recreate existing items. Only add NEW elements.\n";
      contextPrompt += "\nReturn JSON: { \"reasoning\": \"...\", \"nodesToAdd\": [{type,label,description}], \"nodesToEdit\": [{id,updates:{label}}], \"nodesToDelete\": [\"id\"], \"edgesToAdd\": [{source,target,label}], \"edgesToDelete\": [\"id\"] }\n";
      if (userAddition)
        contextPrompt += `\n=== ADDITIONAL INSTRUCTIONS ===\n${userAddition}\n`;

      // Call AI via Azure Foundry
      const endpoint = buildEndpointUrl(modelConfig.id);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content: systemPrompt || "You are an expert AI architect agent.",
            },
            { role: "user", content: contextPrompt },
          ],
          max_tokens: Math.min(maxTokens, 16384),
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok)
        throw new Error(
          `AI API Error: ${response.status} ${await response.text()}`,
        );
      const aiData = (await response.json()) as any;
      const content = aiData.choices?.[0]?.message?.content || "";
      const aiResponse = parseAIResponse(content);

      // Apply changes via RPC
      let nodesAdded = 0,
        nodesEdited = 0,
        nodesDeleted = 0,
        edgesAdded = 0,
        edgesDeleted = 0;
      const newNodeIds: string[] = [];
      const nodeTypeMap = new Map<string, string>();
      ctx.currentNodes.forEach((n: any) =>
        nodeTypeMap.set(n.id, n.type || n.data?.type || "WEB_COMPONENT"),
      );

      const canAdd =
        capabilities.length === 0 || capabilities.includes("add_nodes");
      const canEdit =
        capabilities.length === 0 || capabilities.includes("edit_nodes");
      const canDelete =
        capabilities.length === 0 || capabilities.includes("delete_nodes");
      const canAddEdges =
        capabilities.length === 0 || capabilities.includes("add_edges");
      const canDeleteEdges =
        capabilities.length === 0 || capabilities.includes("delete_edges");

      // Add nodes
      if (aiResponse.nodesToAdd && canAdd) {
        for (const nd of aiResponse.nodesToAdd) {
          try {
            const newId = crypto.randomUUID();
            const rawType = (
              typeof nd.type === "string" ? nd.type : ""
            ).toUpperCase();
            let nodeType = allowedNodeTypes.includes(rawType)
              ? rawType
              : "WEB_COMPONENT";
            if (!allowedNodeTypes.includes(rawType)) {
              if (rawType.includes("DATA")) nodeType = "DATABASE";
              else if (rawType.includes("API")) nodeType = "API_SERVICE";
            }
            const xPos = (X_POSITIONS[nodeType] || 700) + Math.random() * 100;
            await rpc.upsertCanvasNodeWithToken(
              newId,
              projectId,
              shareToken || null,
              nodeType,
              JSON.stringify({ x: xPos, y: Math.random() * 600 }),
              JSON.stringify({
                label: nd.label,
                description: nd.description,
                type: nodeType,
              }),
            );
            newNodeIds.push(newId);
            nodeTypeMap.set(newId, nodeType);
            nodesAdded++;
          } catch (err) {
            logger.error("[orchestrate-agents] Add node error:", err);
          }
        }
      }

      // Edit nodes
      if (aiResponse.nodesToEdit && canEdit) {
        for (const edit of aiResponse.nodesToEdit) {
          try {
            const existing = ctx.currentNodes.find(
              (n: any) => n.id === edit.id,
            );
            if (existing) {
              await rpc.upsertCanvasNodeWithToken(
                edit.id,
                projectId,
                shareToken || null,
                existing.type,
                JSON.stringify(existing.position),
                JSON.stringify({
                  ...existing.data,
                  ...edit.updates,
                  type: existing.type,
                }),
              );
              nodesEdited++;
            }
          } catch (err) {
            logger.error("[orchestrate-agents] Edit node error:", err);
          }
        }
      }

      // Delete nodes
      if (aiResponse.nodesToDelete && canDelete) {
        for (const nodeId of aiResponse.nodesToDelete) {
          try {
            await rpc.deleteCanvasNodeWithToken(nodeId, shareToken || null);
            nodesDeleted++;
          } catch (err) {
            logger.error("[orchestrate-agents] Delete node error:", err);
          }
        }
      }

      // Add edges
      if (drawEdges && aiResponse.edgesToAdd && canAddEdges) {
        const validIds = new Set([
          ...ctx.currentNodes.map((n: any) => n.id),
          ...newNodeIds,
        ]);
        for (const edge of aiResponse.edgesToAdd) {
          try {
            if (!validIds.has(edge.source) || !validIds.has(edge.target))
              continue;
            const srcType = nodeTypeMap.get(edge.source) || "WEB_COMPONENT";
            const tgtType = nodeTypeMap.get(edge.target) || "WEB_COMPONENT";
            let src = edge.source,
              tgt = edge.target,
              lbl = edge.label || "";
            if (getFlowRank(srcType) > getFlowRank(tgtType)) {
              src = edge.target;
              tgt = edge.source;
              lbl = lbl || "depends on";
            }
            const newEdgeId = crypto.randomUUID();
            await rpc.upsertCanvasEdgeWithToken(
              newEdgeId,
              projectId,
              shareToken || null,
              src,
              tgt,
              lbl,
              "default",
              JSON.stringify({ stroke: "hsl(var(--primary))", strokeWidth: 2 }),
            );
            edgesAdded++;
          } catch (err) {
            logger.error("[orchestrate-agents] Add edge error:", err);
          }
        }
      }

      // Delete edges
      if (drawEdges && aiResponse.edgesToDelete && canDeleteEdges) {
        for (const edgeId of aiResponse.edgesToDelete) {
          try {
            await rpc.deleteCanvasEdgeWithToken(edgeId, shareToken || null);
            edgesDeleted++;
          } catch {}
        }
      }

      return {
        reasoning: aiResponse.reasoning || "",
        changes: JSON.stringify(aiResponse),
        metrics: {
          nodesAdded,
          nodesEdited,
          nodesDeleted,
          edgesAdded,
          edgesEdited: 0,
          edgesDeleted,
        },
        nodesToAdd: aiResponse.nodesToAdd || [],
        nodesToEdit: aiResponse.nodesToEdit || [],
        nodesToDelete: aiResponse.nodesToDelete || [],
        edgesToAdd: aiResponse.edgesToAdd || [],
        edgesToEdit: [],
        edgesToDelete: aiResponse.edgesToDelete || [],
        newNodeIds,
      };
    }

    // Execute orchestrator (post-agent guidance)
    async function executeOrchestrator(ctx: any) {
      const prompt = `You are the Orchestrator supervising agents.\nAgent: ${ctx.agentLabel}\nIteration: ${ctx.iteration}\nChanges: ${ctx.changes}\nReasoning: ${ctx.reasoning}\nNodes: ${ctx.currentNodes.length}, Edges: ${ctx.currentEdges.length}\nBlackboard: ${blackboard.length > 0 ? blackboard.join("\n") : "None"}\nProvide brief guidance (2-3 sentences) for architectural coherence.`;
      const endpoint = buildEndpointUrl(modelConfig.id);
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          max_tokens: 2048,
        }),
      });
      if (!resp.ok) throw new Error(`Orchestrator AI error: ${resp.status}`);
      const data = (await resp.json()) as any;
      return (data.choices?.[0]?.message?.content || "").trim();
    }

    // Main iteration loop
    for (let iteration = 1; iteration <= iterations; iteration++) {
      send({ type: "iteration_start", iteration, totalIterations: iterations });

      for (const agentNode of executionOrder) {
        send({
          type: "agent_start",
          iteration,
          agentId: agentNode.data.type,
          agentLabel: agentNode.data.label,
        });

        try {
          const result = await executeAgent(agentNode, {
            projectId,
            shareToken,
            currentNodes: deltaNodes,
            currentEdges: deltaEdges,
            attachedContext: resolvedAttached,
            iteration,
            capabilities: agentNode.data.capabilities,
            customPrompt: agentPrompts[agentNode.id],
          });

          // Refresh canvas state from DB
          const nodesResult = await (async () => {
            const _r = await rpc.getCanvasNodesWithToken(
              projectId,
              shareToken || null,
            );
            return { rows: _r };
          })();
          const edgesResult = await (async () => {
            const _r = await rpc.getCanvasEdgesWithToken(
              projectId,
              shareToken || null,
            );
            return { rows: _r };
          })();
          const allNodes = nodesResult.rows || [];
          const allEdges = edgesResult.rows || [];

          // Update delta with new nodes
          if (result.newNodeIds?.length) {
            for (const newId of result.newNodeIds) {
              const fetched = allNodes.find((n: any) => n.id === newId);
              if (fetched && !deltaNodeIds.has(fetched.id)) {
                deltaNodes.push(fetched);
                deltaNodeIds.add(fetched.id);
              }
            }
          }
          // Update edited nodes
          if (result.nodesToEdit?.length) {
            for (const ed of result.nodesToEdit) {
              const idx = deltaNodes.findIndex((n: any) => n.id === ed.id);
              if (idx !== -1) {
                const f = allNodes.find((n: any) => n.id === ed.id);
                if (f) deltaNodes[idx] = f;
              }
            }
          }
          // Remove deleted nodes
          if (result.nodesToDelete?.length) {
            for (const delId of result.nodesToDelete) {
              const idx = deltaNodes.findIndex((n: any) => n.id === delId);
              if (idx !== -1) {
                deltaNodes.splice(idx, 1);
                deltaNodeIds.delete(delId);
              }
            }
          }
          // Update edges similarly
          if (result.edgesToAdd?.length) {
            for (const es of result.edgesToAdd) {
              const f = allEdges.find(
                (e: any) =>
                  e.source_id === es.source &&
                  e.target_id === es.target &&
                  !deltaEdgeIds.has(e.id),
              );
              if (f) {
                deltaEdges.push(f);
                deltaEdgeIds.add(f.id);
              }
            }
          }
          if (result.edgesToDelete?.length) {
            for (const delId of result.edgesToDelete) {
              const idx = deltaEdges.findIndex((e: any) => e.id === delId);
              if (idx !== -1) {
                deltaEdges.splice(idx, 1);
                deltaEdgeIds.delete(delId);
              }
            }
          }

          const changeLog = {
            iteration,
            agentId: agentNode.data.type,
            agentLabel: agentNode.data.label,
            timestamp: new Date().toISOString(),
            changes: result.changes,
            reasoning: result.reasoning,
          };
          changeLogs.push(changeLog);
          const metric = {
            iteration,
            agentId: agentNode.data.type,
            agentLabel: agentNode.data.label,
            ...result.metrics,
            timestamp: new Date().toISOString(),
          };
          metrics.push(metric);

          send({
            type: "agent_complete",
            iteration,
            agentId: agentNode.data.type,
            changeLog,
            metric,
            currentCounts: {
              nodes: deltaNodes.length,
              edges: deltaEdges.length,
            },
          });

          // Orchestrator guidance
          if (orchestratorEnabled) {
            try {
              const guidance = await executeOrchestrator({
                agentLabel: agentNode.data.label,
                changes: result.changes,
                reasoning: result.reasoning,
                currentNodes: deltaNodes,
                currentEdges: deltaEdges,
                iteration,
              });
              const entry = `[Iteration ${iteration} - After ${agentNode.data.label}]: ${guidance}`;
              blackboard.push(entry);
              send({
                type: "blackboard_update",
                iteration,
                entry,
                blackboard: [...blackboard],
              });
            } catch (orchErr) {
              logger.error("[orchestrate-agents] Orchestrator error:", orchErr);
            }
          }
        } catch (agentError: any) {
          logger.error(
            `[orchestrate-agents] Agent ${agentNode.data.label} error:`,
            agentError.message,
          );
          // Retry once
          try {
            send({
              type: "agent_retry",
              iteration,
              agentId: agentNode.data.type,
              attempt: 1,
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const retryResult = await executeAgent(agentNode, {
              projectId,
              shareToken,
              currentNodes: deltaNodes,
              currentEdges: deltaEdges,
              attachedContext: resolvedAttached,
              iteration,
              capabilities: agentNode.data.capabilities,
            });
            const cl = {
              iteration,
              agentId: agentNode.data.type,
              agentLabel: agentNode.data.label,
              timestamp: new Date().toISOString(),
              changes: retryResult.changes,
              reasoning: `[RETRY] ${retryResult.reasoning}`,
            };
            changeLogs.push(cl);
            metrics.push({
              iteration,
              agentId: agentNode.data.type,
              agentLabel: agentNode.data.label,
              ...retryResult.metrics,
              timestamp: new Date().toISOString(),
            });
            send({
              type: "agent_complete",
              iteration,
              agentId: agentNode.data.type,
              changeLog: cl,
              metric: metrics[metrics.length - 1],
            });
          } catch {
            send({
              type: "agent_error",
              iteration,
              agentId: agentNode.data.type,
              error: agentError.message,
            });
          }
        }
      }

      send({ type: "iteration_complete", iteration });
    }

    send({ type: "complete", changeLogs, metrics });
    res.end();
  } catch (error: any) {
    logger.error("[orchestrate-agents] Error:", error.message);
    send({ type: "error", message: error.message });
    res.end();
  }
}

async function handleChatStream(
  req: Request,
  res: Response,
  body: any,
  functionName: string,
) {
  const provider = functionName.replace("chat-stream-", "");
  logger.info(`Chat stream: ${provider}`);

  const {
    systemPrompt,
    userPrompt,
    messages = [],
    model,
    maxOutputTokens = 4096,
    attachedContext = null,
    projectId = null,
  } = body;

  // Set up SSE headers - CRITICAL: Must disable buffering for streaming to work through proxies
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx/proxy buffering
  res.flushHeaders(); // Send headers immediately

  try {
    if (provider === "foundry") {
      // Azure AI Foundry via APIM - APIM handles Managed Identity auth to AI Foundry
      const { getModelConfig, buildEndpointUrl, getDefaultModel } =
        await import("../config/aiModels");

      const modelConfig = getModelConfig(model);
      let actualModel = model;

      // Fall back to default model if selected model is not found (e.g., old project with deprecated model)
      if (!modelConfig) {
        const defaultModel = getDefaultModel();
        logger.warn(
          `Model ${model} not found, falling back to default: ${defaultModel.id}`,
        );
        actualModel = defaultModel.id;
      }

      const endpoint = buildEndpointUrl(actualModel);
      logger.info(`Calling AI Foundry via APIM: ${endpoint}`);

      // Enrich artifact content from blob storage and build system prompt
      const resolvedContext =
        attachedContext && projectId
          ? await resolveAttachedContext(attachedContext, projectId)
          : attachedContext;

      let enrichedSystemPrompt =
        systemPrompt || "You are a helpful AI assistant.";
      if (resolvedContext) {
        const contextParts: string[] = [];
        if (resolvedContext.projectMetadata)
          contextParts.push("PROJECT METADATA: included");
        if (resolvedContext.artifacts?.length)
          contextParts.push(`ARTIFACTS: ${resolvedContext.artifacts.length}`);
        if (resolvedContext.requirements?.length)
          contextParts.push(
            `REQUIREMENTS: ${resolvedContext.requirements.length}`,
          );
        if (resolvedContext.standards?.length)
          contextParts.push(`STANDARDS: ${resolvedContext.standards.length}`);
        if (resolvedContext.files?.length)
          contextParts.push(`FILES: ${resolvedContext.files.length}`);
        if (resolvedContext.databases?.length)
          contextParts.push(`DATABASES: ${resolvedContext.databases.length}`);

        if (contextParts.length > 0) {
          const jsonString = JSON.stringify(resolvedContext, null, 2);
          const truncated =
            jsonString.length > 100000
              ? jsonString.slice(0, 100000) + "\n...[truncated]"
              : jsonString;
          enrichedSystemPrompt = `${enrichedSystemPrompt}\n\n===== ATTACHED CONTEXT =====\n${contextParts.join("\n")}\n\n${truncated}`;
        }
      }

      // Build messages array
      const chatMessages = [
        {
          role: "system",
          content: enrichedSystemPrompt,
        },
        ...(messages.length > 0
          ? messages
          : [{ role: "user", content: userPrompt }]),
      ];

      const requestBody = {
        messages: chatMessages,
        max_tokens: Math.min(maxOutputTokens || 4096, 16384), // Cap at 16k to avoid errors
        stream: true,
      };

      logger.info(
        `APIM request body: ${JSON.stringify({ model, messagesCount: chatMessages.length, max_tokens: requestBody.max_tokens })}`,
      );

      // No Authorization header needed - APIM policy adds MI token automatically
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      logger.info(`APIM response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`APIM error response: ${errorText}`);
        throw new Error(
          `Azure Foundry API error: ${response.status} ${errorText}`,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;

        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") {
            if (jsonStr === "[DONE]") {
              res.write(
                `data: ${JSON.stringify({ type: "done", finishReason: "STOP" })}\n\n`,
              );
            }
            continue;
          }

          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              res.write(
                `data: ${JSON.stringify({ type: "delta", text: delta.content })}\n\n`,
              );
            }
            if (parsed.choices?.[0]?.finish_reason) {
              res.write(
                `data: ${JSON.stringify({ type: "done", finishReason: parsed.choices[0].finish_reason })}\n\n`,
              );
            }
          } catch {
            /* Skip parse errors */
          }
        }
      }

      reader.releaseLock();
      res.end();
    } else {
      throw new Error(
        `Provider ${provider} not supported. All AI calls must use 'foundry' provider via APIM.`,
      );
    }
  } catch (error: any) {
    const errorMessage = error?.message || error?.toString() || "Unknown error";
    logger.error(`Chat stream error (${provider}): ${errorMessage}`, error);
    res.write(
      `data: ${JSON.stringify({ type: "error", error: errorMessage })}\n\n`,
    );
    res.end();
  }
}

async function handleCollaborationOrchestrator(
  req: Request,
  res: Response,
  body: any,
) {
  const {
    action,
    systemPrompt,
    userPrompt,
    artifacts,
    context,
    model: requestedModel,
    maxOutputTokens,
  } = body;
  logger.info(`Collaboration orchestrator: ${action}`);

  // Set up SSE for streaming - CRITICAL: Must disable buffering for streaming to work through proxies
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    const { getModelConfig, buildEndpointUrl } =
      await import("../config/aiModels");

    const model = requestedModel || "gpt-4o";
    const modelConfig = getModelConfig(model);
    if (!modelConfig) {
      throw new Error(`Model ${model} not found`);
    }

    const endpoint = buildEndpointUrl(model);
    const token = await getAzureTokenForScope(AzureScope.CognitiveServices);

    const defaultSystemPrompt = `You are a collaborative AI assistant that helps teams work together on artifacts, documents, and projects. 
You can analyze content, suggest improvements, and help coordinate changes across multiple artifacts.
When given context about existing artifacts, consider their relationships and maintain consistency.`;

    const messages = [
      { role: "system", content: systemPrompt || defaultSystemPrompt },
      {
        role: "user",
        content: userPrompt || JSON.stringify({ action, artifacts, context }),
      },
    ];

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages,
        max_tokens: maxOutputTokens || 8192,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure OpenAI error: ${response.status} ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;

      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data: ")) continue;

        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") {
          if (jsonStr === "[DONE]") {
            res.write(
              `data: ${JSON.stringify({ type: "done", finishReason: "STOP" })}\n\n`,
            );
          }
          continue;
        }

        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            res.write(
              `data: ${JSON.stringify({ type: "delta", text: delta.content })}\n\n`,
            );
          }
        } catch {
          /* Skip parse errors */
        }
      }
    }

    reader.releaseLock();
    res.end();
  } catch (error: any) {
    logger.error("Collaboration orchestrator error:", error.message);
    res.write(
      `data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`,
    );
    res.end();
  }
}

async function handleDatabaseAgentOrchestrator(
  req: Request,
  res: Response,
  body: any,
) {
  const { action } = body;
  logger.info(`Database agent: ${action}`);
  res.json({ success: true, action });
}

async function handleGenerateSpecification(
  req: Request,
  res: Response,
  body: any,
) {
  const {
    systemPrompt,
    userPrompt,
    context,
    model: requestedModel,
    maxOutputTokens,
  } = body;

  // Set up SSE for streaming - CRITICAL: Must disable buffering for streaming to work through proxies
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    const { getModelConfig, buildEndpointUrl } =
      await import("../config/aiModels");

    const model = requestedModel || "gpt-4o";
    const modelConfig = getModelConfig(model);
    if (!modelConfig) {
      throw new Error(`Model ${model} not found`);
    }

    const endpoint = buildEndpointUrl(model);
    const token = await getAzureTokenForScope(AzureScope.CognitiveServices);

    const messages = [
      {
        role: "system",
        content:
          systemPrompt ||
          "You are an expert technical writer who creates detailed specifications.",
      },
      { role: "user", content: userPrompt || JSON.stringify(context) },
    ];

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages,
        max_tokens: maxOutputTokens || 8192,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure OpenAI error: ${response.status} ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;

      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data: ")) continue;

        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") {
          if (jsonStr === "[DONE]") {
            res.write(
              `data: ${JSON.stringify({ type: "done", finishReason: "STOP" })}\n\n`,
            );
          }
          continue;
        }

        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            res.write(
              `data: ${JSON.stringify({ type: "delta", text: delta.content })}\n\n`,
            );
          }
        } catch {
          /* Skip parse errors */
        }
      }
    }

    reader.releaseLock();
    res.end();
  } catch (error: any) {
    logger.error("Generate specification error:", error.message);
    res.write(
      `data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`,
    );
    res.end();
  }
}

async function handleIngestArtifacts(req: Request, res: Response, body: any) {
  const startTime = Date.now();
  const MAX_ITEMS = 100;
  const MAX_SINGLE_ITEM_SIZE = 10 * 1024 * 1024; // 10MB

  try {
    const projectId = (req.headers["x-project-id"] as string) || body.projectId;
    const token = (req.headers["x-share-token"] as string) || body.token;
    const items = body.items || [];

    if (!projectId) {
      res.status(400).json({ success: false, error: "Missing projectId" });
      return;
    }
    if (!token) {
      res.status(400).json({ success: false, error: "Missing token" });
      return;
    }
    if (!items.length) {
      res.status(400).json({ success: false, error: "No items provided" });
      return;
    }
    if (items.length > MAX_ITEMS) {
      res.status(400).json({
        success: false,
        error: `Too many items. Maximum is ${MAX_ITEMS}`,
      });
      return;
    }

    // Validate access
    const roleResult = await (async () => {
      const _role = await rpc.requireRole(projectId, token, "editor");
      return { rows: [{ role: _role }] };
    })();
    if (!roleResult.rows[0]?.role) {
      res.status(403).json({ success: false, error: "Access denied" });
      return;
    }

    const results: any[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        if (!item.type || !item.content) {
          results.push({
            success: false,
            error: "Missing type or content",
            index: i,
          });
          continue;
        }
        if (item.content.length > MAX_SINGLE_ITEM_SIZE * 1.4) {
          results.push({
            success: false,
            error: "Item exceeds 10MB limit",
            index: i,
          });
          continue;
        }

        let imageUrl: string | null = null;
        let artifactContent = item.content;

        // Handle image/binary uploads
        if (item.type === "image" || item.type === "binary") {
          const fs = await import("fs");
          const path = await import("path");
          const binaryData = Buffer.from(item.content, "base64");
          const extMap: Record<string, string> = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/gif": "gif",
            "image/webp": "webp",
            "application/pdf": "pdf",
            "text/plain": "txt",
            "application/json": "json",
          };
          const ext = extMap[item.contentType || ""] || "bin";
          const baseName = item.fileName
            ? item.fileName.replace(/\.[^/.]+$/, "")
            : "webhook";
          const uniqueName = `${baseName}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;

          const uploadsDir = path.join(
            process.cwd(),
            "storage",
            "artifact-images",
            projectId,
          );
          fs.mkdirSync(uploadsDir, { recursive: true });
          fs.writeFileSync(path.join(uploadsDir, uniqueName), binaryData);
          imageUrl = `/api/v1/storage/artifact-images/${projectId}/${uniqueName}`;

          if (item.type === "image")
            artifactContent = item.title || `Image: ${uniqueName}`;
        }

        const artifactResult = await (async () => {
          const _r = await rpc.insertArtifactWithToken(
            projectId,
            token,
            item.title
              ? `# ${item.title}\n\n${artifactContent}`
              : artifactContent,
            "webhook",
            null,
            imageUrl,
          );
          return { rows: [{ artifact_id: _r?.id }] };
        })();
        const artifactId = artifactResult.rows[0]?.artifact_id;
        results.push({
          success: true,
          artifactId,
          imageUrl: imageUrl || undefined,
          index: i,
        });
      } catch (itemError: any) {
        results.push({ success: false, error: itemError.message, index: i });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    // Broadcast artifact refresh to subscribers
    if (successCount > 0)
      broadcast(`project-${projectId}-artifacts`, "artifact_refresh", {
        action: "batch_created",
        count: successCount,
        projectId,
      });

    res.json({
      success: failureCount === 0,
      message: `Processed ${items.length} items: ${successCount} created, ${failureCount} failed`,
      projectId,
      itemsReceived: items.length,
      itemsCreated: successCount,
      itemsFailed: failureCount,
      results,
      processingTimeMs: Date.now() - startTime,
    });
  } catch (error: any) {
    logger.error("[ingest-artifacts] Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

async function handlePresentationAgent(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const {
    systemPrompt,
    userPrompt,
    context,
    slides,
    model: requestedModel,
  } = body;

  try {
    const { getModelConfig, buildEndpointUrl } =
      await import("../config/aiModels");

    const model = requestedModel || "gpt-4o";
    const modelConfig = getModelConfig(model);
    if (!modelConfig) {
      res.status(400).json({ error: `Model ${model} not found` });
      return;
    }

    const endpoint = buildEndpointUrl(model);
    const token = await getAzureTokenForScope(AzureScope.CognitiveServices);

    const messages = [
      {
        role: "system",
        content:
          systemPrompt || "You are a helpful presentation design assistant.",
      },
      {
        role: "user",
        content: userPrompt || JSON.stringify({ context, slides }),
      },
    ];

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages,
        max_tokens: 8192,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure OpenAI error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content;

    if (content) {
      try {
        const parsed = JSON.parse(content);
        res.json({ success: true, ...parsed });
      } catch {
        res.json({ success: true, content });
      }
    } else {
      res.json({ success: true, message: "No content generated" });
    }
  } catch (error: any) {
    logger.error("Presentation agent error:", error.message);
    res.status(500).json({ error: error.message });
  }
}

async function handleSummarize(
  req: Request,
  res: Response,
  body: any,
  functionName: string,
): Promise<void> {
  const { content, title, model: requestedModel } = body;

  try {
    const { getModelConfig, buildEndpointUrl } =
      await import("../config/aiModels");

    const model = requestedModel || "gpt-4o-mini"; // Use mini for summarization (cost effective)
    const modelConfig = getModelConfig(model);
    if (!modelConfig) {
      res.status(400).json({ error: `Model ${model} not found` });
      return;
    }

    const endpoint = buildEndpointUrl(model);
    const token = await getAzureTokenForScope(AzureScope.CognitiveServices);

    const systemPrompt =
      functionName === "summarize-chat"
        ? "You are an assistant that creates concise chat conversation summaries. Summarize the key points and topics discussed."
        : "You are an assistant that creates clear, concise summaries of content. Include main topics and key takeaways.";

    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Please summarize the following${title ? ` (${title})` : ""}:\n\n${content}`,
      },
    ];

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure OpenAI error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as any;
    const summary = data.choices?.[0]?.message?.content;

    res.json({ success: true, summary });
  } catch (error: any) {
    logger.error(`${functionName} error:`, error.message);
    res.status(500).json({ error: error.message });
  }
}

async function handleRecastSlideLayout(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const { slide, targetLayout, model: requestedModel } = body;

  try {
    const { getModelConfig, buildEndpointUrl } =
      await import("../config/aiModels");

    const model = requestedModel || "gpt-4o";
    const modelConfig = getModelConfig(model);
    if (!modelConfig) {
      res.status(400).json({ error: `Model ${model} not found` });
      return;
    }

    const endpoint = buildEndpointUrl(model);
    const token = await getAzureTokenForScope(AzureScope.CognitiveServices);

    const systemPrompt = "You are a presentation design assistant. Recast the given slide content to fit the target layout while preserving the key information. Return a JSON object with the recasted content.";

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify({ slide, targetLayout }) },
    ];

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure OpenAI error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content;

    if (content) {
      try {
        const parsed = JSON.parse(content);
        res.json({ success: true, slide: parsed });
      } catch {
        res.json({ success: true, content });
      }
    } else {
      res.json({ success: false, error: "No content generated" });
    }
  } catch (error: any) {
    logger.error("Recast slide layout error:", error.message);
    res.status(500).json({ error: error.message });
  }
}

async function handleVisualRecognition(req: Request, res: Response, body: any) {
  const { imageUrl, imageBase64, prompt, model: requestedModel } = body;

  try {
    const { buildEndpointUrl } = await import("../config/aiModels");

    // GPT-4o supports vision capabilities
    const model = requestedModel || "gpt-4o";
    const endpoint = buildEndpointUrl(model);
    const token = await getAzureTokenForScope(AzureScope.CognitiveServices);

    // Build the image content
    const imageContent = imageBase64
      ? {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        }
      : { type: "image_url", image_url: { url: imageUrl } };

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              prompt ||
              "Describe this image in detail. Extract any text, diagrams, or structured information.",
          },
          imageContent,
        ],
      },
    ];

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure OpenAI error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content;

    res.json({
      success: true,
      description: content,
      analysis: content,
    });
  } catch (error: any) {
    logger.error("Visual recognition error:", error.message);
    res.status(500).json({ error: error.message });
  }
}

async function handleLogActivity(req: Request, res: Response, body: any) {
  const { activity_type, details, project_id } = body;
  const userId = req.user?.id;

  try {
    await db.query(
      "INSERT INTO activity_logs (user_id, project_id, activity_type, details, created_at) VALUES ($1, $2, $3, $4, NOW())",
      [userId, project_id, activity_type, details],
    );
    res.json({ success: true });
  } catch (error: any) {
    logger.warn("Log activity error:", error.message);
    res.json({ success: true }); // Don't fail on logging errors
  }
}

async function handleReportLocalIssue(req: Request, res: Response, body: any) {
  const { issue_type, details, project_id } = body;
  const userId = req.user?.id;

  try {
    await db.query(
      "INSERT INTO issue_reports (user_id, project_id, issue_type, details, created_at) VALUES ($1, $2, $3, $4, NOW())",
      [userId, project_id, issue_type, details],
    );
  } catch (error: any) {
    logger.warn("Report issue error:", error.message);
  }

  res.json({ success: true });
}

// ============================================================================
// Audit Pipeline Functions (Phase 1-4 + Enhanced Sort)
// Called directly by frontend useAuditPipeline.ts hook
// ============================================================================

const TAXONOMY_MISSION = "You are a requirements engineering and alignment audit specialist. Your task is to extract, categorize, and analyze concepts from datasets to assess coverage, alignment, and gaps between requirement sets and implementation artifacts.";

/**
 * Helper: Get model settings from project config
 */
async function getProjectModelSettings(
  projectId: string,
  shareToken?: string,
): Promise<{ modelId: string; temperature: number }> {
  try {
    const result = await (async () => {
      const _r = await rpc.getProjectWithToken(projectId, shareToken || null);
      return { rows: _r ? [_r] : [] };
    })();
    const project = result.rows[0]?.result || result.rows[0];
    if (project?.model_settings) {
      const settings =
        typeof project.model_settings === "string"
          ? JSON.parse(project.model_settings)
          : project.model_settings;
      return {
        modelId: settings.auditModel || settings.model || "gpt-4o",
        temperature: settings.auditTemperature ?? settings.temperature ?? 0.3,
      };
    }
  } catch (err: any) {
    logger.warn("Failed to get project model settings:", err.message);
  }
  return { modelId: "gpt-4o", temperature: 0.3 };
}

/**
 * Helper: Call Azure Foundry LLM for audit functions
 */
async function callAuditLLM(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  options: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const { buildEndpointUrl } = await import("../config/aiModels");
  const endpoint = buildEndpointUrl(modelId);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 4096,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM call failed (${response.status}): ${errText}`);
  }

  const data: any = await response.json();
  return data.choices?.[0]?.message?.content || "{}";
}

/**
 * Phase 1: Extract concepts from dataset elements
 * Modes: normal (batch), context-aware (1:many with existing concepts), recovery (orphaned elements)
 */
async function handleAuditExtractConcepts(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const {
    sessionId,
    projectId,
    shareToken,
    dataset,
    elements = [],
    mappingMode = "one_to_one",
    recoveryMode = false,
    existingConceptLabels = [],
    existingConcepts = [],
    maxConceptsPerElement = 3,
  } = body;

  if (!projectId || !elements.length) {
    res.status(400).json({ error: "projectId and elements are required" });
    return;
  }

  try {
    const { modelId, temperature } = await getProjectModelSettings(
      projectId,
      shareToken,
    );
    const isContextAware =
      existingConcepts.length > 0 || existingConceptLabels.length > 0;

    let userPrompt = "";

    if (recoveryMode) {
      // Recovery mode: extract concepts for orphaned elements that weren't matched
      userPrompt = `${TAXONOMY_MISSION}

RECOVERY MODE: These elements were not matched to existing concepts. Create new, specific concepts for them.

Elements to process:
${elements.map((e: any) => `- [${e.id}] "${e.label}": ${(e.content || "").substring(0, 500)}`).join("\n")}

${existingConceptLabels.length > 0 ? `Existing concepts (DO NOT duplicate): ${existingConceptLabels.join(", ")}` : ""}

Respond with JSON: { "concepts": [{ "label": "...", "description": "...", "elementIds": ["..."] }] }
Each concept MUST reference at least one element ID. Every element MUST be assigned.`;
    } else if (isContextAware) {
      // Context-aware mode: map elements to existing concepts or create new ones
      const conceptList =
        existingConcepts.length > 0
          ? existingConcepts
              .map((c: any) => `[${c.id}] "${c.label}": ${c.description || ""}`)
              .join("\n")
          : existingConceptLabels
              .map((l: string, i: number) => `[existing_${i}] "${l}"`)
              .join("\n");

      userPrompt = `${TAXONOMY_MISSION}

CONTEXT-AWARE EXTRACTION: Map each element to existing concepts OR create new concepts as needed.
Mapping mode: ${mappingMode === "one_to_many" ? `Each element can map to up to ${maxConceptsPerElement} concepts.` : "Each element maps to exactly one concept."}

Existing concepts:
${conceptList}

Elements to classify:
${elements.map((e: any) => `- [${e.id}] "${e.label}" (${e.category || "uncategorized"}): ${(e.content || "").substring(0, 500)}`).join("\n")}

Respond with JSON:
{
  "new_concepts": [{ "label": "...", "description": "...", "elementIds": ["..."] }],
  "existing_concepts": [{ "conceptId": "...", "elementIds": ["..."] }]
}
Every element MUST appear in exactly one group. Prefer existing concepts when the fit is strong.`;
    } else {
      // Normal mode: extract fresh concepts from elements
      userPrompt = `${TAXONOMY_MISSION}

Extract high-level concepts from these ${dataset?.toUpperCase() || "dataset"} elements.
Mapping mode: ${mappingMode === "one_to_many" ? `Each element can belong to up to ${maxConceptsPerElement} concepts.` : "Each element belongs to exactly one concept."}

Elements:
${elements.map((e: any) => `- [${e.id}] "${e.label}" (${e.category || "uncategorized"}): ${(e.content || "").substring(0, 500)}`).join("\n")}

Respond with JSON: { "concepts": [{ "label": "...", "description": "...", "elementIds": ["..."] }] }
Create meaningful, distinct concepts. Every element MUST be assigned to at least one concept.`;
    }

    // Call LLM with retries
    let result: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await callAuditLLM(modelId, TAXONOMY_MISSION, userPrompt, {
          temperature,
          maxTokens: 8192,
        });
        result = JSON.parse(raw);
        break;
      } catch (err: any) {
        logger.warn(
          `Audit extract attempt ${attempt + 1} failed:`,
          err.message,
        );
        if (attempt < 2)
          await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
      }
    }

    if (!result) {
      // Fallback: create one concept per element
      if (isContextAware) {
        result = {
          new_concepts: elements.map((e: any) => ({
            label: e.label || `Concept for ${e.id}`,
            description: `Auto-generated concept for element: ${e.label}`,
            elementIds: [e.id],
          })),
          existing_concepts: [],
        };
      } else {
        result = {
          concepts: elements.map((e: any) => ({
            label: e.label || `Concept for ${e.id}`,
            description: `Auto-generated concept for element: ${e.label}`,
            elementIds: [e.id],
          })),
        };
      }
    }

    res.json({
      success: true,
      ...result,
      dataset,
      model: modelId,
      contextAware: isContextAware,
      sessionId,
    });
  } catch (error: any) {
    logger.error("Audit extract concepts error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to extract concepts" });
  }
}

/**
 * Phase 2 (v2): Merge advisor — returns merge instructions only; client applies them
 * Uses SSE streaming
 */
async function handleAuditMergeConceptsV2(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const {
    sessionId,
    projectId,
    shareToken,
    concepts = [],
    round = 1,
    totalRounds = 3,
  } = body;

  if (!projectId || !concepts.length) {
    res.status(400).json({ error: "projectId and concepts are required" });
    return;
  }

  // Setup SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { modelId, temperature } = await getProjectModelSettings(
      projectId,
      shareToken,
    );

    sendEvent("progress", {
      message: `Starting merge analysis round ${round}/${totalRounds}...`,
      round,
    });

    // Build merge criteria based on round
    let mergeCriteria = "";
    if (round === 1) {
      mergeCriteria =
        "ROUND 1 (Exact Match): Only merge concepts that are clearly the same thing with different wording. Be very conservative.";
    } else if (round === 2) {
      mergeCriteria =
        "ROUND 2 (Thematic Match): Merge concepts that are thematically related and would naturally group together. Medium aggressiveness.";
    } else {
      mergeCriteria = `ROUND ${round} (Aggressive Consolidation): Aggressively merge concepts into broader categories. Reduce the total count significantly.`;
    }

    const conceptList = concepts
      .map(
        (c: any) =>
          `[${c.id}] "${c.label}": ${c.description || "No description"}`,
      )
      .join("\n");

    const userPrompt = `${TAXONOMY_MISSION}

MERGE ANALYSIS — ${mergeCriteria}

Analyze these ${concepts.length} concepts and identify which should be merged:
${conceptList}

Respond with JSON:
{
  "merges": [
    { "sourceIds": ["id1", "id2"], "mergedLabel": "Combined Label", "mergedDescription": "Combined description" }
  ]
}

Rules:
- Each merge MUST have 2+ sourceIds from the list above
- A concept can only appear in ONE merge group
- If no merges are appropriate, return { "merges": [] }
- sourceIds MUST be valid IDs from the input list`;

    sendEvent("progress", {
      message: "Analyzing concepts for merge opportunities...",
      round,
    });

    const raw = await callAuditLLM(modelId, TAXONOMY_MISSION, userPrompt, {
      temperature: temperature + 0.1,
      maxTokens: 4096,
    });
    const result = JSON.parse(raw);

    // Validate merge instructions
    const validIds = new Set(concepts.map((c: any) => c.id));
    const usedIds = new Set<string>();
    const validMerges = (result.merges || []).filter((merge: any) => {
      if (!merge.sourceIds || merge.sourceIds.length < 2) return false;
      // Filter to only valid, unused IDs
      merge.sourceIds = merge.sourceIds.filter(
        (id: string) => validIds.has(id) && !usedIds.has(id),
      );
      if (merge.sourceIds.length < 2) return false;
      merge.sourceIds.forEach((id: string) => usedIds.add(id));
      return true;
    });

    sendEvent("result", {
      merges: validMerges,
      round,
      totalRounds,
      conceptCount: concepts.length,
      mergeCount: validMerges.length,
      sessionId,
    });

    sendEvent("done", {
      message: `Round ${round} complete`,
      mergeCount: validMerges.length,
    });
    res.end();
  } catch (error: any) {
    logger.error("Audit merge v2 error:", error);
    sendEvent("error", {
      message: error.message || "Failed to analyze merges",
    });
    res.end();
  }
}

/**
 * Phase 3: Build tesseract cells — D1↔D2 alignment scoring per concept
 */
async function handleAuditBuildTesseract(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const {
    sessionId,
    projectId,
    shareToken,
    concepts = [],
    auditMode = "comparison",
  } = body;

  if (!projectId || !concepts.length) {
    res.status(400).json({ error: "projectId and concepts are required" });
    return;
  }

  try {
    const { modelId, temperature } = await getProjectModelSettings(
      projectId,
      shareToken,
    );
    const cells: any[] = [];
    const errors: string[] = [];

    for (const concept of concepts) {
      try {
        const d1Elements = (concept.d1Elements || [])
          .map(
            (e: any) =>
              `- "${e.label}": ${(e.content || "").substring(0, 400)}`,
          )
          .join("\n");
        const d2Elements = (concept.d2Elements || [])
          .map(
            (e: any) =>
              `- "${e.label}": ${(e.content || "").substring(0, 400)}`,
          )
          .join("\n");

        let userPrompt = "";
        if (auditMode === "comparison") {
          userPrompt = `Analyze alignment for concept "${concept.conceptLabel}": ${concept.conceptDescription || ""}

D1 (Requirements/Source) elements:
${d1Elements || "(none)"}

D2 (Implementation/Target) elements:
${d2Elements || "(none)"}

Assess how well D2 implements what D1 requires for this concept.
Respond with JSON:
{
  "polarity": <float -1.0 to 1.0, where 1.0 = perfect alignment, 0.0 = partial, -1.0 = complete gap>,
  "rationale": "Brief explanation of scoring",
  "d1Coverage": "Summary of what D1 requires",
  "d2Implementation": "Summary of what D2 provides",
  "gaps": ["List of specific gaps or misalignments"]
}`;
        } else {
          userPrompt = `Analyze coverage quality for concept "${concept.conceptLabel}": ${concept.conceptDescription || ""}

Elements:
${d1Elements || d2Elements || "(none)"}

Assess the completeness and quality of coverage for this concept.
Respond with JSON:
{
  "polarity": <float -1.0 to 1.0, where 1.0 = excellent coverage, 0.0 = partial, -1.0 = missing>,
  "rationale": "Brief explanation of scoring",
  "d1Coverage": "Summary of coverage",
  "d2Implementation": "N/A (single dataset mode)",
  "gaps": ["List of coverage gaps"]
}`;
        }

        const raw = await callAuditLLM(modelId, TAXONOMY_MISSION, userPrompt, {
          temperature,
          maxTokens: 2048,
        });
        const cell = JSON.parse(raw);

        cells.push({
          conceptId: concept.conceptId,
          conceptLabel: concept.conceptLabel,
          polarity: Math.max(-1, Math.min(1, parseFloat(cell.polarity) || 0)),
          rationale: cell.rationale || "",
          d1Coverage: cell.d1Coverage || "",
          d2Implementation: cell.d2Implementation || "",
          gaps: cell.gaps || [],
          d1ElementIds: (concept.d1Elements || []).map((e: any) => e.id),
          d2ElementIds: (concept.d2Elements || []).map((e: any) => e.id),
        });
      } catch (err: any) {
        logger.warn(
          `Tesseract cell error for concept ${concept.conceptLabel}:`,
          err.message,
        );
        errors.push(`${concept.conceptLabel}: ${err.message}`);
        // Add a neutral cell on error
        cells.push({
          conceptId: concept.conceptId,
          conceptLabel: concept.conceptLabel,
          polarity: 0,
          rationale: `Error during analysis: ${err.message}`,
          d1Coverage: "",
          d2Implementation: "",
          gaps: ["Analysis failed"],
          d1ElementIds: (concept.d1Elements || []).map((e: any) => e.id),
          d2ElementIds: (concept.d2Elements || []).map((e: any) => e.id),
        });
      }
    }

    const avgPolarity =
      cells.length > 0
        ? cells.reduce((sum: number, c: any) => sum + c.polarity, 0) /
          cells.length
        : 0;

    res.json({
      success: true,
      cells,
      avgPolarity: Math.round(avgPolarity * 100) / 100,
      ...(errors.length > 0 && { errors }),
      message: `Analyzed ${cells.length} concepts`,
      sessionId,
    });
  } catch (error: any) {
    logger.error("Audit build tesseract error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to build tesseract" });
  }
}

/**
 * Phase 4: Generate Venn diagram — pure deterministic logic, NO AI calls
 * Uses SSE streaming
 */
async function handleAuditGenerateVenn(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const {
    sessionId,
    mergedConcepts = [],
    unmergedD1Concepts = [],
    unmergedD2Concepts = [],
    tesseractCells = [],
  } = body;

  // Setup SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    sendEvent("progress", {
      message: "Categorizing concepts into Venn zones...",
    });

    // Build polarity lookup from tesseract cells
    const polarityMap = new Map<
      string,
      { polarity: number; rationale: string; gaps: string[] }
    >();
    for (const cell of tesseractCells) {
      polarityMap.set(cell.conceptLabel, {
        polarity: cell.polarity || 0,
        rationale: cell.rationale || "",
        gaps: cell.gaps || [],
      });
    }

    // Zone 1: Unique to D1 (gaps — concepts only in D1, not implemented in D2)
    const unique_to_d1 = unmergedD1Concepts.map((c: any) => {
      const cellData = polarityMap.get(c.label || c.mergedLabel);
      return {
        label: c.label || c.mergedLabel,
        description: c.description || c.mergedDescription || "",
        elementCount: c.d1Ids?.length || c.elementIds?.length || 0,
        polarity: cellData?.polarity ?? -0.5,
        gaps: cellData?.gaps || ["Not implemented in D2"],
      };
    });

    // Zone 2: Aligned (overlap — concepts present in both D1 and D2)
    const aligned = mergedConcepts
      .filter(
        (c: any) =>
          (c.d1Ids?.length > 0 || c.d1ElementIds?.length > 0) &&
          (c.d2Ids?.length > 0 || c.d2ElementIds?.length > 0),
      )
      .map((c: any) => {
        const cellData = polarityMap.get(c.mergedLabel || c.label);
        return {
          label: c.mergedLabel || c.label,
          description: c.mergedDescription || c.description || "",
          d1Count: c.d1Ids?.length || c.d1ElementIds?.length || 0,
          d2Count: c.d2Ids?.length || c.d2ElementIds?.length || 0,
          polarity: cellData?.polarity ?? 0,
          rationale: cellData?.rationale || "",
          gaps: cellData?.gaps || [],
        };
      });

    // Also include merged concepts that only have D1 or D2
    const alignedFromMerged = mergedConcepts.filter((c: any) => {
      const hasD1 = c.d1Ids?.length > 0 || c.d1ElementIds?.length > 0;
      const hasD2 = c.d2Ids?.length > 0 || c.d2ElementIds?.length > 0;
      return hasD1 !== hasD2; // XOR — only one side
    });

    for (const c of alignedFromMerged) {
      const hasD1 = c.d1Ids?.length > 0 || c.d1ElementIds?.length > 0;
      const cellData = polarityMap.get(c.mergedLabel || c.label);
      if (hasD1) {
        unique_to_d1.push({
          label: c.mergedLabel || c.label,
          description: c.mergedDescription || c.description || "",
          elementCount: c.d1Ids?.length || c.d1ElementIds?.length || 0,
          polarity: cellData?.polarity ?? -0.3,
          gaps: cellData?.gaps || [],
        });
      }
    }

    // Zone 3: Unique to D2 (orphans — concepts only in D2, not required by D1)
    const unique_to_d2 = [
      ...unmergedD2Concepts.map((c: any) => {
        const cellData = polarityMap.get(c.label || c.mergedLabel);
        return {
          label: c.label || c.mergedLabel,
          description: c.description || c.mergedDescription || "",
          elementCount: c.d2Ids?.length || c.elementIds?.length || 0,
          polarity: cellData?.polarity ?? 0,
        };
      }),
      ...alignedFromMerged
        .filter(
          (c: any) =>
            (c.d2Ids?.length > 0 || c.d2ElementIds?.length > 0) &&
            !(c.d1Ids?.length > 0 || c.d1ElementIds?.length > 0),
        )
        .map((c: any) => ({
          label: c.mergedLabel || c.label,
          description: c.mergedDescription || c.description || "",
          elementCount: c.d2Ids?.length || c.d2ElementIds?.length || 0,
          polarity: polarityMap.get(c.mergedLabel || c.label)?.polarity ?? 0,
        })),
    ];

    sendEvent("progress", { message: "Computing coverage statistics..." });

    // Compute summary statistics
    const totalD1 = unique_to_d1.length + aligned.length;
    const totalD2 = unique_to_d2.length + aligned.length;
    const alignedCount = aligned.length;
    const maxTotal = Math.max(totalD1, totalD2, 1);

    const avgPolarity =
      aligned.length > 0
        ? aligned.reduce((sum: number, a: any) => sum + a.polarity, 0) /
          aligned.length
        : 0;

    // Alignment score: weighted by polarity
    const alignment_score = Math.round(
      (alignedCount / maxTotal) * 100 * (0.5 + Math.max(0, avgPolarity) * 0.5),
    );

    const summary = {
      total_d1_coverage:
        totalD1 > 0 ? Math.round((alignedCount / totalD1) * 100) : 0,
      total_d2_coverage:
        totalD2 > 0 ? Math.round((alignedCount / totalD2) * 100) : 0,
      alignment_score: Math.min(100, alignment_score),
      gaps: unique_to_d1.length,
      orphans: unique_to_d2.length,
      aligned: alignedCount,
      avg_polarity: Math.round(avgPolarity * 100) / 100,
    };

    sendEvent("result", {
      unique_to_d1,
      aligned,
      unique_to_d2,
      summary,
      generatedAt: new Date().toISOString(),
      sessionId,
    });

    sendEvent("done", { message: "Venn diagram generated", summary });
    res.end();
  } catch (error: any) {
    logger.error("Audit generate venn error:", error);
    sendEvent("error", { message: error.message || "Failed to generate Venn" });
    res.end();
  }
}

/**
 * Enhanced sort — reviews element categorization and suggests re-sorting
 * Uses fast model (gpt-4o-mini equivalent) with low token limit
 */
async function handleAuditEnhancedSort(
  req: Request,
  res: Response,
  body: any,
): Promise<void> {
  const {
    element,
    currentConcepts = [],
    availableConcepts = [],
    allowedActions = {},
  } = body;

  if (!element) {
    res.status(400).json({ error: "element is required" });
    return;
  }

  try {
    const { buildEndpointUrl, getModelConfig } =
      await import("../config/aiModels");
    // Use gpt-4o-mini for speed/cost (closest to gemini-2.0-flash)
    const fastModel = getModelConfig("gpt-4o-mini") ? "gpt-4o-mini" : "gpt-4o";
    const endpoint = buildEndpointUrl(fastModel);

    const conceptsList = availableConcepts
      .map(
        (c: any) =>
          `[${c.id}] "${c.label}": ${(c.description || "").substring(0, 100)}`,
      )
      .join("\n");

    const contentPreview = (element.content || "").substring(0, 600);

    const prompt = `Element: "${element.label}" (${element.dataset || "unknown"}): ${contentPreview}

Current concept(s): ${currentConcepts.join(", ") || "none"}

Available concepts:
${conceptsList}

Allowed actions: ${JSON.stringify(allowedActions)}

Should this element be re-categorized?
Respond with JSON:
{
  "action": "no_action" | "move" | "clone" | "create",
  "targetConcept": "concept_id (for move/clone)",
  "newConcept": { "label": "...", "description": "..." } (for create action only)
}
If unsure, respond with { "action": "no_action" }.`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "You are a categorization assistant. Respond with JSON only.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 100,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      res.json({ action: "no_action" });
      return;
    }

    const data: any = await response.json();
    const result = JSON.parse(
      data.choices?.[0]?.message?.content || '{"action":"no_action"}',
    );

    // Validate action against allowed actions
    const action = result.action || "no_action";
    if (action !== "no_action" && allowedActions[action] === false) {
      res.json({ action: "no_action" });
      return;
    }

    res.json(result);
  } catch (error: any) {
    logger.warn("Enhanced sort error:", error.message);
    // Return no_action on any error (non-breaking)
    res.json({ action: "no_action" });
  }
}

export default router;

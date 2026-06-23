/**
 * Docker deployment-service action: `deploy` (T017, US1).
 *
 * Dispatches the genapp GitHub Actions workflow with `action=deploy` after
 * a best-effort pre-deploy auto-push of committed repository files to
 * GitHub (FR-004). Resource names are preserved as-is when already set on
 * the row so the dispatched workflow always sees the deterministic names
 * persisted at create time.
 *
 * Failure handling (pre-push errors, dispatch HTTP errors, stall window)
 * lands under US4 — TODO markers in the source.
 *
 * Replaces the genapp branch in the in-line `case 'deploy'` body of
 * `_legacyHandleDeploymentService` in `app/backend/src/routes/functions.ts`.
 */
import db from "../../../../utils/database";
import { logger } from "../../../../utils/logger";
import * as rpc from "../../../../utils/rpcHelpers";
import {
  gitHubApiHeaders,
  resolveGitHubToken,
} from "../../../../utils/githubAuth";
import { getRepoBlobStore } from "../../../../utils/repoBlobStore";
import { broadcast } from "../../../../websocket";
import { dispatchGenappWorkflow } from "../genappWorkflowClient";
import { ensureGenappKeyVault } from "../genappKeyVault";
import { computeGenappResourceNames } from "../naming";
import { ConcurrentDeployError, assertCanAcceptDeploy } from "../statusMachine";
import type { DockerDeploymentContext } from "../types";
import { formatDispatchHttpCause, recordFailure } from "./_failure";
import { persistDispatchMetadata } from "./_dispatchUpdate";

const LOG_PREFIX = "[docker-deployment:deploy]";

interface RepoLike {
  id: string;
  organization: string;
  repo: string;
  is_prime?: boolean;
  is_default?: boolean;
}

async function resolveRepo(
  deployment: { repo_id?: string | null; project_id: string },
  shareToken: string | null,
): Promise<RepoLike | null> {
  if (deployment.repo_id) {
    const r = await rpc.getRepoByIdWithToken(deployment.repo_id, shareToken);
    if (r) return r as RepoLike;
  }
  const repos = (await rpc.getProjectReposWithToken(
    deployment.project_id,
    shareToken,
  )) as RepoLike[] | null;
  if (!repos || repos.length === 0) return null;
  return repos.find((r) => r.is_prime) ?? repos[0];
}

/**
 * Best-effort pre-deploy sync of committed repo files to GitHub.
 * Mirrors the legacy auto-push block in functions.ts. Silent early-returns
 * are preserved for the "nothing to push" cases (empty file list, branch
 * missing, all blobs null). Genuine GitHub-API errors propagate so the
 * caller can mark the row `failed` with `last_failure_cause='pre-push-failed: <msg>'`
 * (FR-004, US4).
 */
async function autoPushCommittedFiles(opts: {
  token: string;
  org: string;
  repo: string;
  branch: string;
  projectId: string;
  pushRepoId: string;
  shareToken: string | null;
}): Promise<void> {
  const { token, org, repo, branch, projectId, pushRepoId, shareToken } = opts;
  const allFiles = (await rpc.getRepoFilesWithToken(pushRepoId, shareToken)) as
    | { path: string }[]
    | null;
  if (!allFiles || allFiles.length === 0) return;

  const headers = gitHubApiHeaders(token, "Pronghorn-Deploy");

  const branchResp = await fetch(
    `https://api.github.com/repos/${org}/${repo}/git/refs/heads/${branch}`,
    { headers },
  );
  if (!branchResp.ok) return;
  const branchData = (await branchResp.json()) as { object: { sha: string } };
  const currentSha = branchData.object.sha;

  const commitResp = await fetch(
    `https://api.github.com/repos/${org}/${repo}/git/commits/${currentSha}`,
    { headers },
  );
  if (!commitResp.ok) return;

  const filesWithContent = await Promise.all(
    allFiles.map(async (f) => ({
      path: f.path,
      content: await getRepoBlobStore().readCommitted(
        projectId,
        pushRepoId,
        f.path,
      ),
    })),
  );
  const pushable = filesWithContent.filter(
    (f): f is { path: string; content: string } => f.content !== null,
  );
  if (pushable.length === 0) {
    logger.info(`${LOG_PREFIX} nothing to pre-push (all blobs null)`);
    return;
  }

  const blobs = await Promise.all(
    pushable.map(async (f) => {
      const blobResp = await fetch(
        `https://api.github.com/repos/${org}/${repo}/git/blobs`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ content: f.content, encoding: "utf-8" }),
        },
      );
      if (!blobResp.ok) throw new Error(`blob create failed for ${f.path}`);
      const blobData = (await blobResp.json()) as { sha: string };
      return {
        path: f.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blobData.sha,
      };
    }),
  );

  const treeResp = await fetch(
    `https://api.github.com/repos/${org}/${repo}/git/trees`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ tree: blobs }),
    },
  );
  if (!treeResp.ok) return;
  const treeData = (await treeResp.json()) as { sha: string };

  const newCommitResp = await fetch(
    `https://api.github.com/repos/${org}/${repo}/git/commits`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: "Pre-deploy sync",
        tree: treeData.sha,
        parents: [currentSha],
      }),
    },
  );
  if (!newCommitResp.ok) return;
  const newCommit = (await newCommitResp.json()) as { sha: string };

  await fetch(
    `https://api.github.com/repos/${org}/${repo}/git/refs/heads/${branch}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ sha: newCommit.sha, force: true }),
    },
  );

  logger.info(
    `${LOG_PREFIX} pre-pushed ${pushable.length} files to ${org}/${repo}@${branch} (${newCommit.sha.substring(0, 8)})`,
  );
}

export async function deployAction(
  ctx: DockerDeploymentContext,
): Promise<void> {
  const { req, res, body } = ctx;
  const deploymentId = body.deploymentId;
  const shareToken = (body.shareToken ?? null) as string | null;
  const userId = (req.user as { id?: string } | undefined)?.id ?? null;

  const deployment = await rpc.getDeploymentWithSecretsWithToken(
    deploymentId,
    shareToken,
  );
  if (!deployment) {
    res.status(404).json({ success: false, error: "Deployment not found" });
    return;
  }

  // US5 / FR-009: reject transitional rows; permit retry from `failed`.
  let clearFailureAttrs = false;
  try {
    ({ clearFailureAttrs } = assertCanAcceptDeploy(deployment.status));
  } catch (err) {
    if (err instanceof ConcurrentDeployError) {
      res.status(409).json({
        success: false,
        error: err.message,
        currentStatus: err.currentStatus,
      });
      return;
    }
    throw err;
  }

  const repo = await resolveRepo(deployment, shareToken);
  if (!repo) {
    res
      .status(400)
      .json({ success: false, error: "No repository found for project" });
    return;
  }

  const resolvedGh = await resolveGitHubToken({
    userId: userId ?? undefined,
    repoId: deployment.repo_id ?? repo.id,
    isDefaultRepo: repo.is_default,
  });
  if (!resolvedGh) {
    res.status(412).json({ success: false, error: "GitHub is not configured" });
    return;
  }

  // FR-004: pre-deploy sync BEFORE dispatching the workflow.
  try {
    await autoPushCommittedFiles({
      token: resolvedGh.token,
      org: repo.organization,
      repo: repo.repo,
      branch: deployment.branch || "main",
      projectId: deployment.project_id,
      pushRepoId: deployment.repo_id ?? repo.id,
      shareToken,
    });
  } catch (err) {
    const cause = `pre-push-failed: ${(err as Error).message}`;
    logger.error(`${LOG_PREFIX} ${cause}`);
    await recordFailure({
      deploymentId: deployment.id,
      projectId: deployment.project_id ?? null,
      lastFailureCause: cause,
    });
    res.status(502).json({ success: false, error: cause });
    return;
  }

  // Preserve names when already persisted; compute only on first transition.
  const appName: string =
    deployment.azure_container_app_name ||
    computeGenappResourceNames({
      appName: deployment.name,
      appId: deployment.id,
      environment: deployment.environment,
    }).appName;
  const resourceGroup: string =
    deployment.azure_resource_group ||
    computeGenappResourceNames({
      appName: deployment.name,
      appId: deployment.id,
      environment: deployment.environment,
    }).resourceGroup;

  await persistDispatchMetadata({
    deploymentId: deployment.id,
    appName,
    resourceGroup,
    userId,
    action: "deploy",
    clearFailureAttrs,
  });

  let workflowRunId: number;
  try {
    // Ensure the per-deployment Key Vault exists (idempotent) so Terraform can
    // read env-var / secret VALUES from it. Only the vault NAME is passed.
    const {
      name: keyVaultName,
      uri: keyVaultUri,
      resourceGroup: keyVaultResourceGroup,
    } = await ensureGenappKeyVault({
      appId: deployment.id,
    });
    await db.query(
      "UPDATE project_deployments SET azure_key_vault_name = $1, azure_key_vault_uri = $2, updated_at = NOW() WHERE id = $3",
      [keyVaultName, keyVaultUri, deployment.id],
    );
    workflowRunId = await dispatchGenappWorkflow({
      appId: deployment.id,
      appName,
      resourceGroup,
      repoUrl: `${repo.organization}/${repo.repo}`,
      branch: deployment.branch || "main",
      dockerfilePath: deployment.dockerfile_path || "Dockerfile",
      environment: deployment.environment,
      action: "deploy",
      keyVaultName,
      keyVaultResourceGroup,
      port: deployment.port ?? 80,
      githubToken: resolvedGh.token,
    });
  } catch (err) {
    const cause = formatDispatchHttpCause(err);
    logger.error(`${LOG_PREFIX} ${cause}`);
    await recordFailure({
      deploymentId: deployment.id,
      projectId: deployment.project_id ?? null,
      lastFailureCause: cause,
    });
    res.status(502).json({ success: false, error: cause });
    return;
  }

  await db.query(
    `UPDATE project_deployments
     SET workflow_run_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [workflowRunId || null, deployment.id],
  );

  if (deployment.project_id) {
    broadcast(`deployments-${deployment.project_id}`, "deployment_refresh", {
      action: "status_updated",
      deploymentId: deployment.id,
      status: "pending",
    });
  }

  logger.info(
    `${LOG_PREFIX} dispatched action=deploy app=${appName} runId=${workflowRunId}`,
  );

  res.status(202).json({
    success: true,
    data: {
      status: "pending",
      message: "Deploy workflow dispatched",
      workflowRunId: workflowRunId || null,
    },
  });
}

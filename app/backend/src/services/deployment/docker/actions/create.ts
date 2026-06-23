/**
 * Docker deployment-service action: `create` (T016, US1).
 *
 * Dispatches the genapp GitHub Actions workflow with `action=create`.
 * Persists the computed Azure resource names plus dispatch metadata BEFORE
 * the workflow is dispatched (FR-002) so that an operator who refreshes
 * the page between persist and dispatch still sees a row that matches the
 * workflow's deterministic naming scheme.
 *
 * Replaces the in-line `case 'create'` body of `_legacyHandleDeploymentService`
 * in `app/backend/src/routes/functions.ts`.
 *
 * @example
 *   import { createAction } from "./actions/create";
 *   // Registered by dockerDeploymentService.ts on module load.
 */
import db from "../../../../utils/database";
import { logger } from "../../../../utils/logger";
import * as rpc from "../../../../utils/rpcHelpers";
import { resolveGitHubToken } from "../../../../utils/githubAuth";
import { broadcast } from "../../../../websocket";
import { dispatchGenappWorkflow } from "../genappWorkflowClient";
import { ensureGenappKeyVault } from "../genappKeyVault";
import { pushInfraSnapshot } from "../genappInfraSnapshot";
import { computeGenappResourceNames } from "../naming";
import type { DockerDeploymentContext } from "../types";
import { formatDispatchHttpCause, recordFailure } from "./_failure";
import { persistDispatchMetadata } from "./_dispatchUpdate";

const LOG_PREFIX = "[docker-deployment:create]";

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

export async function createAction(
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

  const { appName, resourceGroup } = computeGenappResourceNames({
    appName: deployment.name,
    appId: deployment.id,
    environment: deployment.environment,
  });

  // FR-002: write resource names + dispatch metadata BEFORE dispatch.
  await persistDispatchMetadata({
    deploymentId: deployment.id,
    appName,
    resourceGroup,
    userId,
    action: "create",
  });

  // Acknowledge the request immediately. Provisioning the per-deployment Key
  // Vault for a brand-new service (private endpoint + private-DNS zone group +
  // settle delay) can take 1-2 minutes, which exceeds the upstream gateway's
  // backend request timeout and would surface to the browser as a 504. The row
  // is already persisted as status='pending' above, so we return now and
  // continue provisioning + dispatching server-side after the response is
  // flushed. Any failure is recorded LOUDLY on the deployment row
  // (status='failed' + broadcast) so it surfaces through the normal
  // status/polling path — it is never silently dropped.
  res.status(202).json({
    success: true,
    data: { status: "pending", workflowRunId: null },
  });

  // The HTTP response is already sent; everything below runs server-side
  // without holding the client. Order is preserved (vault BEFORE dispatch) so
  // the workflow's Terraform step can always read env-var / secret VALUES from
  // the vault. There is no race: the workflow is never dispatched until the
  // vault exists.
  try {
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

    let workflowRunId: number | null;
    try {
      workflowRunId = await dispatchGenappWorkflow({
        appId: deployment.id,
        appName,
        resourceGroup,
        repoUrl: `${repo.organization}/${repo.repo}`,
        branch: deployment.branch || "main",
        dockerfilePath: deployment.dockerfile_path || "Dockerfile",
        environment: deployment.environment,
        action: "create",
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
        action: "created",
        deploymentId: deployment.id,
        status: "pending",
      });
    }

    // One-time, best-effort: push an illustrative (view-only) copy of the
    // Terraform templates into the user's repo under `infra/`. Never blocks or
    // fails the create flow.
    void pushInfraSnapshot({
      userToken: resolvedGh.token,
      org: repo.organization,
      repo: repo.repo,
      branch: deployment.branch || "main",
      appName,
    });

    logger.info(
      `${LOG_PREFIX} dispatched action=create app=${appName} runId=${workflowRunId}`,
    );
  } catch (err) {
    // Catches Key Vault provisioning failures (and any other unexpected error
    // after the response was sent). The client already received 202, so we
    // record the failure loudly on the row instead of returning an HTTP error.
    const cause = `keyvault-provisioning-failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    logger.error(`${LOG_PREFIX} ${cause}`);
    await recordFailure({
      deploymentId: deployment.id,
      projectId: deployment.project_id ?? null,
      lastFailureCause: cause,
    }).catch((e) =>
      logger.error(`${LOG_PREFIX} recordFailure failed: ${String(e)}`),
    );
  }
}

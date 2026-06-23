/**
 * Docker deployment-service action: `destroy` (T024, US2).
 *
 * Dispatches the genapp GitHub Actions workflow with `action=destroy`.
 * The row stays in a transitional state until the background poller
 * observes the workflow conclusion and flips status → `deleted` (success)
 * or `failed` (workflow conclusion failure — handled under US4).
 *
 * Short-circuit: when the row has no `azure_container_app_name` there is
 * nothing for the workflow to tear down, so we mark the row `deleted`
 * directly and skip dispatch (contract § destroy preconditions).
 *
 * Replaces the in-line `case 'delete'` body of `_legacyHandleDeploymentService`
 * in `app/backend/src/routes/functions.ts`.
 */
import db from "../../../../utils/database";
import { logger } from "../../../../utils/logger";
import * as rpc from "../../../../utils/rpcHelpers";
import { resolveGitHubToken } from "../../../../utils/githubAuth";
import { broadcast } from "../../../../websocket";
import { dispatchGenappWorkflow } from "../genappWorkflowClient";
import {
  deriveGenappKeyVaultName,
  genappKeyVaultResourceGroup,
} from "../genappKeyVault";
import {
  ConcurrentDeployError,
  assertCanAcceptDestroy,
} from "../statusMachine";
import type { DockerDeploymentContext } from "../types";
import { formatDispatchHttpCause, recordFailure } from "./_failure";
import { persistDispatchMetadata } from "./_dispatchUpdate";

const LOG_PREFIX = "[docker-deployment:destroy]";

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

export async function destroyAction(
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

  // FR-009 / US6 concurrency + deleted guards.
  let clearFailureAttrs = false;
  try {
    ({ clearFailureAttrs } = assertCanAcceptDestroy(deployment.status));
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

  // Short-circuit: nothing in Azure to tear down.
  if (!deployment.azure_container_app_name) {
    await rpc.updateDeploymentWithToken(deployment.id, shareToken, {
      status: "deleted",
    });
    if (deployment.project_id) {
      broadcast(`deployments-${deployment.project_id}`, "deployment_refresh", {
        action: "deleted",
        deploymentId: deployment.id,
      });
    }
    res.status(200).json({
      success: true,
      data: { status: "deleted" },
    });
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

  await persistDispatchMetadata({
    deploymentId: deployment.id,
    userId,
    action: "destroy",
    clearFailureAttrs,
  });

  const workflowRunId = await (async (): Promise<number | null> => {
    try {
      return await dispatchGenappWorkflow({
        appId: deployment.id,
        appName: deployment.azure_container_app_name,
        resourceGroup: deployment.azure_resource_group,
        repoUrl: `${repo.organization}/${repo.repo}`,
        branch: deployment.branch || "main",
        dockerfilePath: deployment.dockerfile_path || "Dockerfile",
        environment: deployment.environment,
        action: "destroy",
        keyVaultName:
          deployment.azure_key_vault_name ||
          deriveGenappKeyVaultName(deployment.id),
        keyVaultResourceGroup: genappKeyVaultResourceGroup(),
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
      return null;
    }
  })();
  if (workflowRunId === null) return;

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
    `${LOG_PREFIX} dispatched action=destroy app=${deployment.azure_container_app_name} runId=${workflowRunId}`,
  );

  res.status(202).json({
    success: true,
    data: {
      status: "pending",
      message: "Destroy workflow dispatched",
      workflowRunId: workflowRunId || null,
    },
  });
}

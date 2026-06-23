/**
 * Docker deployment-service action: `status` (T018, US1).
 *
 * Verbatim relocation of the genapp branch of the in-line `case 'status'`
 * body from `app/backend/src/routes/functions.ts`. When a deployment row
 * has a `workflow_run_id`, poll the GitHub Actions run and update the row
 * if the observed status differs.
 *
 * Long-term, the dedicated poller (`poller.ts`) is the canonical place
 * status transitions happen — this handler exists so that explicit
 * frontend status pokes still resolve immediately.
 */
import { logger } from "../../../../utils/logger";
import * as rpc from "../../../../utils/rpcHelpers";
import { broadcast } from "../../../../websocket";
import { pollWorkflowStatus } from "../genappWorkflowClient";
import type { DockerDeploymentContext } from "../types";

const LOG_PREFIX = "[docker-deployment:status]";

export async function statusAction(
  ctx: DockerDeploymentContext,
): Promise<void> {
  const { res, body } = ctx;
  const deploymentId = body.deploymentId;
  const shareToken = (body.shareToken ?? null) as string | null;

  const deployment = await rpc.getDeploymentWithSecretsWithToken(
    deploymentId,
    shareToken,
  );
  if (!deployment) {
    res.status(404).json({ success: false, error: "Deployment not found" });
    return;
  }

  if (!deployment.workflow_run_id) {
    // No workflow run yet — surface the current row state without polling.
    res.json({
      success: true,
      data: {
        status: deployment.status,
        url: deployment.url ?? null,
      },
    });
    return;
  }

  const result = await pollWorkflowStatus(deployment.workflow_run_id, {
    containerAppName: deployment.azure_container_app_name,
    resourceGroup: deployment.azure_resource_group,
  });

  // Don't override user-initiated lifecycle states (stopped, deleted) with
  // stale workflow conclusions. The workflow may have succeeded hours ago but
  // the user explicitly stopped the app since then.
  const userLifecycleStates = new Set(["stopped", "deleted"]);
  const shouldUpdateStatus =
    result.status !== deployment.status &&
    !userLifecycleStates.has(deployment.status);

  if (shouldUpdateStatus) {
    await rpc.updateDeploymentWithToken(deployment.id, shareToken, {
      status: result.status,
      ...(result.url ? { url: result.url } : {}),
    });
    if (deployment.project_id) {
      broadcast(`deployments-${deployment.project_id}`, "deployment_refresh", {
        action: "status_updated",
        deploymentId: deployment.id,
        status: result.status,
        ...(result.url ? { url: result.url } : {}),
      });
    }
    logger.info(
      `${LOG_PREFIX} ${deployment.id} ${deployment.status} → ${result.status}`,
    );
  } else if (result.url && !deployment.url) {
    // Even if we don't update status, still persist the URL if we got one
    await rpc.updateDeploymentWithToken(deployment.id, shareToken, {
      url: result.url,
    });
  }

  res.json({
    success: true,
    data: {
      status: shouldUpdateStatus ? result.status : deployment.status,
      url: result.url || deployment.url || null,
    },
  });
}

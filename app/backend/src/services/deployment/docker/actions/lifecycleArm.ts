/**
 * Docker deployment lifecycle ARM actions: `start`, `stop`, `restart`
 * (T046, FR-014).
 *
 * Relocated verbatim from `_legacyHandleDeploymentService` in
 * `app/backend/src/routes/functions.ts` (cases L2175 / L2211 / L2244 at
 * relocation time). Behavior change: none.
 *
 * `start` / `stop` scale the Container App replicas (0 = stopped, ≥1 =
 * running) and PUT the resource back. `restart` bumps `revisionSuffix`
 * which triggers a new revision rollout. Each PUT may return 202 with an
 * `Azure-AsyncOperation` header that we poll to completion.
 */
import { logger } from "../../../../utils/logger";
import * as rpc from "../../../../utils/rpcHelpers";
import { broadcast } from "../../../../websocket";
import { ARM_BASE, getArmContext } from "../_armContext";
import type { DockerDeploymentContext } from "../types";

const LOG_PREFIX = "[docker-deployment:lifecycleArm]";

type LifecycleVerb = "start" | "stop" | "restart";

export async function lifecycleArmAction(
  ctx: DockerDeploymentContext,
): Promise<void> {
  const { res, body } = ctx;
  const action = body.action as LifecycleVerb;
  const deploymentId = body.deploymentId;
  const shareToken = (body.shareToken ?? null) as string | null;

  const deployment = await rpc.getDeploymentWithSecretsWithToken(
    deploymentId,
    shareToken,
  );
  if (!deployment) {
    res
      .status(404)
      .json({ success: false, error: "Deployment not found or access denied" });
    return;
  }

  const appName = deployment.azure_container_app_name;
  if (!appName) {
    res
      .status(400)
      .json({ success: false, error: "Container App not created" });
    return;
  }

  try {
    const arm = await getArmContext(action, deployment);
    const appBasePath = `${arm.subPath}/resourceGroups/${arm.rg}/providers/Microsoft.App/containerApps/${appName}`;
    const appPath = `${appBasePath}?api-version=2024-03-01`;

    if (action === "start") {
      // Use the dedicated start API endpoint
      const startRes = await fetch(
        `${ARM_BASE}${appBasePath}/start?api-version=2024-03-01`,
        {
          method: "POST",
          headers: arm.armHeaders,
        },
      );
      if (!startRes.ok) {
        const errText = await startRes.text();
        throw new Error(
          `Azure start failed: ${startRes.status} - ${errText.substring(0, 200)}`,
        );
      }
      if (startRes.status === 202) {
        const op =
          startRes.headers.get("Azure-AsyncOperation") ||
          startRes.headers.get("Location");
        if (op) await arm.pollOperation(op);
      }
    } else if (action === "stop") {
      // Use the dedicated stop API endpoint
      const stopRes = await fetch(
        `${ARM_BASE}${appBasePath}/stop?api-version=2024-03-01`,
        {
          method: "POST",
          headers: arm.armHeaders,
        },
      );
      if (!stopRes.ok) {
        const errText = await stopRes.text();
        throw new Error(
          `Azure stop failed: ${stopRes.status} - ${errText.substring(0, 200)}`,
        );
      }
      if (stopRes.status === 202) {
        const op =
          stopRes.headers.get("Azure-AsyncOperation") ||
          stopRes.headers.get("Location");
        if (op) await arm.pollOperation(op);
      }
    } else {
      // restart: bump revisionSuffix to trigger a new revision rollout
      const app = await arm.azureRest("GET", appPath);
      if (app.properties?.template) {
        app.properties.template.revisionSuffix = `restart-${Date.now().toString(36)}`;
      }
      await arm.fixSecretsForPut(app);
      const putRes = await fetch(`${ARM_BASE}${appPath}`, {
        method: "PUT",
        headers: arm.armHeaders,
        body: JSON.stringify(app),
      });
      if (!putRes.ok) {
        const errText = await putRes.text();
        throw new Error(
          `Azure restart failed: ${putRes.status} - ${errText.substring(0, 200)}`,
        );
      }
      if (putRes.status === 202) {
        const op = putRes.headers.get("Azure-AsyncOperation");
        if (op) await arm.pollOperation(op);
      }
    }

    if (action === "start") {
      await rpc.updateDeploymentWithToken(deployment.id, shareToken, {
        status: "running",
      });
      if (deployment.project_id) {
        broadcast(
          `deployments-${deployment.project_id}`,
          "deployment_refresh",
          { action: "started", deploymentId: deployment.id },
        );
      }
      res.json({ success: true, data: { status: "running" } });
      return;
    }

    if (action === "stop") {
      await rpc.updateDeploymentWithToken(deployment.id, shareToken, {
        status: "stopped",
      });
      if (deployment.project_id) {
        broadcast(
          `deployments-${deployment.project_id}`,
          "deployment_refresh",
          { action: "stopped", deploymentId: deployment.id },
        );
      }
      res.json({ success: true, data: { status: "stopped" } });
      return;
    }

    // restart
    if (deployment.project_id) {
      broadcast(`deployments-${deployment.project_id}`, "deployment_refresh", {
        action: "restarted",
        deploymentId: deployment.id,
      });
    }
    res.json({ success: true, data: { status: "restarted" } });
  } catch (err) {
    logger.error(
      `${LOG_PREFIX} ${action} failed for ${deploymentId}: ${(err as Error).message}`,
    );
    res.status(400).json({ success: false, error: (err as Error).message });
  }
}

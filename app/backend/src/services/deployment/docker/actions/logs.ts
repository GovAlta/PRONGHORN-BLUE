/**
 * Docker deployment ARM actions: `logs`, `getEvents` (T048).
 *
 * Relocated verbatim from `_legacyHandleDeploymentService` (case L2273 at
 * relocation time). Both verbs collapse to the same Container App
 * revisions listing — `logs` returns the 5 most recent, `getEvents` 10.
 * Failures degrade gracefully to an empty payload (matches prior
 * behavior).
 */
import * as rpc from "../../../../utils/rpcHelpers";
import { getArmContext } from "../_armContext";
import type { DockerDeploymentContext } from "../types";

export async function logsAction(ctx: DockerDeploymentContext): Promise<void> {
  const { res, body } = ctx;
  const action = body.action as "logs" | "getEvents";
  const deploymentId = body.deploymentId;
  const shareToken = (body.shareToken ?? null) as string | null;

  const deployment = await rpc.getDeploymentWithSecretsWithToken(
    deploymentId,
    shareToken,
  );
  if (!deployment) {
    res.status(404).json({ success: false, error: "Deployment not found or access denied" });
    return;
  }

  const appName = deployment.azure_container_app_name;
  if (!appName) {
    res.json({ success: true, data: { deploys: [], events: [] } });
    return;
  }

  try {
    const arm = await getArmContext(action, deployment);
    const revsResult = await arm.azureRest(
      "GET",
      `${arm.subPath}/resourceGroups/${arm.rg}/providers/Microsoft.App/containerApps/${appName}/revisions?api-version=2024-03-01`,
    );
    const sorted = (revsResult.value || [])
      .sort(
        (a: any, b: any) =>
          new Date(b.properties?.createdTime || 0).getTime() -
          new Date(a.properties?.createdTime || 0).getTime(),
      )
      .slice(0, action === "logs" ? 5 : 10);
    const deploys = sorted.map((r: any) => ({
      id: r.name,
      status:
        r.properties?.healthState === "Healthy"
          ? "live"
          : r.properties?.runningState === "Failed"
            ? "build_failed"
            : "created",
      createdAt: r.properties?.createdTime,
      finishedAt: r.properties?.lastActiveTime,
    }));
    res.json({
      success: true,
      data: {
        deploys,
        events: [],
        latestDeployId: deploys[0]?.id,
        latestDeploy: deploys[0] || null,
      },
    });
  } catch {
    res.json({ success: true, data: { deploys: [], events: [] } });
  }
}

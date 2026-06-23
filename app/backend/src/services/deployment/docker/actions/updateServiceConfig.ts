/**
 * Docker deployment-service action: `updateServiceConfig` (T029, US3).
 *
 * Persists user-editable service-config fields on a deployment row. Pure
 * row UPDATE — no Azure call, no workflow dispatch, no template push.
 *
 * Whitelist (FR-010): only the seven keys below are persistable. Env vars
 * and any other field surface a `400 { error: 'unsupported config field:
 * <key>' }` (FR-011) so that callers cannot silently smuggle data through
 * this handler.
 *
 * Replaces the silent-400 gap in `_legacyHandleDeploymentService`: the
 * frontend's deploy dialog Save button has been dispatching this action
 * with no server-side handler since the rollout of the genapp module.
 */
import db from "../../../../utils/database";
import { logger } from "../../../../utils/logger";
import * as rpc from "../../../../utils/rpcHelpers";
import { broadcast } from "../../../../websocket";
import type { DockerDeploymentContext } from "../types";

const LOG_PREFIX = "[docker-deployment:updateServiceConfig]";

/** FR-010 whitelist — additions require an explicit spec/contract change. */
const ALLOWED_CONFIG_KEYS = [
  "run_command",
  "build_command",
  "install_command",
  "dockerfile_path",
  "branch",
  "run_folder",
  "build_folder",
] as const;

type AllowedConfigKey = (typeof ALLOWED_CONFIG_KEYS)[number];

export async function updateServiceConfigAction(
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

  const config = (body as { config?: Record<string, unknown> }).config;

  // No-op when caller sent no config bag (current frontend behaviour for
  // the deploy dialog's Save button — the row update happens elsewhere).
  if (!config || Object.keys(config).length === 0) {
    res.status(200).json({
      success: true,
      data: { id: deployment.id },
    });
    return;
  }

  // FR-011: reject any key not on the whitelist before touching the DB.
  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.includes(key as AllowedConfigKey)) {
      res
        .status(400)
        .json({ success: false, error: `unsupported config field: ${key}` });
      return;
    }
  }

  // Build COALESCE-style UPDATE for the keys actually present.
  const setClauses: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [];
  let idx = 1;
  for (const key of ALLOWED_CONFIG_KEYS) {
    if (key in config) {
      setClauses.push(`${key} = $${idx}`);
      params.push((config as Record<string, unknown>)[key]);
      idx++;
    }
  }
  params.push(deployment.id);

  const result = await db.query(
    `UPDATE project_deployments
     SET ${setClauses.join(", ")}
     WHERE id = $${idx}
     RETURNING id, run_command, build_command, install_command,
               dockerfile_path, branch, run_folder, build_folder`,
    params,
  );

  const persisted = result.rows?.[0] ?? { id: deployment.id };

  if (deployment.project_id) {
    broadcast(`deployments-${deployment.project_id}`, "deployment_refresh", {
      action: "config_updated",
      deploymentId: deployment.id,
    });
  }

  logger.info(
    `${LOG_PREFIX} ${deployment.id} updated keys=[${Object.keys(config).join(",")}]`,
  );

  res.status(200).json({
    success: true,
    data: persisted,
  });
}

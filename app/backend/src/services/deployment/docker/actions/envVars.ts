/**
 * Docker deployment env-var actions: `getEnvVars`, `updateEnvVars`,
 * `syncEnvVars`.
 *
 * The per-deployment Key Vault is the SINGLE source of truth for env-var and
 * secret VALUES. These handlers read/write the vault; the running Container App
 * is wired to the vault by Terraform via `secretRef`, so value changes take
 * effect on the next deploy. Values no longer live in Postgres or are pushed
 * directly to the Container App from here.
 */
import * as rpc from "../../../../utils/rpcHelpers";
import { broadcast } from "../../../../websocket";
import {
  ensureGenappKeyVault,
  getGenappSecrets,
  setGenappSecrets,
  deleteGenappSecrets,
  type GenappSecretEntry,
} from "../genappKeyVault";
import type { DockerDeploymentContext } from "../types";

type EnvVerb = "getEnvVars" | "updateEnvVars" | "syncEnvVars";

export async function envVarsAction(
  ctx: DockerDeploymentContext,
): Promise<void> {
  const { res, body } = ctx;
  const action = body.action as EnvVerb;
  const deploymentId = body.deploymentId;
  const shareToken = (body.shareToken ?? null) as string | null;
  const envVars = (body as any).envVars as
    | { key?: string; value?: string }[]
    | undefined;
  const newEnvVars = (body as any).newEnvVars as
    | { key?: string; value?: string }[]
    | undefined;
  const keysToDelete = (body as any).keysToDelete as string[] | undefined;
  const clearExisting = (body as any).clearExisting as boolean | undefined;

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

  try {
    // Ensure the per-deployment vault exists (idempotent) and read current
    // env-kind secrets from it.
    const { uri } = await ensureGenappKeyVault({ appId: deployment.id });
    const current = await getGenappSecrets(uri);

    if (action === "getEnvVars") {
      res.json({
        success: true,
        data: Object.entries(current)
          .filter(([, v]) => v.kind === "env")
          .map(([key, v]) => ({ key, value: v.value })),
      });
      return;
    }

    // updateEnvVars / syncEnvVars — compute the desired env map.
    const allVars = new Map<string, string>();
    if (!clearExisting) {
      for (const [key, v] of Object.entries(current)) {
        if (v.kind === "env") allVars.set(key, v.value);
      }
    }
    if (keysToDelete) {
      for (const k of keysToDelete) allVars.delete(k);
    }
    for (const v of newEnvVars || envVars || []) {
      if (v.key) allVars.set(v.key, v.value ?? "");
    }

    // Persist additions/updates.
    const entries: GenappSecretEntry[] = Array.from(allVars.entries()).map(
      ([key, value]) => ({ envName: key, value, kind: "env" }),
    );
    if (entries.length > 0) {
      await setGenappSecrets(uri, entries);
    }

    // Remove env secrets that are no longer present (explicit deletes plus any
    // pruned by clearExisting).
    const removed: GenappSecretEntry[] = [];
    for (const [key, v] of Object.entries(current)) {
      if (v.kind === "env" && !allVars.has(key)) {
        removed.push({ envName: key, value: "", kind: "env" });
      }
    }
    if (removed.length > 0) {
      await deleteGenappSecrets(uri, removed);
    }

    if (deployment.project_id) {
      broadcast(`deployments-${deployment.project_id}`, "deployment_refresh", {
        action: "env_updated",
        deploymentId: deployment.id,
      });
    }
    res.json({
      success: true,
      data: { status: "env_vars_updated", envVarsCount: allVars.size },
    });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
}

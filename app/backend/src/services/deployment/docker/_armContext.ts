/**
 * Shared Azure ARM REST helpers for Docker deployment lifecycle actions
 * (start, stop, restart, logs, getEvents, getEnvVars, updateEnvVars,
 * syncEnvVars). Relocated verbatim from `_legacyHandleDeploymentService`
 * in `app/backend/src/routes/functions.ts` to centralise the auth + URL
 * boilerplate that every Azure Container Apps lifecycle handler needs.
 *
 * Behavior contract: identical to the inline helpers prior to Phase 9 of
 * spec 006-docker-deploy-via-genapp-workflow. Do not introduce additional
 * retry, validation, or error mapping here without an explicit task.
 */
import { logger } from "../../../utils/logger";
import { AzureScope, getAzureTokenForScope } from "../../../utils/azureCredential";

export const ARM_BASE = "https://management.azure.com";

export interface ArmContext {
  /** Bearer-header object suitable for `fetch({ headers: armHeaders })`. */
  armHeaders: { Authorization: string; "Content-Type": string };
  /** `/subscriptions/<id>` prefix for ARM resource paths. */
  subPath: string;
  /** Resource group resolved for the current action (per-deployment for
   *  non-`create` verbs, falls back to the global default). */
  rg: string;
  acrName: string;
  acrResourceGroup: string;
  /** Generic Azure REST call. Throws on non-2xx with a truncated body. */
  azureRest: (method: string, path: string, body?: unknown) => Promise<any>;
  /** Poll an Azure async-operation Location URL until 200 or timeout. */
  pollOperation: (locationUrl: string, timeoutMs?: number) => Promise<any>;
  /**
   * Azure GETs return secrets with redacted values — re-populate ACR
   * password before any PUT round-trip.
   */
  fixSecretsForPut: (app: any) => Promise<void>;
}

/**
 * Acquire an ARM bearer token and return the shared helpers + per-action
 * resource group. Caller must guarantee `process.env.AZURE_SUBSCRIPTION_ID`
 * is set BEFORE invoking — the deployment-service entry point already
 * short-circuits when it is missing, so we do not duplicate that check
 * here (FR-014 behavior-preservation).
 *
 * @param action       Action verb being executed; only `create` uses the
 *                     global resource group, every other verb uses the
 *                     deployment's persisted `azure_resource_group`.
 * @param deployment   Persisted deployment row (carries
 *                     `azure_resource_group`).
 */
export async function getArmContext(
  action: string,
  deployment: { azure_resource_group?: string | null },
): Promise<ArmContext> {
  const AZURE_SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID;
  if (!AZURE_SUBSCRIPTION_ID) {
    throw new Error(
      "Deployment backend not configured. Set AZURE_SUBSCRIPTION_ID environment variable.",
    );
  }

  const AZURE_RESOURCE_GROUP =
    process.env.AZURE_DEPLOY_RESOURCE_GROUP || "Pronghorn-App";
  const AZURE_ACR_NAME =
    process.env.AZURE_ACR_NAME || "PronghornContainerRegistry";
  const AZURE_ACR_RESOURCE_GROUP =
    process.env.AZURE_ACR_RESOURCE_GROUP || AZURE_RESOURCE_GROUP;

  const armToken = await getAzureTokenForScope(AzureScope.ARM);
  const armHeaders = {
    Authorization: `Bearer ${armToken}`,
    "Content-Type": "application/json",
  };
  const subPath = `/subscriptions/${AZURE_SUBSCRIPTION_ID}`;

  const rg =
    action !== "create"
      ? deployment.azure_resource_group || AZURE_RESOURCE_GROUP
      : AZURE_RESOURCE_GROUP;

  const azureRest = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> => {
    const url = `${ARM_BASE}${path}`;
    const opts: RequestInit = { method, headers: armHeaders };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const response = await fetch(url, opts);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Azure API ${method} ${path}: ${response.status} - ${errText.substring(0, 200)}`,
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };

  const pollOperation = async (
    locationUrl: string,
    timeoutMs = 600_000,
  ): Promise<any> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 5000));
      const response = await fetch(locationUrl, { headers: armHeaders });
      if (response.status === 200) {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }
      if (response.status === 202) continue;
      if (response.status >= 400) {
        const errText = await response.text();
        throw new Error(`Operation failed: ${errText.substring(0, 200)}`);
      }
    }
    throw new Error("Operation timed out");
  };

  const fixSecretsForPut = async (app: any): Promise<void> => {
    if (!app?.properties?.configuration?.secrets?.length) return;
    try {
      const credData = await azureRest(
        "POST",
        `${subPath}/resourceGroups/${AZURE_ACR_RESOURCE_GROUP}/providers/Microsoft.ContainerRegistry/registries/${AZURE_ACR_NAME}/listCredentials?api-version=2023-07-01`,
        {},
      );
      const acrPwd = credData?.passwords?.[0]?.value || "";
      for (const secret of app.properties.configuration.secrets) {
        if (secret.name === "acr-password" && acrPwd) {
          secret.value = acrPwd;
        }
      }
    } catch (credErr) {
      logger.warn(
        `[deployment-service] Could not refresh ACR credentials: ${(credErr as Error).message}`,
      );
      delete app.properties.configuration.secrets;
    }
  };

  return {
    armHeaders,
    subPath,
    rg,
    acrName: AZURE_ACR_NAME,
    acrResourceGroup: AZURE_ACR_RESOURCE_GROUP,
    azureRest,
    pollOperation,
    fixSecretsForPut,
  };
}

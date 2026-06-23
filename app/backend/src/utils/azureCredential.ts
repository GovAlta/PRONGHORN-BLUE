/**
 * Centralized Azure credential provider.
 *
 * Acquires OAuth tokens for Azure resource scopes using a two-step strategy:
 *   1. **Managed Identity (IMDS)** — used automatically in Container Apps / App Service
 *      when `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` are present.
 *   2. **DefaultAzureCredential** — falls back through Azure CLI, env-var credentials,
 *      workload identity, etc. This covers local development transparently.
 *
 * Usage:
 *   import { getAzureTokenForScope, AzureScope } from '../utils/azureCredential';
 *   const token = await getAzureTokenForScope(AzureScope.ARM);
 *   const token = await getAzureTokenForScope(AzureScope.CognitiveServices);
 *
 * @module azureCredential
 */

import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { logger } from "./logger";

/** Well-known Azure resource scopes. */
export const AzureScope = {
  /** Azure Resource Manager (Container Apps, ACR, Resource Groups, etc.) */
  ARM: "https://management.azure.com/.default",
  /** Azure Cognitive Services / AI Foundry */
  CognitiveServices: "https://cognitiveservices.azure.com/.default",
  /** Azure Key Vault data-plane (secret get/set/delete/purge). */
  KeyVault: "https://vault.azure.net/.default",
} as const;

export type AzureScopeValue = (typeof AzureScope)[keyof typeof AzureScope];

/**
 * Singleton DefaultAzureCredential — safe to reuse across requests.
 * Lazily initialized on first call so the import itself has no side-effects.
 */
let _credential: TokenCredential | null = null;

function getDefaultCredential(): TokenCredential {
  if (!_credential) {
    _credential = new DefaultAzureCredential();
    logger.info("[azure-credential] DefaultAzureCredential initialized");
  }
  return _credential;
}

/**
 * Returns the shared Azure SDK credential for clients that manage token refresh internally.
 *
 * @example
 * const credential = getAzureCredential();
 */
export function getAzureCredential(): TokenCredential {
  return getDefaultCredential();
}

/**
 * Acquire a token for the given Azure resource scope via Managed Identity,
 * falling back to DefaultAzureCredential for local development.
 *
 * @param scope - The Azure resource scope (use `AzureScope.*` constants).
 * @returns The raw access token string.
 * @throws If no credential chain can produce a token.
 *
 * @example
 *   const armToken = await getAzureTokenForScope(AzureScope.ARM);
 *   const aiToken  = await getAzureTokenForScope(AzureScope.CognitiveServices);
 */
export async function getAzureTokenForScope(
  scope: AzureScopeValue,
): Promise<string> {
  const identityEndpoint = process.env.IDENTITY_ENDPOINT;
  const identityHeader = process.env.IDENTITY_HEADER;

  // -------------------------------------------------------------------
  // Strategy 1: Managed Identity (Container Apps / App Service / VMSS)
  // -------------------------------------------------------------------
  if (identityEndpoint && identityHeader) {
    // IMDS expects the resource *without* the `/.default` suffix
    const resource = scope.replace(/\/\.default$/, "");
    const tokenUrl = `${identityEndpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;

    logger.info(
      `[azure-credential] Requesting Managed Identity token (scope=${scope})`,
    );
    try {
      const res = await fetch(tokenUrl, {
        headers: { "X-IDENTITY-HEADER": identityHeader },
      });

      if (res.ok) {
        const data = (await res.json()) as { access_token: string };
        logger.info(
          `[azure-credential] Managed Identity token acquired (scope=${scope})`,
        );
        return data.access_token;
      }

      const errBody = await res.text();
      logger.warn(
        `[azure-credential] Managed Identity token request failed: ${res.status} ${res.statusText} — ${errBody.substring(0, 300)}. Falling back to DefaultAzureCredential.`,
      );
    } catch (err: any) {
      logger.warn(
        `[azure-credential] Managed Identity fetch error: ${err.message}. Falling back to DefaultAzureCredential.`,
      );
    }
  } else {
    logger.debug?.(
      `[azure-credential] Managed Identity env vars not present (IDENTITY_ENDPOINT=${identityEndpoint ? "set" : "unset"}, IDENTITY_HEADER=${identityHeader ? "set" : "unset"}). Using DefaultAzureCredential.`,
    );
  }

  // -------------------------------------------------------------------
  // Strategy 2: DefaultAzureCredential (Azure CLI, env creds, etc.)
  // -------------------------------------------------------------------
  try {
    const credential = getDefaultCredential();
    const tokenResponse = await credential.getToken(scope);
    if (!tokenResponse) {
      throw new Error(
        "getToken returned null — no credential in the chain could authenticate",
      );
    }
    logger.info(
      `[azure-credential] DefaultAzureCredential token acquired (scope=${scope})`,
    );
    return tokenResponse.token;
  } catch (err: any) {
    logger.error(
      `[azure-credential] All credential strategies failed for scope=${scope}: ${err.message}`,
    );
    throw new Error(
      `Unable to acquire Azure token for scope "${scope}". ` +
        "In production, ensure system-assigned Managed Identity is enabled. " +
        `For local dev, run "az login" first. Detail: ${err.message}`,
    );
  }
}

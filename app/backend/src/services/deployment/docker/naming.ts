/**
 * Resource-name computation for the genapp Docker deployment workflow.
 *
 * Derives the Azure Container App name and resource group from the project's
 * app name, app id, and target environment. The container app name is composed
 * as `${environment}-${safeName}-${shortId}` and MUST satisfy the Azure
 * Container App naming rules: <= 32 characters, lowercase, start with a letter,
 * alphanumerics + hyphens only, and no leading/trailing or consecutive hyphens.
 * The safe-name segment is therefore length-budgeted so the composed name never
 * exceeds 32 characters, and stripped of leading/trailing hyphens so truncation
 * cannot introduce an invalid `--` sequence.
 *
 * @example
 *   const { appName, resourceGroup } = computeGenappResourceNames({
 *     appName: "My App",
 *     appId: "12345678-1234-1234-1234-1234567890ab",
 *     environment: "dev",
 *   });
 *   // appName        === "dev-myapp-12345678"
 *   // resourceGroup  === "rg-genapp-myapp-12345678-dev"
 */
export interface ComputeGenappResourceNamesInput {
  appName: string;
  appId: string;
  environment: string;
}

export interface GenappResourceNames {
  appName: string;
  resourceGroup: string;
}

/** Azure Container App resource names are capped at 32 characters. */
const MAX_CONTAINER_APP_NAME_LENGTH = 32;

export function computeGenappResourceNames(
  input: ComputeGenappResourceNamesInput,
): GenappResourceNames {
  const APP_NAME_RAW = String(input.appName ?? "").toLowerCase();
  const APP_ID_SHORT = String(input.appId ?? "")
    .replace(/-/g, "")
    .slice(0, 8);
  const ENV_NAME = String(input.environment ?? "");

  // Budget the safe-name segment so `${ENV}-${SAFE}-${SHORT}` fits within the
  // 32-char limit (account for the two hyphen separators), then strip any
  // leading/trailing hyphens left by truncation to keep the name valid.
  const safeBudget = Math.max(
    0,
    MAX_CONTAINER_APP_NAME_LENGTH - ENV_NAME.length - APP_ID_SHORT.length - 2,
  );
  const APP_NAME_SAFE = APP_NAME_RAW.replace(/[^a-z0-9-]/g, "")
    .slice(0, safeBudget)
    .replace(/^-+|-+$/g, "");

  // Join only non-empty segments so degenerate inputs (empty env or a name that
  // reduces to nothing) never produce a leading/trailing or doubled hyphen.
  const appName = [ENV_NAME, APP_NAME_SAFE, APP_ID_SHORT]
    .filter((segment) => segment.length > 0)
    .join("-");
  const resourceGroup = ["rg-genapp", APP_NAME_SAFE, APP_ID_SHORT, ENV_NAME]
    .filter((segment) => segment.length > 0)
    .join("-");

  return { appName, resourceGroup };
}

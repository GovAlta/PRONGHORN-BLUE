/**
 * Per-generated-app Azure Key Vault service.
 *
 * Each user-generated app owns a dedicated Key Vault that is the single source
 * of truth for that app's environment variables, user secrets, and database
 * connection string. Values NEVER live in Postgres — the backend reads/writes
 * them here via the Azure REST APIs (management plane for vault lifecycle +
 * RBAC, data plane for secret get/set/list/delete).
 *
 * Bootstrap model (resolves the "Terraform runs after env vars are created"
 * constraint): the BACKEND creates the vault lazily (idempotent upsert) the
 * first time secrets are written — typically at app creation, before the
 * per-app Terraform deploy runs. The per-app Terraform later CONSUMES the vault
 * via a data source, grants the container's managed identity read access, and
 * wires the container's secret references. Because the vault lives in a SHARED
 * platform resource group (not the per-app resource group that Terraform owns),
 * its lifecycle is decoupled from `terraform destroy`; the backend purges it
 * explicitly when the app is destroyed.
 *
 * Operational prerequisites (production):
 *   - The backend's managed identity must have, on the shared Key Vault
 *     resource group: `Contributor` (create vaults) and `User Access
 *     Administrator` / `Owner` (create the per-vault role assignment).
 *   - `AZURE_SUBSCRIPTION_ID` must be set; the tenant id comes from
 *     `ENTRA_TENANT_ID` (preferred) or `AZURE_TENANT_ID`.
 *   - `AZURE_GENAPP_KEYVAULT_RESOURCE_GROUP` (falls back to
 *     `AZURE_DEPLOY_RESOURCE_GROUP`, then `Pronghorn-App`).
 *   - `AZURE_API_PRINCIPAL_ID` — object id of the backend's own managed
 *     identity, granted `Key Vault Secrets Officer` so it can read/write
 *     secret values. When unset, the role assignment step is skipped (assumed
 *     pre-granted) and a warning is logged.
 *
 * @module genappKeyVault
 */
import { v5 as uuidv5 } from "uuid";
import { logger } from "../../../utils/logger";
import {
  AzureScope,
  getAzureTokenForScope,
} from "../../../utils/azureCredential";

const ARM_BASE = "https://management.azure.com";
const KV_DATA_PLANE_API_VERSION = "7.4";
const KV_MGMT_API_VERSION = "2023-07-01";
const ROLE_ASSIGNMENT_API_VERSION = "2022-04-01";
const NETWORK_MGMT_API_VERSION = "2024-05-01";

/** ASCII char code for the hyphen-minus character ('-'). */
const HYPHEN_CHAR_CODE = 45;

/** Built-in role: Key Vault Secrets Officer (read/write secret values). */
const KEY_VAULT_SECRETS_OFFICER_ROLE_ID =
  "b86a8fe4-44ce-4948-aff5-9eba01fd6e75";

/** Stable namespace for deterministic role-assignment GUIDs. */
const ROLE_ASSIGNMENT_NAMESPACE = "1b671a64-40d5-491e-99b0-da01ff1f3341";

const LOG_PREFIX = "[genapp-keyvault]";

/** Classification tag applied to every secret so Terraform can wire it. */
export type GenappSecretKind = "env" | "secret" | "dbconn";

export interface GenappSecretEntry {
  /** Original environment-variable name as the container will expose it. */
  envName: string;
  /** Secret value. */
  value: string;
  /** Classification (env var, user secret, or DB connection string). */
  kind: GenappSecretKind;
}

export interface EnsureGenappKeyVaultResult {
  name: string;
  uri: string;
  /** Shared platform resource group that contains the vault. */
  resourceGroup: string;
}

/* ---------------------------------------------------------------------- *
 * Naming helpers (pure)                                                    *
 * ---------------------------------------------------------------------- */

/**
 * Derive the globally-unique Key Vault name for an app.
 *
 * Format: `kv-ga-` + first 18 hex chars of the app id (UUID hyphens stripped)
 * → exactly 24 chars, satisfying Azure's 3–24 char vault-name limit. Lowercase
 * alphanumerics + hyphens only.
 *
 * @param appId - Deployment/app UUID.
 * @returns Deterministic vault name.
 * @example
 *   deriveGenappKeyVaultName("12345678-1234-1234-1234-1234567890ab");
 *   // => "kv-ga-123456781234123412"
 */
export function deriveGenappKeyVaultName(appId: string): string {
  if (!appId || typeof appId !== "string") {
    throw new Error("deriveGenappKeyVaultName: appId is required");
  }
  const hex = appId.replace(/-/g, "").toLowerCase().slice(0, 18);
  // Strictly validate the derived value is lowercase hex only. This both
  // guarantees a valid Key Vault name and acts as an injection barrier: the
  // name is later embedded in the vault data-plane host, so any non-hex
  // character (which could alter the URL host) must be rejected here.
  if (!/^[0-9a-f]{18}$/.test(hex)) {
    throw new Error(
      `deriveGenappKeyVaultName: appId "${appId}" is not a valid hex identifier`,
    );
  }
  return `kv-ga-${hex}`;
}

/**
 * Derive the data-plane URI for a vault name.
 *
 * @param vaultName - Key Vault name.
 * @returns `https://<name>.vault.azure.net`.
 */
export function deriveGenappKeyVaultUri(vaultName: string): string {
  return `https://${vaultName}.vault.azure.net`;
}

/**
 * Resolve the central platform Key Vault data-plane URI.
 *
 * Project database connection strings are stored here (NOT in a per-project
 * vault) because their only reader is the Pronghorn API itself. The central
 * vault already exists with a working private endpoint, DNS registration, and
 * an RBAC grant for the API identity, so writes are a single fast data-plane
 * call — there is no vault-create / private-endpoint / DNS-propagation race
 * (the failure mode the per-project vaults suffered). No user/generated app is
 * granted a role on this vault, so cross-app isolation is preserved.
 *
 * Driven by `AZURE_PLATFORM_KEYVAULT_URI` (Terraform wires `module.keyvault.vault_uri`).
 * Falls back to deriving the URI from `AZURE_PLATFORM_KEYVAULT_NAME`.
 *
 * @returns `https://<name>.vault.azure.net`.
 * @throws If neither variable is set.
 */
export function centralKeyVaultUri(): string {
  const uri = process.env.AZURE_PLATFORM_KEYVAULT_URI;
  if (uri) return uri.replace(/\/+$/, "");
  const name = process.env.AZURE_PLATFORM_KEYVAULT_NAME;
  if (name) return deriveGenappKeyVaultUri(name);
  throw new Error(
    `${LOG_PREFIX} required environment variable AZURE_PLATFORM_KEYVAULT_URI ` +
      "(or AZURE_PLATFORM_KEYVAULT_NAME) is not set",
  );
}

/**
 * Map an environment-variable name to a valid Key Vault secret name.
 *
 * Key Vault secret names allow only `[0-9a-zA-Z-]`. The original name is NOT
 * recoverable from the sanitized form, so callers MUST also persist the
 * original via the `envName` tag (see {@link setGenappSecrets}); Terraform
 * reads that tag to reconstruct the container env mapping. A short hash of the
 * original name is appended to avoid collisions after sanitization.
 *
 * @param kind - Secret classification (prefixes the name).
 * @param envName - Original environment-variable name.
 * @returns Deterministic, valid Key Vault secret name (<= 127 chars).
 * @example
 *   deriveSecretName("env", "DATABASE_URL"); // => "env-database-url-1a2b3c"
 */
export function deriveSecretName(
  kind: GenappSecretKind,
  envName: string,
): string {
  const sanitized = stripEdgeHyphens(
    envName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-"),
  ).slice(0, 100);
  const hash = shortHash(envName);
  const prefix = kind === "env" ? "env" : kind === "secret" ? "sec" : "dbc";
  const base = sanitized.length > 0 ? `${prefix}-${sanitized}` : prefix;
  // encodeURIComponent is a no-op for the derived `[a-z0-9-]` name, but it marks
  // the result as sanitized for static analysis (the name is later interpolated
  // into a Key Vault data-plane request URL — SSRF / path-injection barrier).
  return encodeURIComponent(`${base}-${hash}`);
}

/** Remove leading/trailing ASCII hyphens via a linear scan. Avoids the
 *  polynomial-backtracking regex `/^-+|-+$/g` (an O(n^2) ReDoS sink). */
function stripEdgeHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === HYPHEN_CHAR_CODE) start++;
  while (end > start && value.charCodeAt(end - 1) === HYPHEN_CHAR_CODE) end--;
  return value.slice(start, end);
}

/** Stable 6-char hex hash of a string (FNV-1a). Not cryptographic. */
function shortHash(input: string): string {
  // Bound the number of iterations with an explicit numeric limit so an
  // attacker-supplied, very long input cannot cause excessive CPU work (the
  // leading bytes provide ample entropy for a non-cryptographic
  // collision-avoidance hash).
  const MAX_HASH_INPUT = 1024;
  const limit = Math.min(input.length, MAX_HASH_INPUT);
  let h = 0x811c9dc5;
  for (let i = 0; i < limit; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/* ---------------------------------------------------------------------- *
 * Azure REST plumbing                                                      *
 * ---------------------------------------------------------------------- */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${LOG_PREFIX} required environment variable ${name} is not set`,
    );
  }
  return value;
}

export function genappKeyVaultResourceGroup(): string {
  return (
    process.env.AZURE_GENAPP_KEYVAULT_RESOURCE_GROUP ||
    process.env.AZURE_DEPLOY_RESOURCE_GROUP ||
    "Pronghorn-App"
  );
}

/**
 * The Entra tenant id for the backend's Azure REST calls.
 *
 * The platform deliberately publishes the tenant as `ENTRA_TENANT_ID` and
 * leaves `AZURE_TENANT_ID` unset in the container, because `@azure/identity`'s
 * `DefaultAzureCredential` treats `AZURE_TENANT_ID` (with `AZURE_CLIENT_ID`) as
 * an explicit credential and fails managed-identity auth when only one is
 * present. Mirror the `ENTRA_*`-with-`AZURE_*`-fallback convention used by
 * `auth.ts`/`websocket.ts` so the vault code works in the container and in
 * local dev.
 *
 * @returns The tenant id.
 * @throws If neither variable is set.
 */
function genappTenantId(): string {
  const tenantId =
    process.env.AZURE_TENANT_ID || process.env.ENTRA_TENANT_ID || "";
  if (!tenantId) {
    throw new Error(
      `${LOG_PREFIX} required environment variable ENTRA_TENANT_ID ` +
        "(or AZURE_TENANT_ID) is not set",
    );
  }
  return tenantId;
}

function genappKeyVaultLocation(): string {
  return (
    process.env.AZURE_GENAPP_LOCATION || process.env.AZURE_LOCATION || "eastus2"
  );
}

/**
 * Whether per-app Key Vaults should accept public network access.
 *
 * Driven by `AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS` ("Enabled"|"Disabled"),
 * which Terraform wires from the per-environment tfvars. Defaults to "Disabled"
 * (secure by default). Dev sets "Enabled" because the lazily-created per-app
 * vaults have no private endpoints there; PBMM leaves it disabled and reaches
 * the vaults over private endpoints.
 *
 * @returns The ARM `publicNetworkAccess` value to apply.
 */
export function genappKeyVaultPublicNetworkAccess(): "Enabled" | "Disabled" {
  return (
    process.env.AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS || ""
  ).toLowerCase() === "enabled"
    ? "Enabled"
    : "Disabled";
}

/**
 * Resource tags for a per-app Key Vault.
 *
 * When public network access is enabled (dev), apply `SecurityControl=Ignore`
 * so the vault is exempt from the corporate Azure Policy that denies
 * public-network Key Vaults — without it the policy blocks creation and the app
 * cannot reach the vault. When public access is disabled (PBMM, private
 * endpoints), the exemption tag is omitted.
 *
 * @param publicNetworkAccess - The vault's public-network-access setting.
 * @returns Tag map (possibly empty).
 */
export function genappKeyVaultTags(
  publicNetworkAccess: "Enabled" | "Disabled",
): Record<string, string> {
  return publicNetworkAccess === "Enabled" ? { SecurityControl: "Ignore" } : {};
}

/**
 * Subnet the backend places per-app Key Vault private endpoints in.
 *
 * Required (only) when public network access is `Disabled` (PBMM): the vault is
 * locked to `defaultAction=Deny`, so the backend can reach the data plane to
 * write secrets only over a private endpoint. Driven by
 * `AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID` (Terraform wires the shared
 * PE subnet). Returns `null` when unset.
 *
 * @returns The private-endpoint subnet resource id, or `null`.
 */
export function genappKeyVaultPrivateEndpointSubnetId(): string | null {
  return process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID || null;
}

/**
 * Optional Private DNS Zone id (`privatelink.vaultcore.azure.net`) for the
 * per-app vault private endpoints.
 *
 * When set (`AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID`), the backend attaches
 * the `default` DNS zone group itself (synchronous). When unset, it instead
 * waits for the landing-zone Azure Policy (DeployIfNotExists) to attach the
 * `default` zone group asynchronously — matching the core Key Vault behaviour.
 *
 * @returns The private DNS zone resource id, or `null`.
 */
export function genappKeyVaultPrivateDnsZoneId(): string | null {
  return process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID || null;
}

/**
 * Timing for the per-app vault DNS-propagation wait.
 *
 * All values are seconds, environment-overridable, with PBMM-safe defaults:
 *   - `AZURE_GENAPP_KEYVAULT_DNS_WAIT_TIMEOUT_SECONDS` (default 600) — give up
 *     after this long waiting for the Policy-attached `default` zone group.
 *   - `AZURE_GENAPP_KEYVAULT_DNS_WAIT_INTERVAL_SECONDS` (default 10) — poll gap.
 *   - `AZURE_GENAPP_KEYVAULT_DNS_SETTLE_SECONDS` (default 15) — extra settle
 *     once the zone group exists, so the private A-record propagates to the
 *     resolver before the first data-plane secret write.
 *
 * @returns Wait config in milliseconds.
 */
export function genappKeyVaultDnsWaitConfig(): {
  timeoutMs: number;
  intervalMs: number;
  settleMs: number;
} {
  const seconds = (name: string, fallback: number): number => {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    timeoutMs:
      seconds("AZURE_GENAPP_KEYVAULT_DNS_WAIT_TIMEOUT_SECONDS", 600) * 1000,
    intervalMs:
      seconds("AZURE_GENAPP_KEYVAULT_DNS_WAIT_INTERVAL_SECONDS", 10) * 1000,
    settleMs: seconds("AZURE_GENAPP_KEYVAULT_DNS_SETTLE_SECONDS", 15) * 1000,
  };
}

/** Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function armRest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const token = await getAzureTokenForScope(AzureScope.ARM);
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const response = await fetch(`${ARM_BASE}${path}`, opts);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Azure ARM ${method} ${path}: ${response.status} - ${text.substring(0, 300)}`,
    );
  }
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function kvDataPlane(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  // SSRF guard: this helper must only ever reach the Azure Key Vault data
  // plane. Reject any URL whose host is not a *.vault.azure.net endpoint.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${LOG_PREFIX} invalid Key Vault URL`);
  }
  if (
    parsedUrl.protocol !== "https:" ||
    !parsedUrl.hostname.toLowerCase().endsWith(".vault.azure.net")
  ) {
    throw new Error(
      `${LOG_PREFIX} refusing to call non-Key Vault host: ${parsedUrl.hostname}`,
    );
  }
  const token = await getAzureTokenForScope(AzureScope.KeyVault);
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const response = await fetch(parsedUrl, opts);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Key Vault ${method} ${url}: ${response.status} - ${text.substring(0, 300)}`,
    );
  }
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

/* ---------------------------------------------------------------------- *
 * Vault lifecycle (management plane)                                       *
 * ---------------------------------------------------------------------- */

/**
 * Idempotently create (or update) the per-app Key Vault and grant the backend
 * managed identity `Key Vault Secrets Officer` so it can read/write values.
 *
 * Safe to call repeatedly. The vault is RBAC-authorized, 7-day soft-delete,
 * purge protection OFF (so the backend can free the name on destroy). Public
 * network access (and the corresponding `SecurityControl=Ignore` policy
 * exemption tag) is environment-driven — see
 * {@link genappKeyVaultPublicNetworkAccess} and {@link genappKeyVaultTags}.
 *
 * @param input.appId - Deployment/app UUID.
 * @param input.location - Optional Azure region (defaults to env/`eastus2`).
 * @returns The vault name + data-plane URI.
 */
export async function ensureGenappKeyVault(input: {
  appId: string;
  location?: string;
}): Promise<EnsureGenappKeyVaultResult> {
  const subscriptionId = requireEnv("AZURE_SUBSCRIPTION_ID");
  const tenantId = genappTenantId();
  const rg = genappKeyVaultResourceGroup();
  const name = deriveGenappKeyVaultName(input.appId);
  const location = input.location || genappKeyVaultLocation();

  const vaultPath =
    `/subscriptions/${subscriptionId}/resourceGroups/${rg}` +
    `/providers/Microsoft.KeyVault/vaults/${name}` +
    `?api-version=${KV_MGMT_API_VERSION}`;

  const publicNetworkAccess = genappKeyVaultPublicNetworkAccess();
  const tags = genappKeyVaultTags(publicNetworkAccess);
  const body: Record<string, unknown> = {
    location,
    properties: {
      tenantId,
      sku: { family: "A", name: "standard" },
      enableRbacAuthorization: true,
      enableSoftDelete: true,
      softDeleteRetentionInDays: 7,
      enablePurgeProtection: null,
      publicNetworkAccess,
      networkAcls: {
        bypass: "AzureServices",
        defaultAction: publicNetworkAccess === "Enabled" ? "Allow" : "Deny",
      },
    },
  };
  // Only set tags when non-empty so a PUT in PBMM does not clear
  // policy-inherited governance tags on the vault.
  if (Object.keys(tags).length > 0) {
    body.tags = tags;
  }

  await armRest("PUT", vaultPath, body);

  const uri = deriveGenappKeyVaultUri(name);
  await grantSecretsOfficer({ subscriptionId, rg, vaultName: name });

  // PBMM: the vault is created with public access Disabled + defaultAction Deny,
  // so the backend has NO network path to write secrets until a private endpoint
  // exists and the private DNS A-record resolves. Provision both before returning
  // so downstream setGenappSecrets() calls never race ahead of DNS registration.
  if (publicNetworkAccess === "Disabled") {
    await ensureGenappKeyVaultPrivateConnectivity({
      subscriptionId,
      rg,
      vaultName: name,
      location,
    });
  }

  logger.info(`${LOG_PREFIX} ensured vault ${name} in ${rg}`);
  return { name, uri, resourceGroup: rg };
}

/* ---------------------------------------------------------------------- *
 * Private connectivity (management plane)                                  *
 * ---------------------------------------------------------------------- */

/**
 * Poll an ARM resource until its `provisioningState` is `Succeeded`.
 *
 * @param path - ARM resource path including `?api-version=`.
 * @param label - Human-readable label for error/log messages.
 * @param timeoutMs - Overall timeout (default 5 min).
 * @param intervalMs - Poll interval (default 5 s).
 * @throws If provisioning fails or the timeout elapses.
 */
async function waitForProvisioned(
  path: string,
  label: string,
  timeoutMs = 300000,
  intervalMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await armRest("GET", path);
    const state = data?.properties?.provisioningState;
    if (state === "Succeeded") return;
    if (state === "Failed" || state === "Canceled") {
      throw new Error(`${LOG_PREFIX} ${label} provisioning ${state}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${LOG_PREFIX} timed out waiting for ${label} to provision`,
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Wait for the landing-zone Azure Policy to attach the `default` private DNS
 * zone group to a private endpoint. Treats a 404 / not-found as "not attached
 * yet" and keeps polling; any other error is rethrown.
 *
 * @param zoneGroupPath - ARM path of the `default` zone group (with api-version).
 * @param peName - Private endpoint name (for error messages).
 * @param timeoutMs - Overall timeout.
 * @param intervalMs - Poll interval.
 * @throws If the zone group is not attached before the timeout.
 */
async function waitForDnsZoneGroup(
  zoneGroupPath: string,
  peName: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { data } = await armRest("GET", zoneGroupPath);
      if (data?.properties?.provisioningState === "Succeeded") return;
    } catch (err) {
      const message = (err as Error).message;
      const notFound =
        message.includes(": 404") ||
        message.includes("NotFound") ||
        message.includes("was not found");
      if (!notFound) throw err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${LOG_PREFIX} timed out after ${Math.round(timeoutMs / 1000)}s waiting ` +
          `for Azure Policy to attach the DNS zone group to ${peName}`,
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Ensure the per-app vault is reachable over a private endpoint and that its
 * private DNS A-record resolves, so the backend can write secrets in PBMM
 * (where the vault has public access Disabled).
 *
 * Steps, all idempotent:
 *   1. PUT a private endpoint (`<vault>-pe`, group `vault`) into the configured
 *      PE subnet and wait for it to finish provisioning.
 *   2. Either attach the `default` DNS zone group directly (when a zone id is
 *      configured) or wait for landing-zone Policy to attach it.
 *   3. Settle briefly so the A-record propagates before the first secret write.
 *
 * @throws If no PE subnet is configured (misconfiguration in PBMM).
 */
async function ensureGenappKeyVaultPrivateConnectivity(input: {
  subscriptionId: string;
  rg: string;
  vaultName: string;
  location: string;
}): Promise<void> {
  const { subscriptionId, rg, vaultName, location } = input;

  const subnetId = genappKeyVaultPrivateEndpointSubnetId();
  if (!subnetId) {
    throw new Error(
      `${LOG_PREFIX} AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID is required ` +
        "when AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS=Disabled — there is no " +
        `network path to write secrets to vault ${vaultName} without a private endpoint`,
    );
  }

  const peName = `${vaultName}-pe`;
  const vaultId =
    `/subscriptions/${subscriptionId}/resourceGroups/${rg}` +
    `/providers/Microsoft.KeyVault/vaults/${vaultName}`;
  const peId =
    `/subscriptions/${subscriptionId}/resourceGroups/${rg}` +
    `/providers/Microsoft.Network/privateEndpoints/${peName}`;
  const pePath = `${peId}?api-version=${NETWORK_MGMT_API_VERSION}`;

  // 1) Idempotently create the private endpoint to the vault.
  await armRest("PUT", pePath, {
    location,
    properties: {
      subnet: { id: subnetId },
      privateLinkServiceConnections: [
        {
          name: `${vaultName}-plsc`,
          properties: { privateLinkServiceId: vaultId, groupIds: ["vault"] },
        },
      ],
    },
  });
  await waitForProvisioned(pePath, `private endpoint ${peName}`);

  // 2) Attach (or wait for) the "default" DNS zone group.
  const zoneGroupPath = `${peId}/privateDnsZoneGroups/default?api-version=${NETWORK_MGMT_API_VERSION}`;
  const dnsZoneId = genappKeyVaultPrivateDnsZoneId();
  const { timeoutMs, intervalMs, settleMs } = genappKeyVaultDnsWaitConfig();

  if (dnsZoneId) {
    await armRest("PUT", zoneGroupPath, {
      properties: {
        privateDnsZoneConfigs: [
          { name: "vault", properties: { privateDnsZoneId: dnsZoneId } },
        ],
      },
    });
    await waitForProvisioned(zoneGroupPath, `DNS zone group for ${peName}`);
  } else {
    await waitForDnsZoneGroup(zoneGroupPath, peName, timeoutMs, intervalMs);
  }

  // 3) Settle so the private A-record propagates before the first secret write.
  if (settleMs > 0) await sleep(settleMs);

  logger.info(
    `${LOG_PREFIX} private endpoint ${peName} ready and DNS zone group attached`,
  );
}

/**
 * Grant the backend's managed identity Secrets Officer on the vault, using a
 * deterministic role-assignment name so the call is idempotent.
 */
async function grantSecretsOfficer(input: {
  subscriptionId: string;
  rg: string;
  vaultName: string;
}): Promise<void> {
  const principalId = process.env.AZURE_API_PRINCIPAL_ID;
  if (!principalId) {
    logger.warn(
      `${LOG_PREFIX} AZURE_API_PRINCIPAL_ID not set — skipping Secrets Officer ` +
        `role assignment for ${input.vaultName} (assuming pre-granted)`,
    );
    return;
  }

  const scope =
    `/subscriptions/${input.subscriptionId}/resourceGroups/${input.rg}` +
    `/providers/Microsoft.KeyVault/vaults/${input.vaultName}`;
  const roleDefinitionId =
    `/subscriptions/${input.subscriptionId}/providers/Microsoft.Authorization` +
    `/roleDefinitions/${KEY_VAULT_SECRETS_OFFICER_ROLE_ID}`;
  const assignmentName = uuidv5(
    `${scope}:${principalId}:secrets-officer`,
    ROLE_ASSIGNMENT_NAMESPACE,
  );
  const path =
    `${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentName}` +
    `?api-version=${ROLE_ASSIGNMENT_API_VERSION}`;

  try {
    await armRest("PUT", path, {
      properties: {
        roleDefinitionId,
        principalId,
        principalType: "ServicePrincipal",
      },
    });
  } catch (err) {
    // 409 = already exists with same props → benign on repeat calls.
    const message = (err as Error).message;
    if (message.includes("RoleAssignmentExists") || message.includes(": 409")) {
      return;
    }
    throw err;
  }
}

/**
 * Delete and PURGE the per-app vault so its (deterministic) name is freed for
 * reuse. Best-effort: missing vaults are treated as already-gone.
 *
 * @param input.appId - Deployment/app UUID.
 */
export async function purgeGenappKeyVault(input: {
  appId: string;
}): Promise<void> {
  const subscriptionId = requireEnv("AZURE_SUBSCRIPTION_ID");
  const rg = genappKeyVaultResourceGroup();
  const name = deriveGenappKeyVaultName(input.appId);
  const location = genappKeyVaultLocation();

  const vaultPath =
    `/subscriptions/${subscriptionId}/resourceGroups/${rg}` +
    `/providers/Microsoft.KeyVault/vaults/${name}` +
    `?api-version=${KV_MGMT_API_VERSION}`;
  // Delete the private endpoint first so it does not block vault deletion and is
  // not orphaned in the shared RG. Best-effort: a missing PE is already gone.
  const peName = `${name}-pe`;
  const pePath =
    `/subscriptions/${subscriptionId}/resourceGroups/${rg}` +
    `/providers/Microsoft.Network/privateEndpoints/${peName}` +
    `?api-version=${NETWORK_MGMT_API_VERSION}`;
  try {
    await armRest("DELETE", pePath);
  } catch (err) {
    logger.warn(
      `${LOG_PREFIX} delete private endpoint ${peName} failed (continuing): ${(err as Error).message}`,
    );
  }
  try {
    await armRest("DELETE", vaultPath);
  } catch (err) {
    logger.warn(
      `${LOG_PREFIX} delete vault ${name} failed (continuing to purge): ${(err as Error).message}`,
    );
  }

  const purgePath =
    `/subscriptions/${subscriptionId}/providers/Microsoft.KeyVault` +
    `/locations/${location}/deletedVaults/${name}/purge` +
    `?api-version=${KV_MGMT_API_VERSION}`;
  try {
    await armRest("POST", purgePath);
    logger.info(`${LOG_PREFIX} purged vault ${name}`);
  } catch (err) {
    logger.warn(
      `${LOG_PREFIX} purge vault ${name} failed: ${(err as Error).message}`,
    );
  }
}

/* ---------------------------------------------------------------------- *
 * Secret values (data plane)                                               *
 * ---------------------------------------------------------------------- */

/**
 * Write a batch of secrets into the app's vault. The vault must already exist
 * (call {@link ensureGenappKeyVault} first). Each entry's original env name +
 * classification are stored as tags so Terraform can reconstruct the container
 * env mapping.
 *
 * @param vaultUri - `https://<name>.vault.azure.net`.
 * @param entries - Secret entries to upsert.
 */
export async function setGenappSecrets(
  vaultUri: string,
  entries: GenappSecretEntry[],
): Promise<void> {
  for (const entry of entries) {
    const secretName = deriveSecretName(entry.kind, entry.envName);
    const url = `${vaultUri}/secrets/${secretName}?api-version=${KV_DATA_PLANE_API_VERSION}`;
    await kvDataPlane("PUT", url, {
      value: entry.value,
      tags: { envName: entry.envName, kind: entry.kind },
    });
  }
}

/**
 * Read all secrets from the app's vault, returning them keyed by their ORIGINAL
 * environment-variable name (recovered from the `envName` tag).
 *
 * @param vaultUri - `https://<name>.vault.azure.net`.
 * @returns Map of `{ envName: { value, kind } }`.
 */
export async function getGenappSecrets(
  vaultUri: string,
): Promise<Record<string, { value: string; kind: GenappSecretKind }>> {
  const result: Record<string, { value: string; kind: GenappSecretKind }> = {};
  let nextLink: string | null =
    `${vaultUri}/secrets?api-version=${KV_DATA_PLANE_API_VERSION}`;

  while (nextLink) {
    const { data } = await kvDataPlane("GET", nextLink);
    for (const item of data?.value || []) {
      const secretName = String(item.id).split("/").pop();
      const { data: secret } = await kvDataPlane(
        "GET",
        `${vaultUri}/secrets/${secretName}?api-version=${KV_DATA_PLANE_API_VERSION}`,
      );
      const envName: string = secret?.tags?.envName || secretName;
      const kind: GenappSecretKind =
        (secret?.tags?.kind as GenappSecretKind) || "env";
      result[envName] = { value: secret?.value ?? "", kind };
    }
    nextLink = data?.nextLink || null;
  }
  return result;
}

/**
 * Delete specific secrets by their original env-var names.
 *
 * @param vaultUri - `https://<name>.vault.azure.net`.
 * @param entries - `{ envName, kind }` pairs identifying the secrets.
 */
export async function deleteGenappSecrets(
  vaultUri: string,
  entries: { envName: string; kind: GenappSecretKind }[],
): Promise<void> {
  for (const entry of entries) {
    const secretName = deriveSecretName(entry.kind, entry.envName);
    const url = `${vaultUri}/secrets/${secretName}?api-version=${KV_DATA_PLANE_API_VERSION}`;
    try {
      await kvDataPlane("DELETE", url);
    } catch (err) {
      logger.warn(
        `${LOG_PREFIX} delete secret ${secretName} failed: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Read a single secret value by its (already-derived) Key Vault secret name.
 * Returns `null` when the secret does not exist.
 *
 * @param vaultUri - `https://<name>.vault.azure.net`.
 * @param secretName - Key Vault secret name (see {@link deriveSecretName}).
 */
export async function getGenappSecret(
  vaultUri: string,
  secretName: string,
): Promise<string | null> {
  const url = `${vaultUri}/secrets/${secretName}?api-version=${KV_DATA_PLANE_API_VERSION}`;
  try {
    const { data } = await kvDataPlane("GET", url);
    return data?.value ?? null;
  } catch (err) {
    if ((err as Error).message.includes(": 404")) return null;
    throw err;
  }
}

/* ---------------------------------------------------------------------- *
 * Project database connection strings                                      *
 * ---------------------------------------------------------------------- *
 * Database connection strings (for both provisioned and external
 * `project_database_connections`) are stored in the CENTRAL platform Key Vault,
 * each under a secret derived from the connection id. Their only reader is the
 * Pronghorn API itself, so a per-project vault added no isolation — only
 * fragility, since the lazily-created per-project vault + private endpoint + DNS
 * propagation could race a container restart and silently lose the secret. The
 * central vault already exists, is reachable, and only the API identity holds a
 * role on it, so cross-app isolation is preserved while the write becomes a
 * single fast, durable data-plane call. The `projectId` argument is retained on
 * each function purely for call-site parity.
 */

/**
 * Upsert a project database connection string into the central platform Key
 * Vault, keyed by the connection id.
 *
 * The central vault already exists (with private endpoint + DNS + the API's
 * RBAC grant), so this is a single fast data-plane write — no vault creation or
 * private-endpoint/DNS provisioning is involved. The secret is readable only by
 * the Pronghorn API identity; no generated/user app has access.
 *
 * @param input.projectId - Owning project UUID (retained for call-site parity).
 * @param input.connectionId - Connection UUID (keys the secret).
 * @param input.connectionString - Plaintext connection string.
 */
export async function setConnectionStringSecret(input: {
  projectId: string;
  connectionId: string;
  connectionString: string;
}): Promise<void> {
  const uri = centralKeyVaultUri();
  await setGenappSecrets(uri, [
    {
      envName: input.connectionId,
      value: input.connectionString,
      kind: "dbconn",
    },
  ]);
}

/**
 * Read a project database connection string from the central platform Key
 * Vault. Returns `null` when absent.
 *
 * @param input.projectId - Owning project UUID (retained for call-site parity).
 * @param input.connectionId - Connection UUID.
 */
export async function getConnectionStringSecret(input: {
  projectId: string;
  connectionId: string;
}): Promise<string | null> {
  const uri = centralKeyVaultUri();
  const secretName = deriveSecretName("dbconn", input.connectionId);
  return getGenappSecret(uri, secretName);
}

/**
 * Delete a project database connection string from the central platform Key
 * Vault.
 *
 * @param input.projectId - Owning project UUID (retained for call-site parity).
 * @param input.connectionId - Connection UUID.
 */
export async function deleteConnectionStringSecret(input: {
  projectId: string;
  connectionId: string;
}): Promise<void> {
  const uri = centralKeyVaultUri();
  await deleteGenappSecrets(uri, [
    { envName: input.connectionId, kind: "dbconn" },
  ]);
}

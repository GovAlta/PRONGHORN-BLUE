# PBMM Troubleshooting & Infrastructure Gaps

> **Parent guide:** [PBMM Deployment Guide](../PBMM_DEPLOYMENT.md)
>
> This document covers known infrastructure gaps, the most common runtime
> failure patterns in PBMM environments, and their fixes. Use it when
> diagnosing post-deployment issues or preparing for a new PBMM landing zone.

---

## 1. Known Infrastructure Gaps

### 1.1 APIM Internal VNet Mode

APIM uses **Internal VNet** mode (no separate private endpoint). This requires
the **Premium** SKU — already set in `params/pbmm.tfvars`. Developer/Standard
cannot be used in Internal mode for production.

### 1.2 Front Door

Front Door is always public; it is **disabled** for PBMM. Ingress is handled via
the internal Container Apps load balancer + APIM. See
[Custom Domain Setup](custom-domain-setup.md) for the App Gateway pattern used
instead.

### 1.3 Log Analytics / Application Insights

Log Analytics and Application Insights do not have private endpoints in the
current logging module. If the customer requires AMPLS (Azure Monitor Private
Link Scope), that must be added to the logging module separately.

### 1.4 ACR Agent Pool

`enable_acr_agent_pool = true` is required (and set) so `az acr build` runs on
VNet-attached agents against the private registry.

### 1.5 Generated-App (Per-App) Key Vaults

Generated-app Key Vaults are created at runtime, not by Terraform. The API
creates one Key Vault per generated app (`kv-ga-<appId>`, in the shared genapp
resource group) on demand via the Azure REST API
(`app/backend/src/services/deployment/docker/genappKeyVault.ts`), then writes the
app's secrets over the data plane.

In PBMM the vault is created with `publicNetworkAccess = Disabled` and
`networkAcls.defaultAction = Deny`
(`AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS=Disabled`). Because Terraform never
sees these vaults, the backend itself establishes private connectivity before the
first secret write:

1. **Creates a private endpoint** (`kv-ga-*-pe`, group `vault`) into the
   configured PE subnet (`AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID`,
   defaulting to `keyvault_private_endpoint_subnet_id`) and waits for it to
   finish provisioning.
2. **Establishes DNS resolution** — if `AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID`
   is set it attaches the `default` `privatelink.vaultcore.azure.net` zone group
   directly; otherwise it waits (poll, default 10 min) for landing-zone Azure
   Policy to attach the `default` zone group, then settles briefly
   (`AZURE_GENAPP_KEYVAULT_DNS_SETTLE_SECONDS`, default 15 s) so the A-record
   propagates before any `setSecret` call.

On app destroy the backend deletes the private endpoint before purging the vault
so neither is orphaned in the shared RG.

This connectivity logic runs **only when public access is Disabled** (PBMM). In
dev, where the genapp vaults run with
`AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS=Enabled` and the
`SecurityControl=Ignore` exemption tag, no private endpoint or wait is created
and secret writes go over the public data plane. The required env vars
(`AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID`, optional
`AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID`) are surfaced to the API container by
Terraform from `genapp_keyvault_private_endpoint_subnet_id` /
`genapp_keyvault_private_dns_zone_id` (both default to the core Key Vault's PE
subnet and DNS zone). Because the API's managed identity creates these private
endpoints at runtime, Terraform grants it **Network Contributor** on that PE
subnet (`azurerm_role_assignment.api_genapp_kv_pe_subnet_network_contributor`,
created only when `genapp_keyvault_public_network_access = Disabled` and a PE
subnet is set). This is in addition to the subscription-scope Contributor the
identity already holds, so no manual grant is required.

### 1.6 GenApp Deploy Workflow in PBMM

The "Create Service" (gen-app deploy) workflow has the same PBMM constraints as
the main deploy. The backend GitHub App dispatches
`.github/workflows/genapp-deploy.yml`, which builds and pushes to the private
ACR and reads/writes the private tfstate storage account. In PBMM both of its
jobs (`build-and-push`, `deploy-infra`) must therefore:

- Run on the **self-hosted runner** (`runs-on: [self-hosted, linux, pbmm]`) so
  they can reach the private ACR and tfstate over private endpoints — the
  GitHub-hosted `ubuntu-latest` pool cannot, and fails with
  `connectivity_forbidden_error` (ACR) or a tfstate auth error.
- Pin to the **`pbmm-internal`** GitHub Environment (not a derived `pbmm-dev`
  name) so the OIDC login targets the correct workload subscription —
  otherwise Terraform looks for the gen-app Key Vault in the wrong subscription
  and fails with "Key Vault not found".

Like the main PBMM workflow, it must **not** toggle public network access on the
tfstate/storage accounts; the in-VNet runner reaches them privately.

---

## 2. Private DNS Zone Linking (Most Common PBMM Failure)

This is the **single most common class of PBMM runtime failure** and it has
recurred for multiple services.

### 2.1 Why It Happens

The API container reaches several Azure services over the **data plane** from
inside the VNet, and every one of them has public network access **Disabled**
(reachable only over a private endpoint).

The container app environment runs in the **workload spoke VNet** which has **no
custom DNS server** (`dnsServers: null`) — so it uses Azure-provided DNS. Azure
DNS only returns a service's **private** IP when that service's `privatelink.*`
zone is **linked to the spoke VNet**. If a zone is linked only to the **hub**
VNet, the spoke resolves the FQDN to its **public** IP, which the service
firewall drops — surfacing as a connection-level **`fetch failed`** (not a 404,
timeout, or app error).

> **The landing zone links some zones to the spoke but not all.** In this
> deployment, `postgres` and `azurecontainerapps.io` were spoke-linked from the
> start (so the DB and inter-container traffic worked), but `vaultcore` and
> `blob` were linked **only to the hub** and had to be added. Treat the full set
> below as a checklist.

### 2.2 Zone Checklist

| Zone | Workload Use | Symptom if NOT Spoke-Linked |
| --- | --- | --- |
| `privatelink.postgres.database.azure.com` | App + gen-apps PostgreSQL | DB connections fail |
| `privatelink.<region>.azurecontainerapps.io` | Container Apps env / inter-app | App Gateway backends unreachable |
| `privatelink.vaultcore.azure.net` | Central vault `kv-pronghorn-*` + per-app `kv-ga-*` | DB provisioning returns `"Database created but storing its credentials failed: fetch failed"`; Key Vault reads/writes fail |
| `privatelink.blob.core.windows.net` | Repo blob storage (`AZURE_STORAGE_ACCOUNT_NAME`) — committed-file reads during a **redeploy** | "Create Service" **redeploy** fails at the pre-push step with `pre-push-failed: fetch failed`, and the deploy workflow **never dispatches** |
| `privatelink.azurecr.io` | Private ACR pulls/builds | Image pull/build forbidden |
| `privatelink.openai.azure.com` / `privatelink.cognitiveservices.azure.com` | AI Foundry models (if called directly rather than via APIM) | AI calls fail with `fetch failed` |

### 2.3 Confirm and Fix

```powershell
$dnsRg = "private-dns-rg"
$spoke = "/subscriptions/<sub>/resourceGroups/networking/providers/Microsoft.Network/virtualNetworks/vnet"

# For each zone the workload uses, confirm whether the SPOKE is among the links
# (if you see only the hub VNet, the spoke link is missing):
foreach ($zone in @(
  "privatelink.vaultcore.azure.net",
  "privatelink.blob.core.windows.net"
)) {
  Write-Output "=== $zone ==="
  az network private-dns link vnet list -g $dnsRg -z $zone `
    --query "[].{link:name, vnet:virtualNetwork.id}" -o table
}

# Link a missing zone to the workload spoke (additive, reversible).
# Example — Key Vault:
az network private-dns link vnet create -g $dnsRg -z "privatelink.vaultcore.azure.net" `
  -n vaultcore-to-spoke-vnet --virtual-network $spoke --registration-enabled false

# Example — repo blob storage (fixes the "Create Service" redeploy pre-push failure):
az network private-dns link vnet create -g $dnsRg -z "privatelink.blob.core.windows.net" `
  -n blob-to-spoke-vnet --virtual-network $spoke --registration-enabled false
```

### 2.4 Platform Team Responsibility

This is a **landing-zone DNS prerequisite**, not an app-Terraform resource:
`private-dns-rg` is owned at the platform/management-group level, so the
workload deploy identity does not (and in locked-down environments cannot)
create links there — and the links are **not** captured by the app's Terraform,
so they will **not** survive a spoke-VNet rebuild.

The durable fix is for the **platform team** to add the spoke-VNet links for
**every** zone in the table above to **their** landing-zone IaC, so each spoke
gets them by default. One `vaultcore` link covers the central vault and all
per-app `kv-ga-*` vaults.

---

## 3. APIM Drift Diagnostics

The **API container** calls the internal APIM gateway
(`https://apim-pronghorn-<suffix>.azure-api.net/openai/...`) to reach the AI
models. Inside the VNet that public hostname only resolves via the
**`azure-api.net` private DNS zone** (RG `private-dns-rg`), which APIM's
private deployment populates with an A-record → APIM's private IP.

### 3.1 Symptom

AI features fail silently — the orchestrator returns quickly with `fetch failed`
(a ~15–30 ms connection-level error, *not* a timeout) because the hostname
resolves to nothing (or a stale, destroyed instance). No deploy step errors, so
it only surfaces when the AI path is exercised.

### 3.2 Cause

The random suffix (`<suffix>`, e.g. two distinct values across recreates) only changes on a **full APIM
teardown + recreate** (`terraform destroy`/recreate, RG deletion). Normal
applies, app redeploys, and container revisions keep the same name and private
IP, so this rarely drifts — but when it does, the A-record is left pointing at
an older instance.

### 3.3 Fix

```powershell
$zone = "azure-api.net"; $dnsRg = "private-dns-rg"
$apimName = "apim-pronghorn-<suffix>"; $apimIp = "<apim-private-ip>"   # from discovery commands

# Inspect current records (should be exactly one, → current APIM private IP)
az network private-dns record-set a list -g $dnsRg -z $zone `
  --query "[].{name:name, ips:aRecords[].ipv4Address}" -o json

# Repoint to the current APIM, then remove any stale instance record
az network private-dns record-set a add-record -g $dnsRg -z $zone -n $apimName -a $apimIp
az network private-dns record-set a delete   -g $dnsRg -z $zone -n "<oldApimName>" --yes
```

> The durable alternative is to (re)attach APIM's private-endpoint `azure-api.net`
> DNS zone group (or manage this A-record in Terraform) so the record is kept
> current automatically on every APIM recreate — preferred if the platform team
> allows it.

---

## 4. Container Apps Environment Recreate → 502 / "CORS error" (PBMM)

> **Environment:** Observed in a live **PBMM** landing zone (subscription
> `goa-cc-pronghorn_dev-rg`, hub-spoke with Azure Firewall DNS proxy). This is the
> most disruptive drift case because **one** tfvars change can recreate **both**
> the Container Apps environment **and** APIM, leaving the entire out-of-band
> ingress path (internal Application Gateway + private DNS) pointing at dead
> resources.

### 4.1 Symptom

- The browser shows **"CORS error"** on every `/api` call (e.g. `select`,
  `create-project`), and the **preflight `OPTIONS` returns `502`**. The CORS
  message is a red herring — a `502` returns no CORS headers, so the browser
  reports it as a CORS failure. The real fault is the gateway can't reach the
  backend.
- `az network application-gateway show-backend-health` shows the ACA pools
  `Unhealthy` (then `Unknown` after a partial fix), while the containers
  themselves are healthy.

### 4.2 Cause

A `params/<branch>.tfvars` change that **renames or otherwise forces replacement
of the Container Apps Environment** (for example the ACA env-name
underscore→hyphen fix) triggers a **destroy + recreate** of the environment.
A Container Apps environment's domain segment and static IP are **randomly
regenerated** on recreate:

| Resource | Old (stale) | New (current) |
| --- | --- | --- |
| Env default domain | `<old-env-suffix>…` | `<env-suffix>…` |
| Env static IP | `10.x.y.z` (old) | `10.x.y.z` (new) |
| APIM (also recreated) | `apim-pronghorn-<old-suffix>` | `apim-pronghorn-<suffix>` (`<apim-private-ip>`) |

The internal **Application Gateway** (`pronghorn-agw-internal`, RG `networking`)
and the **container-apps private DNS zone** (RG `private-dns-rg`) are **not
managed by `platform-deploy` Terraform** (the `infra/modules/agw/` module exists
in the repo but is **not wired into** `infra/main.tf`). So nothing reconciles
them to the new environment, and every backend goes dark.

### 4.3 Fix (manual reconcile — shared infra, needs platform-team approval)

All discovery/values below come from these commands (run from a machine with ARM
access; the management plane is reachable even though the data planes are
VNet-locked):

```powershell
# Current env domain + static IP (the NEW values to reconcile to)
az containerapp env list -g goa-cc-pronghorn_dev-rg `
  --query "[].{name:name, defaultDomain:properties.defaultDomain, staticIp:properties.staticIp}" -o table

# Current APIM gateway hostname + private IP
az apim show -n <apimName> -g goa-cc-pronghorn_dev-rg `
  --query "{gatewayUrl:gatewayUrl, host:hostnameConfigurations[0].hostName}" -o json

# What the AGW currently points at (the STALE values)
az network application-gateway show-backend-health -n pronghorn-agw-internal -g networking `
  --query "backendAddressPools[].backendHttpSettingsCollection[].servers[].{address:address, health:health}" -o table
```

Reconcile in this order. Replace `<env-suffix>` / `10.x.y.z` /
`apim-pronghorn-<suffix>` with the **current** values from discovery.

**Step 1 — Create the new private DNS zone + wildcard A-record** (RG
`private-dns-rg`):

```powershell
$zone = "<env-suffix>.canadacentral.azurecontainerapps.io"
az network private-dns zone create -g private-dns-rg -n $zone
az network private-dns record-set a add-record -g private-dns-rg -z $zone -n "*" --ipv4-address "10.x.y.z"
```

**Step 2 — Link the zone to BOTH the spoke VNet and the hub VNet.** This is the
PBMM-specific gotcha: the spoke VNet's DNS is the **hub Azure Firewall DNS proxy**
(e.g. `10.x.y.z`), so resolution only works when the zone is linked to the
**hub** VNet as well. A spoke-only link leaves the AGW reporting
`Unknown / could not be resolved`.

```powershell
$spoke = "/subscriptions/<sub>/resourceGroups/networking/providers/Microsoft.Network/virtualNetworks/vnet"
$hub   = "/subscriptions/<sub>/resourceGroups/pubsec-hub-networking/providers/Microsoft.Network/virtualNetworks/hub-vnet"
az network private-dns link vnet create -g private-dns-rg -z $zone -n "whitebay-to-spoke" --virtual-network $spoke --registration-enabled false
az network private-dns link vnet create -g private-dns-rg -z $zone -n "whitebay-to-hub"   --virtual-network $hub   --registration-enabled false
```

> Confirm the pattern against a known-good central zone first — e.g.
> `privatelink.canadacentral.azurecontainerapps.io` is linked to **both**
> `hub-vnet` and the spoke `vnet`. Match it exactly.

**Step 3 — Repoint the AGW backend pools** (RG `networking`):

```powershell
az network application-gateway address-pool update --gateway-name pronghorn-agw-internal -g networking `
  -n aca-backend-pool  --servers "ca-pronghorn-api.<env-suffix>.canadacentral.azurecontainerapps.io"
az network application-gateway address-pool update --gateway-name pronghorn-agw-internal -g networking `
  -n aca-frontend-pool --servers "ca-pronghorn-frontend.<env-suffix>.canadacentral.azurecontainerapps.io"
```

**Step 4 — Fix the Host/SNI header on the HTTP settings AND the probe host.**
Container Apps ingress routes by **Host header**, so a stale host = `Unhealthy`
even once DNS resolves:

```powershell
az network application-gateway http-settings update --gateway-name pronghorn-agw-internal -g networking `
  -n aca-api-https      --host-name "ca-pronghorn-api.<env-suffix>.canadacentral.azurecontainerapps.io"
az network application-gateway http-settings update --gateway-name pronghorn-agw-internal -g networking `
  -n aca-frontend-https --host-name "ca-pronghorn-frontend.<env-suffix>.canadacentral.azurecontainerapps.io"
az network application-gateway probe update --gateway-name pronghorn-agw-internal -g networking `
  -n pronghorn-api --host "ca-pronghorn-api.<env-suffix>.canadacentral.azurecontainerapps.io"
```

**Step 5 — If APIM was also recreated, fix its host header + probe** (the AGW
default pool routes `/api` through APIM):

```powershell
az network application-gateway http-settings update --gateway-name pronghorn-agw-internal -g networking `
  -n apim-https --host-name "apim-pronghorn-<suffix>.azure-api.net"
az network application-gateway probe update --gateway-name pronghorn-agw-internal -g networking `
  -n apim-health-probe --host "apim-pronghorn-<suffix>.azure-api.net"
```

> Also fix the stale `azure-api.net` A-record for APIM itself — see §3.3.

**Step 6 — Verify.** DNS propagation to the firewall proxy can lag; AGW caches
backend DNS and only re-resolves on a config write, so if a pool was updated
*before* the hub link propagated, re-apply the pool update once to nudge it:

```powershell
az network application-gateway show-backend-health -n pronghorn-agw-internal -g networking `
  --query "backendAddressPools[].backendHttpSettingsCollection[].servers[].{address:address, health:health}" -o table
```

All three backends (API, frontend, APIM `<apim-private-ip>`) should read **`Healthy`**.
Hard-refresh the site to clear the cached failed preflight.

### 4.4 Durable Prevention

Pick one so this stops recurring on every env/APIM recreate:

- **Don't rename/replace the CAE or APIM** — treat their names as immutable once
  deployed. The tfvars rename is what forced the recreate here.
- **Assign a stable custom domain** to the apps and point AGW + DNS at it (see
  [Custom Domain Setup](custom-domain-setup.md)), so the random env segment never
  reaches the gateway.
- **Bring the AGW + container-apps private DNS into Terraform** (wire in the
  dormant `infra/modules/agw/` module) so they auto-reconcile on any env change.

---

## 5. Quick Symptom → Cause Reference

| Symptom | Likely Cause | Section |
| --- | --- | --- |
| `fetch failed` (fast, connection-level) from API container | Private DNS zone not linked to spoke VNet | §2 |
| `connectivity_forbidden_error` on ACR | `privatelink.azurecr.io` zone missing spoke link, or runner outside VNet | §2.2 |
| `pre-push-failed: fetch failed` on "Create Service" redeploy | `privatelink.blob.core.windows.net` zone not spoke-linked | §2.2 |
| `Database created but storing its credentials failed: fetch failed` | `privatelink.vaultcore.azure.net` zone not spoke-linked | §2.2 |
| AI features return `fetch failed` (~15-30 ms) | Stale APIM `azure-api.net` A-record | §3 |
| Browser **"CORS error"** + preflight `OPTIONS` returns **502** | Container Apps env recreated; AGW/DNS point at dead env | §4 |
| App Gateway backend pool `Unknown / cannot resolve` | New env DNS zone missing, or not linked to **hub** VNet (firewall DNS proxy) | §4.3 |
| App Gateway backend `Unhealthy` | Host header / SNI mismatch after env recreate | §4.3 |
| `AADSTS700213` on OIDC login | Federated credential `subject` doesn't match workflow environment name | [PBMM Guide §4.2](../PBMM_DEPLOYMENT.md#42-add-a-federated-credential-scoped-to-the-github-environment) |
| `RequestDisallowedByPolicy` on RG creation | Missing one of the six policy-required tags | [PBMM Guide §2.4](../PBMM_DEPLOYMENT.md#24-policy-required-tags-deny-enforced) |

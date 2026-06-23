# Exposing Pronghorn on a Public Custom Domain

> **Parent guide:** [PBMM Deployment Guide](../PBMM_DEPLOYMENT.md)
>
> **Prerequisites:** A working PBMM deployment with Container Apps and APIM
> provisioned. The procedures below assume internal-only FQDNs are already
> reachable from inside the VNet.
>
> **When to use this runbook:** After the initial PBMM deployment (or after
> recreating the Container Apps environment / APIM instance), when you need to
> make the application accessible from a public browser on a custom domain.

---

## Traffic Flow

By default the frontend and API are reachable only on the internal
`*.azurecontainerapps.io` / `*.azure-api.net` FQDNs inside the VNet. To make the
app usable from a public browser on a custom domain (e.g. `pronghorn.blue`), the
traffic flows through a two-tier App Gateway pattern:

```
Browser ──► Public App Gateway (WAF_v2, public-access RG)
                 ├─ listener  app.<domain>  ──► internal App Gateway ──► frontend Container App
                 └─ listener  api.<domain>  ──► internal App Gateway ──► (path-based)
                                                       ├─ /ws*  ──► API Container App (WebSocket)
                                                       └─ /*    ──► internal APIM ──► API Container App
```

> **Why both hostnames are required.** The frontend makes **direct browser
> `fetch()` calls** to `VITE_API_BASE_URL` (it is not a server-side proxy), so the
> API base URL must be a publicly reachable host. Pointing it at the internal APIM
> gateway URL will cause every API call to fail from a public browser.

---

## 1. Terraform Configuration

Set the two override variables in your environment tfvars (see
`infra/params/pbmm.tfvars`):

```hcl
# Public custom domain fronting the frontend. Bakes the domain into the frontend
# build as VITE_AZURE_REDIRECT_URI (MSAL redirect), registers it as the Entra App
# Registration redirect URI, and adds it to the API CORS allow-list.
frontend_app_url_override = "https://app.<your-domain>"

# Public custom domain fronting the API. Sets VITE_API_BASE_URL and derives
# VITE_WS_URL (wss://api.<your-domain>) for the WebSocket path. Required because
# the browser calls the API directly.
api_base_url_override = "https://api.<your-domain>"
```

These feed `infra/locals.tf` (`frontend_build_environment_variables`), which wires
them through `coalesce()` so they fall back to the internal URLs when left unset:

| Build variable | Source when override set | Fallback (override null) |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `api_base_url_override` | internal APIM gateway URL |
| `VITE_WS_URL` | `wss://` form of `api_base_url_override` | Container Apps app URL |
| `VITE_AZURE_REDIRECT_URI` | `frontend_app_url_override` | frontend Container App URL |

> ⚠️ These are **build-time** values baked into the frontend image, so a
> **redeploy is required** for changes to take effect.

---

## 2. App Gateway / DNS Plumbing

The public + internal App Gateways and the custom-domain listeners/certs are
platform (landing-zone) resources, not created by this Terraform. Confirm:

1. **Public App Gateway** has listeners + SSL certs for both the frontend host
   and the API host (`api.<domain>`), with backend pools pointing at the
   **internal** App Gateway's private IP. The frontend may be served from the
   apex (`<domain>`) or a subdomain (`app.<domain>`) — match whatever the public
   listener / certificate uses and set `frontend_app_url_override` to the same.
2. **Internal App Gateway** routes:
   - frontend listener → frontend Container App backend pool
   - API listener → path-based map: `/ws*` → API Container App, default → APIM
3. **Backend pool IPs, HTTP-setting host headers, and probe hosts** match the
   **current** Container Apps environment and APIM instance.

### 2.1 Reference Topology

```
Browser ──► Public App Gateway  foxtenant1-appgw   (RG pubsec-public-access-zone, WAF_v2, public IP)
   pronghorn.blue      listener pronghorn-all  ─► pool frontend.pronghorn.internal ─► 10.x.y.z  (Host: frontend.pronghorn.internal)
   api.pronghorn.blue  listener pronghorn-api  ─► pool api.pronghorn.internal      ─► 10.x.y.z  (Host: api.pronghorn.internal)
                                                                                       │
                                              ┌────────────────────────────────────────┘
                                              ▼
            Internal App Gateway  pronghorn-agw-internal  (RG networking, Standard_v2, private IP 10.x.y.z)
   listener pronghorn      (frontend.pronghorn.internal) ─► pool aca-frontend-pool ─► ca-pronghorn-frontend.<env>.privatelink.canadacentral.azurecontainerapps.io
   listener pronghorn-api  (api.pronghorn.internal)      ─► urlPathMap pronghorn-api
                                                              ├─ /ws*  ─► pool aca-backend-pool ─► ca-pronghorn-api.<env>.privatelink...azurecontainerapps.io
                                                              └─ /*    ─► pool apim-backend-pool ─► 10.x.y.z (APIM private IP)  ─► APIM ─► API container
```

Where `<env>` is the Container Apps environment's generated default-domain
segment (e.g. `<env-suffix>`) and the APIM host is
`apim-pronghorn-<suffix>.azure-api.net`. The values that drift when the
environment or APIM is recreated are the `<env>` segment, the PE NIC IP, and the
APIM suffix/IP.

### 2.2 Discover the Current Target Values

Run these to capture the live FQDNs / IPs you will wire into the gateways
(replace resource-group / resource names with the customer's):

```powershell
# Container Apps environment default domain + private-endpoint NIC IP
az containerapp env show -n <cae-name> -g <app-rg> `
  --query "{defaultDomain:properties.defaultDomain, staticIp:properties.staticIp}" -o json
az network private-endpoint show -n <cae-pe-name> -g <app-rg> `
  --query "customDnsConfigs[].ipAddresses" -o json   # → the env PE IP (e.g. 10.x.y.z)

# Container App ingress FQDNs (public form, used as Host headers)
az containerapp show -n ca-pronghorn-frontend -g <app-rg> --query "properties.configuration.ingress.fqdn" -o tsv
az containerapp show -n ca-pronghorn-api      -g <app-rg> --query "properties.configuration.ingress.fqdn" -o tsv

# APIM private IP + gateway hostname
az apim show -n <apim-name> -g <apim-rg> `
  --query "{privateIp:privateIpAddresses[0], gateway:gatewayUrl, vnetType:virtualNetworkType}" -o json
```

### 2.3 Private DNS Records (Container Apps Zone)

The internal App Gateway resolves the Container App `privatelink` FQDNs via the
private DNS zone `privatelink.<region>.azurecontainerapps.io` (RG holding the
landing-zone private DNS, e.g. `private-dns-rg`). There must be exactly two
A-records for the **current** environment, both → the env PE NIC IP:

```powershell
$zone = "privatelink.canadacentral.azurecontainerapps.io"
# Inspect existing records
az network private-dns record-set a list -g <dns-rg> -z $zone `
  --query "[].{name:name, ips:aRecords[].ipv4Address}" -o json

# Create / repoint for the current env (<env> = <env-suffix>, <peip> = 10.x.y.z)
az network private-dns record-set a add-record -g <dns-rg> -z $zone -n "<env>"   -a <peip>
az network private-dns record-set a add-record -g <dns-rg> -z $zone -n "*.<env>" -a <peip>

# Remove stale records left over from a previous environment (<oldenv>)
az network private-dns record-set a delete -g <dns-rg> -z $zone -n "<oldenv>"   --yes
az network private-dns record-set a delete -g <dns-rg> -z $zone -n "*.<oldenv>" --yes
```

> The durable alternative is to (re)attach the environment private endpoint's
> `default` DNS zone group so landing-zone Azure Policy keeps these A-records
> current automatically — preferred if the platform team allows it.

### 2.4 Internal App Gateway Backend Pools / Settings / Probes

Repoint the three pools, their Host headers, and the probe hosts to the current
env and APIM. The Container App pools use the **privatelink** FQDN as the
*address*, but the HTTP-setting Host header and probe host use the **public**
ingress FQDN (no `privatelink`), because Container Apps route by Host header:

```powershell
$agw = "pronghorn-agw-internal"; $rg = "networking"
$env = "<env-suffix>"          # current env default-domain segment
$apim = "apim-pronghorn-<suffix>.azure-api.net"; $apimIp = "<apim-private-ip>"

# Frontend pool + Host header
az network application-gateway address-pool update --gateway-name $agw -g $rg -n aca-frontend-pool `
  --servers "ca-pronghorn-frontend.$env.privatelink.canadacentral.azurecontainerapps.io"
az network application-gateway http-settings update --gateway-name $agw -g $rg -n aca-frontend-https `
  --host-name "ca-pronghorn-frontend.$env.canadacentral.azurecontainerapps.io"

# API (WebSocket) pool + Host header + probe
az network application-gateway address-pool update --gateway-name $agw -g $rg -n aca-backend-pool `
  --servers "ca-pronghorn-api.$env.privatelink.canadacentral.azurecontainerapps.io"
az network application-gateway http-settings update --gateway-name $agw -g $rg -n aca-api-https `
  --host-name "ca-pronghorn-api.$env.canadacentral.azurecontainerapps.io"
az network application-gateway probe update --gateway-name $agw -g $rg -n pronghorn-api `
  --host "ca-pronghorn-api.$env.canadacentral.azurecontainerapps.io"

# APIM pool + Host header + probe (drift when APIM is recreated)
az network application-gateway address-pool update --gateway-name $agw -g $rg -n apim-backend-pool --servers $apimIp
az network application-gateway http-settings update --gateway-name $agw -g $rg -n apim-https --host-name $apim
az network application-gateway probe update --gateway-name $agw -g $rg -n apim-health-probe --host $apim
```

### 2.5 Verify Backend Health (Both Gateways)

After ~30 s for probe propagation, confirm every pool is **Healthy (200)**:

```powershell
az network application-gateway show-backend-health -n pronghorn-agw-internal -g networking `
  --query "backendAddressPools[].{pool:backendAddressPool.id, servers:backendHttpSettingsCollection[].servers[].{address:address, health:health, log:healthProbeLog}}" -o json
az network application-gateway show-backend-health -n foxtenant1-appgw -g pubsec-public-access-zone `
  --query "backendAddressPools[].{pool:backendAddressPool.id, servers:backendHttpSettingsCollection[].servers[].{address:address, health:health, log:healthProbeLog}}" -o json
```

**Backend-health diagnostics:**

| Symptom | Cause | Fix |
| --- | --- | --- |
| Unknown / cannot resolve | Stale private DNS A-record (env domain changed) | §2.3 |
| Unhealthy / cannot connect | Host header / SNI mismatch | §2.4 |
| Certificate CN does not match | APIM Host header points at old instance | Update `apim-https` / `apim-health-probe` host (§2.4) |

### 2.6 Internal APIM Resolution for In-VNet Workloads (`azure-api.net` Zone)

Separate from the App Gateway path, the **API container itself** calls the
internal APIM gateway (`https://apim-pronghorn-<suffix>.azure-api.net/openai/...`)
to reach the AI models. Inside the VNet that public hostname only resolves via
the **`azure-api.net` private DNS zone** (RG `private-dns-rg`), which APIM's
private deployment populates with an A-record → APIM's private IP (`<apim-private-ip>`).

**Symptom of drift:** AI features fail silently — the orchestrator returns
quickly with `fetch failed` (a ~15–30 ms connection-level error, *not* a
timeout) because the hostname resolves to nothing (or a stale, destroyed
instance). No deploy step errors, so it only surfaces when the AI path is
exercised.

**Why it happens:** the random suffix (`<suffix>`, e.g. two distinct values across recreates) only changes on a
**full APIM teardown + recreate** (`terraform destroy`/recreate, RG deletion).
Normal applies, app redeploys, and container revisions keep the same name and
private IP, so this rarely drifts — but when it does, the A-record is left
pointing at an older instance.

```powershell
$zone = "azure-api.net"; $dnsRg = "private-dns-rg"
$apimName = "apim-pronghorn-<suffix>"; $apimIp = "<apim-private-ip>"   # from §2.2

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

## 3. Portal Steps (Manual, No Redeploy)

1. **Entra App Registration** → **Authentication** → **SPA** platform → add
   **two** redirect URIs (both required — see note below), **no trailing slash**:
   - `<frontend-domain>` — e.g. `https://pronghorn.blue` (redirect / logout flow)
   - `<frontend-domain>/auth-redirect.html` — e.g.
     `https://pronghorn.blue/auth-redirect.html` (the **popup** sign-in flow)

   > **Why both.** The app signs in via an MSAL **popup** whose redirect URI is
   > `window.location.origin + /auth-redirect.html`
   > (`app/frontend/src/lib/msalConfig.ts` → `popupRedirectUri`). Registering only
   > the bare origin causes sign-in to fail with
   > `AADSTS50011: The redirect URI 'https://<domain>/auth-redirect.html' ... does
   > not match`. Both must be registered as **SPA** (not Web) platform URIs.

   These can be set in the portal, or via Microsoft Graph (replicates exactly
   what was applied to app `17973aae-...` in this deployment):

   ```powershell
   $appId = "<entra-app-client-id>"
   $objId = az ad app show --id $appId --query "id" -o tsv
   $body  = @{ spa = @{ redirectUris = @(
     "https://pronghorn.blue",
     "https://pronghorn.blue/auth-redirect.html"
   ) } } | ConvertTo-Json -Depth 5
   $tmp = New-TemporaryFile; Set-Content -Path $tmp -Value $body -Encoding utf8
   az rest --method PATCH `
     --uri "https://graph.microsoft.com/v1.0/applications/$objId" `
     --headers "Content-Type=application/json" --body "@$tmp"
   Remove-Item $tmp -Force
   # Verify
   az ad app show --id $appId --query "spa.redirectUris" -o json
   ```

   > The inline `--body '{...}'` form fails on Windows PowerShell with
   > `Unable to read JSON request payload` due to quote mangling — write the JSON
   > to a temp file and pass `--body "@$tmp"` as shown.

   If the app registration is instead created by Terraform
   (`create_entra_app_registration = true`), include **both** URIs in its
   `redirect_uris` list so the `auth-redirect.html` popup URI is not lost on
   recreate.

2. **GitHub App** (used for repository operations and workflow dispatch) needs
   **no** callback / setup URL — it authenticates server-to-server with its
   private key. Nothing to configure here.

---

## 4. Apply and Verify

After the tfvars edits and portal updates, **redeploy** (push to the deployment
branch or run the workflow) so the frontend image is rebuilt with the
custom-domain `VITE_*` values. Then verify:

- `<frontend-domain>` loads and MSAL sign-in completes.
- API calls succeed (browser dev-tools → network requests hit
  `https://api.<your-domain>/api/v1/...` and return 200).
- WebSocket connects (`wss://api.<your-domain>/ws`).

---

## Re-Deploy Caution

Recreating the Container Apps environment regenerates its random domain segment
(e.g. `<old-env-suffix>` → `<env-suffix>`), which **orphans every
downstream reference**: the private DNS A-records, the internal App Gateway
backend pool addresses, HTTP-setting Host headers, and health-probe hosts all
point at the old environment. After any environment or APIM recreate, re-run
§2.2 → §2.5. Keying auth to the custom domain makes the **auth** flow immune to
env-domain regeneration.

> **Custom domain recommendation.** Assign a **custom domain** to the Container
> App, set `frontend_app_url_override` in tfvars to that domain, and register the
> auth redirect URIs against the custom domain **once** — this avoids re-doing
> auth wiring on every environment rebuild.

# User-Generated Application Deployment

> Part of the [Pronghorn Architecture Documentation](../README.md)

---

## Overview

Pronghorn generates and deploys user applications on demand. Each generated app receives its own isolated Azure resources — a resource group, managed identity, container app, and Key Vault — while sharing common platform infrastructure (ACR, workload Container Apps environment). This document covers the full lifecycle: creation, deployment, redeployment, and destruction.

For the high-level separation between platform and generated-app infrastructure, see [Infrastructure & Deployment](infrastructure.md).

---

## Architecture Separation

Pronghorn operates three distinct infrastructure tiers:

| Tier | Scope | Provisioning | Lifecycle |
|------|-------|-------------|-----------|
| **Platform** | API, Frontend, databases, APIM, AI Foundry, observability | `infra/main.tf` via Terraform | Static — one per environment |
| **Shared** | ACR, platform Key Vault, workload ACA environment, per-app Key Vaults | `infra/main.tf` + API runtime | Long-lived — reused across all apps |
| **User-Generated App** | Per-app resource group, UAMI, container app | `infra/generated-app-template/` via GitHub Actions | Dynamic — created/destroyed on demand |

> 📊 Diagram: [`diagrams/blueprint-platform-genapp-separation.drawio`](./diagrams/blueprint-platform-genapp-separation.drawio)

![Platform, Shared, and User-Generated App Infrastructure](./diagrams/blueprint-platform-genapp-separation.png)

---

## End-to-End Deployment Flow

A user-generated app deployment follows a multi-stage pipeline that spans the Pronghorn API backend and GitHub Actions:

```
User Action (UI)
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  Stage 1: Key Vault Bootstrap (Pronghorn API)       │
│  genappKeyVault.ts                                  │
│                                                     │
│  1. Derive vault name: kv-ga-{first 18 hex of UUID} │
│  2. Create/update vault via ARM PUT (idempotent)    │
│  3. Grant API identity Secrets Officer role         │
│  4. PBMM: Create private endpoint + wait for DNS   │
│  5. Write env vars + secrets to vault data plane    │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  Stage 2: Workflow Dispatch (Pronghorn API)         │
│                                                     │
│  GitHub Actions workflow_dispatch with inputs:      │
│  • app_id, app_name, resource_group                 │
│  • repo_url, branch, dockerfile_path                │
│  • environment (dev/uat/prod)                       │
│  • action (create/deploy/destroy)                   │
│  • key_vault_name, key_vault_resource_group         │
│  • port                                             │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  Stage 3: Build & Push (GitHub Actions Job 1)       │
│  genapp-deploy.yml → build-and-push                 │
│                                                     │
│  1. Generate GitHub App token for user repo access  │
│  2. Checkout user's application repo                │
│  3. Azure login via OIDC                            │
│  4. Discover ACR from platform resource group       │
│  5. Docker build + push to shared ACR               │
│     Image: {acr}/{sanitized-app-name}:{run_id}     │
│                                                     │
│  Skipped when action = destroy                      │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  Stage 4: Terraform Apply/Destroy (GH Actions Job 2│
│  genapp-deploy.yml → deploy-infra                   │
│                                                     │
│  1. Checkout pronghorn repo (Terraform source)      │
│  2. Terraform init with per-app state key           │
│     State: genapp/{app_id}.tfstate                  │
│  3. Discover shared infra (ACR, ACA env)            │
│  4. Inherit compliance tags from platform RG        │
│  5. Apply or destroy:                               │
│     • create/deploy → terraform apply               │
│     • destroy → terraform destroy + state cleanup   │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  Stage 5: Status Reporting                          │
│                                                     │
│  Backend poller monitors workflow run status        │
│  Broadcasts updates via WebSocket to UI             │
└─────────────────────────────────────────────────────┘
```

---

## Per-App Terraform Resources

The `infra/generated-app-template/` Terraform root module creates these resources for each deployment:

| Resource | Module | Purpose |
|----------|--------|---------|
| **Resource Group** | `modules/generated-app/resource-group` | Isolation boundary (`pronghorn-genapp-{name}-{env}`) |
| **Container App** | `modules/generated-app/container-app` | Runs the user's Docker image in the shared workload ACA environment |
| **User-Assigned Managed Identity** | (within container-app module) | Per-app identity with AcrPull role for image access |

### Shared Resources Consumed (Not Created)

| Resource | Source | How Discovered |
|----------|--------|---------------|
| **Azure Container Registry** | Platform `infra/main.tf` | `az acr list` against `PLATFORM_RESOURCE_GROUP` at deploy time |
| **Workload ACA Environment** | Platform `infra/main.tf` | `az containerapp env list` against `PLATFORM_RESOURCE_GROUP` |
| **Per-App Key Vault** | Created by Pronghorn API before Terraform runs | Passed via `key_vault_name` + `key_vault_resource_group` variables |
| **Terraform State Storage** | Platform storage account | Backend config from GitHub environment variables |
| **Compliance Tags** | Platform resource group | Inherited via `az group show` at deploy time |

### Terraform State Isolation

Each generated app maintains independent Terraform state:

```
State key: genapp/{app_id}.tfstate
Backend:   Azure Storage (shared tfstate account)
```

On `destroy`, the state blob is explicitly deleted after `terraform destroy` succeeds, freeing the storage and preventing orphaned state.

---

## Key Vault Bootstrap Model

The per-app Key Vault lifecycle is decoupled from Terraform to solve a sequencing constraint: user secrets must exist _before_ Terraform wires them into the container's `secretRef` configuration.

### Bootstrap Sequence

```
API creates vault (ARM PUT)
        │
        ├── Vault created in shared platform RG (NOT per-app RG)
        ├── RBAC: API identity → Key Vault Secrets Officer
        ├── PBMM: Private endpoint + DNS zone group
        │
        ▼
API writes secrets (KV data plane)
        │
        ├── env vars  → tagged as kind=env
        ├── user secrets → tagged as kind=secret
        ├── DB conn strings → tagged as kind=dbconn
        │
        ▼
Terraform reads vault (data source)
        │
        ├── Reads secret names + envName tags
        ├── Wires secretRef entries on Container App
        └── Grants container UAMI read access
```

### Why the Vault Lives in the Shared RG

The per-app Key Vault is placed in the **shared platform resource group** rather than the per-app resource group because:

1. **Lifecycle decoupling** — `terraform destroy` removes the per-app RG; the vault must survive until the API explicitly purges it
2. **Pre-Terraform creation** — The API creates the vault before the workflow dispatches Terraform, so it cannot live in a Terraform-managed RG
3. **Cleanup control** — The API purges the vault (including soft-delete purge) when the app is destroyed

### Vault Naming Convention

```
kv-ga-{first 18 hex chars of app UUID}
```

This produces a deterministic, globally unique name within Azure's 3–24 character vault name limit (exactly 24 characters).

### Secret Naming and Tagging

Each secret is stored with a derived name and metadata tags:

| Tag | Purpose |
|-----|---------|
| `envName` | Original environment variable name (for Terraform to reconstruct the container env mapping) |
| `kind` | Classification: `env` (plain env var), `secret` (sensitive), `dbconn` (database connection string) |

Secret name format: `{prefix}-{sanitized-env-name}-{hash}` where prefix is `env`, `sec`, or `dbc`.

---

## Environment Differences

### Dev (Online)

| Aspect | Behavior |
|--------|----------|
| **Key Vault network** | `publicNetworkAccess: Enabled`, `defaultAction: Allow` |
| **Policy exemption** | `SecurityControl=Ignore` tag applied (bypasses corporate deny-public-KV policy) |
| **Private endpoints** | Not created |
| **Runner** | Self-hosted runner in VNet (`[self-hosted, linux, pbmm]`) |

### PBMM (Private Endpoints)

| Aspect | Behavior |
|--------|----------|
| **Key Vault network** | `publicNetworkAccess: Disabled`, `defaultAction: Deny` |
| **Private endpoint** | Created per-vault (`{vault}-pe`), group `vault` |
| **DNS zone group** | Attached directly or via landing-zone Azure Policy (DeployIfNotExists) |
| **DNS settle time** | Configurable wait (default 15s) for A-record propagation before first secret write |
| **Runner** | Self-hosted runner in VNet — required for private endpoint access to ACR, KV, tfstate |

### DNS Wait Configuration (PBMM)

| Environment Variable | Default | Purpose |
|---------------------|---------|---------|
| `AZURE_GENAPP_KEYVAULT_DNS_WAIT_TIMEOUT_SECONDS` | 600 | Max wait for Policy-attached DNS zone group |
| `AZURE_GENAPP_KEYVAULT_DNS_WAIT_INTERVAL_SECONDS` | 10 | Poll interval |
| `AZURE_GENAPP_KEYVAULT_DNS_SETTLE_SECONDS` | 15 | Extra settle after zone group exists |

---

## Deployment Actions

### Create

First-time deployment of a new generated app:

1. API creates per-app Key Vault and seeds secrets
2. Workflow builds Docker image from user repo → pushes to shared ACR
3. Terraform creates: resource group → UAMI → container app (with KV secretRefs)
4. Outputs: FQDN, resource group name, container app name

### Deploy (Redeploy)

Updates an existing generated app:

1. API updates Key Vault secrets (additions, changes, removals)
2. Workflow builds new image → pushes to ACR with new tag (`{run_id}`)
3. Terraform applies: updates image reference + re-wires any changed KV secrets → new container revision
4. Single revision captures both image and env-var changes

### Destroy

Removes a generated app and all its resources:

1. Build job is skipped (no image needed)
2. Terraform destroys all per-app resources (RG, UAMI, container app)
3. Terraform state blob is explicitly deleted from storage
4. API purges the per-app Key Vault (delete + soft-delete purge to free the name)
5. API deletes the private endpoint (if PBMM)

---

## Concurrency and Safety

| Mechanism | Purpose |
|-----------|---------|
| **Concurrency group** | `genapp-{app_id}` — prevents parallel deployments of the same app |
| **cancel-in-progress: false** | Running deployments are not cancelled by new ones (queued instead) |
| **Idempotent vault creation** | `ensureGenappKeyVault` uses ARM PUT — safe to retry |
| **Deterministic role assignments** | UUID v5 from `{scope}:{principalId}:secrets-officer` — no duplicates |
| **Terraform state locking** | Azure Storage blob lease prevents concurrent applies |

---

## GitHub App Authentication

The deploy workflow needs cross-repo access to clone the user's application repository. The default `GITHUB_TOKEN` only has access to the pronghorn repo, so:

1. A **GitHub App** (`phb-user-app-deploy`) is installed on the user's org
2. The workflow mints a **scoped installation token** using `actions/create-github-app-token@v1`
3. The token is scoped to only the specific user repo being deployed
4. App ID is stored as a GitHub Environment variable; private key as a secret

---

## Required Environment Variables

### Pronghorn API (runtime)

| Variable | Required | Purpose |
|----------|----------|---------|
| `AZURE_SUBSCRIPTION_ID` | Yes | Azure subscription for ARM calls |
| `ENTRA_TENANT_ID` / `AZURE_TENANT_ID` | Yes | Entra tenant for vault creation |
| `AZURE_GENAPP_KEYVAULT_RESOURCE_GROUP` | No (fallback: `AZURE_DEPLOY_RESOURCE_GROUP`, then `Pronghorn-App`) | Shared RG for per-app vaults |
| `AZURE_API_PRINCIPAL_ID` | No (warning if unset) | API identity object ID for Secrets Officer grant |
| `AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS` | No (default: `Disabled`) | `Enabled` for dev, `Disabled` for PBMM |
| `AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID` | PBMM only | Subnet for per-vault private endpoints |
| `AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID` | No | Private DNS zone for vault endpoints |
| `AZURE_PLATFORM_KEYVAULT_URI` / `AZURE_PLATFORM_KEYVAULT_NAME` | Yes | Central vault for DB connection strings |

### GitHub Actions (workflow)

| Variable / Secret | Source | Purpose |
|-------------------|--------|---------|
| `AZURE_CLIENT_ID` | Secret/Var | OIDC federated credential |
| `AZURE_TENANT_ID` | Secret/Var | Azure tenant |
| `AZURE_SUBSCRIPTION_ID` | Secret/Var | Azure subscription |
| `PLATFORM_RESOURCE_GROUP` | Env Var | Platform RG for ACR/ACA discovery |
| `TFSTATE_RESOURCE_GROUP` | Var | Terraform state backend |
| `TFSTATE_STORAGE_ACCOUNT` | Var | Terraform state backend |
| `TFSTATE_CONTAINER` | Var | Terraform state backend |
| `GH_APP_ID` | Var | GitHub App for cross-repo access |
| `APP_PRIVATE_KEY` | Secret | GitHub App private key |

---

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| DNS propagation timeout (PBMM) | Increase `AZURE_GENAPP_KEYVAULT_DNS_WAIT_TIMEOUT_SECONDS`; verify private DNS zone is linked to the VNet |
| Secret write fails after vault creation (PBMM) | Private endpoint or DNS zone group not ready; increase `AZURE_GENAPP_KEYVAULT_DNS_SETTLE_SECONDS` |
| 404 on user repo checkout | Verify GitHub App is installed on the user's org and has access to the repo |
| ACR/ACA env not found | Verify `PLATFORM_RESOURCE_GROUP` env var is set and the platform infra has been provisioned |
| Terraform state conflict | Check concurrency group; ensure no manual runs are in progress |
| Vault name collision after destroy | Purge may still be in progress; wait for soft-delete retention (7 days) or check purge status |

---

## Related Documents

- [Infrastructure & Deployment](infrastructure.md) — high-level platform architecture and Terraform module inventory
- [CI/CD & Deployment Hub](cicd.md) — deployment path decision matrix and workflow inventory
- [PBMM Deployment Guide](../PBMM_DEPLOYMENT.md) — PBMM-specific deployment procedures
- [Online Deployment Guide](../ONLINE_DEPLOYMENT.md) — public-endpoint deployment

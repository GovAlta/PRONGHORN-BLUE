# Pronghorn Infrastructure

Terraform root module deploying the full Pronghorn platform to Azure.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Azure Front Door (optional)                                    │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│  API Management (Consumption tier)                              │
│  - JWT validation via Entra ID                                  │
│  - CORS, rate limiting                                          │
└────────────┬──────────────────────────────────┬─────────────────┘
             │                                  │
┌────────────▼────────────┐   ┌─────────────────▼─────────────────┐
│  Container App (API)    │   │  Container App (Frontend)         │
│  Express + TypeScript   │   │  React + Vite (nginx)             │
└────────────┬────────────┘   └───────────────────────────────────┘
             │
┌────────────▼────────────┐   ┌───────────────────────────────────┐
│  PostgreSQL Flexible    │   │  Azure AI Foundry                  │
│  Server                 │   │  (GPT-4.1, GPT-4.1-mini)          │
└─────────────────────────┘   └───────────────────────────────────┘
```

Supporting resources: Key Vault, Storage Account, Log Analytics + App Insights, ACR, Workload ACA Environment.

## File Layout

| File | Purpose |
|------|---------|
| `main.tf` | Root module orchestration — all resource/module calls |
| `variables.tf` | All input variables (grouped by service) |
| `locals.tf` | Naming, tags, secrets mapping, DNS zone resolution |
| `secrets.tf` | Seeds generated secrets into Key Vault and wires the write-only PostgreSQL admin passwords (never stored in tfstate) |
| `outputs.tf` | Root outputs (URLs, connection strings, resource IDs) |
| `terraform.tf` | Provider versions, backend config, aliased providers |

## Directories

| Path | Purpose |
|------|---------|
| `modules/` | Reusable child modules (one per Azure service) |
| `params/` | Environment config: `<env>.tfvars` (variables). tfstate backend identifiers come from GitHub Environment Variables (`TFSTATE_*`). |
| `config/` | Static config (AI model definitions, APIM policies, rollback sets) |
| `migrations/` | PostgreSQL schema migrations (applied via `run_migration.js`) |
| `scripts/` | Operational PowerShell/JS scripts (deploy, bootstrap, `Set-GeneratedSecret.ps1`) |
| `generated-app-template/` | Terraform template for per-generated-app infrastructure |

## Modules

| Module | Description |
|--------|-------------|
| `agw` | Application Gateway (L7 LB) |
| `ai-foundry` | Azure AI Services + model deployments |
| `api-management` | APIM instance + API definitions |
| `container-apps` | API container app (uses AVM `avm-res-app-containerapp`) |
| `container-registry` | ACR (Premium, private endpoint capable) |
| `entra-app-registration` | Entra ID SPA app registration |
| `frontdoor` | Azure Front Door + WAF |
| `frontend` | Frontend container app (uses AVM `avm-res-app-containerapp`) |
| `generated-app` | Per-generated-app infrastructure (Key Vault, database) |
| `keyvault` | Key Vault + secrets |
| `logging` | Log Analytics workspace + Application Insights |
| `postgresql` | PostgreSQL Flexible Server + firewall rules |
| `storage` | Storage account + blob containers |
| `workload-environment` | Tenant workload ACA environment |

## Providers

| Provider | Version | Purpose |
|----------|---------|---------|
| `azurerm` | ~> 4.0 | Azure Resource Manager |
| `azuread` | ~> 3.0 | Entra ID app registrations |
| `azapi` | ~> 2.4 | Azure REST API (AVM modules) |
| `random` | ~> 3.5 | Unique resource name suffixes |
| `time` | ~> 0.12 | DNS wait timers |
| `modtm` | ~> 0.3 | AVM telemetry |

An aliased `azurerm.central_dns` provider targets the hub subscription for PBMM Private DNS zone lookups.

## State Backend

Azure Storage blob backend, configured at `terraform init` from the branch's
**GitHub Environment Variables** (`TFSTATE_RESOURCE_GROUP`,
`TFSTATE_STORAGE_ACCOUNT`, `TFSTATE_CONTAINER`, `TFSTATE_KEY`). These are the
**non-secret** tfstate identifiers; `use_azuread_auth = true` is constant and
hardcoded in the workflow. The deploying identity needs **Storage Blob Data
Contributor** on the storage account. The workflow passes them as repeated
`-backend-config="key=value"` flags.

```bash
terraform init -reconfigure \
  -backend-config="resource_group_name=${TFSTATE_RESOURCE_GROUP}" \
  -backend-config="storage_account_name=${TFSTATE_STORAGE_ACCOUNT}" \
  -backend-config="container_name=${TFSTATE_CONTAINER}" \
  -backend-config="key=${TFSTATE_KEY}" \
  -backend-config="use_azuread_auth=true"
```

## Usage

```powershell
# Initialize (first time or backend change) — supply tfstate identifiers as
# -backend-config flags (the workflow sources these from GitHub env Variables):
terraform init `
  -backend-config="resource_group_name=<tfstate-rg>" `
  -backend-config="storage_account_name=<tfstate-sa>" `
  -backend-config="container_name=tfstate" `
  -backend-config="key=pronghorn-dev.tfstate" `
  -backend-config="use_azuread_auth=true"

# Plan
terraform plan -var-file="params/dev.tfvars"

# Apply
terraform apply -var-file="params/dev.tfvars"
```

> **Secrets are not passed on the command line.** The PostgreSQL admin passwords
> and JWT secret are generated and seeded into Key Vault by Terraform (see
> [Key Patterns](#key-patterns)). Only set `-var="administrator_password=..."`
> for a deliberate break-glass override.

## Environment Archetypes

| Archetype | Description |
|-----------|-------------|
| `online` | Public endpoints, no VNet injection, dev/test use |
| `corp` | PBMM Landing Zone — private endpoints, central DNS, VNet-injected services |

Set via `archetype = "online"` or `"corp"` in tfvars. Controls whether private endpoint and DNS zone configurations are activated.

## Key Patterns

- **AVM modules**: Container apps use Azure Verified Modules (`avm-res-app-containerapp` v0.9.0, `avm-res-app-managedenvironment` v0.4.0). Always pass explicit `location` to prevent ForceNew on redeploy.
- **DNS zone resolution**: 3-tier precedence (explicit tfvar → central DNS data source → null). See `locals.tf`.
- **Secrets**: Generated secrets (PostgreSQL admin passwords, JWT secret) are seeded into Key Vault by Terraform via `scripts/Set-GeneratedSecret.ps1` (create-if-absent, so values are stable across applies) and never persisted to tfstate. PostgreSQL consumes them through the write-only `administrator_password_wo` argument; Container Apps consume them as Key Vault secret references. GitHub App identity (app id, installation id, private key) is dummy-seeded into Key Vault and the real values are set out-of-band via `az keyvault secret set`.
- **Naming**: All resources use `<prefix>-<project>-<random_suffix>` pattern for global uniqueness.
- **Tags**: Common tags + PBMM tags (when non-empty) applied to all resources via `local.common_tags`.

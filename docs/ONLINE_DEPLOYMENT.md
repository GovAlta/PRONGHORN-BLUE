# Pronghorn Online Deployment Guide

This guide describes how to deploy Pronghorn into an Azure subscription using
the **Online** archetype — public endpoints, GitHub-hosted runners, and relaxed
networking. This is the simpler of the two deployment paths and is suitable for
**development, testing, and demo environments**.

For the hardened, private-endpoint deployment path used in Government of Canada
PBMM landing zones, see the [PBMM Deployment Guide](PBMM_DEPLOYMENT.md).

> **How this differs from PBMM**
>
> | Concern | Online (this guide) | PBMM |
> | --- | --- | --- |
> | Runner | GitHub-hosted `ubuntu-latest` | Self-hosted inside the VNet |
> | Archetype | `online` (public endpoints) | `corp` (VNet + private endpoints) |
> | Trigger | Push to `dev-internal` + manual | `workflow_dispatch` only |
> | Storage / Key Vault | Public access temporarily opened per run | Always private |
> | `SecurityControl=Ignore` tag | Applied to tfstate storage account | Skipped |
> | Image build | `docker build` + `docker push` | `az acr build` on private agent pool |
> | GitHub Environment | **Per-branch** (`dev`) holding deployment Variables | **Per-branch** (`dev`/`uat`/`prod`) holding deployment Variables |
> | tfvars | `params/dev.tfvars` | `params/pbmm.tfvars` |
>
> For a full comparison and shared-concepts overview, see the
> [Architecture Differences table in the PBMM guide](PBMM_DEPLOYMENT.md#1-architecture-differences-dev-vs-pbmm).

---

## 1. Prerequisites

- An **Azure subscription** with permissions to create resources (Contributor +
  User Access Administrator at the subscription or resource-group scope).
- A **GitHub repository** with Actions enabled containing the Pronghorn source
  code (see [PBMM Guide §0](PBMM_DEPLOYMENT.md#0-github-organization--repository)
  for org/repo setup — the same steps apply).
- **Azure CLI** installed locally for initial setup commands.

No VNet, subnets, or self-hosted runner are required for the Online path.

---

## 2. Configure OIDC (GitHub → Azure, Passwordless)

The workflow authenticates with `azure/login@v2` using OIDC federated
credentials — no client secrets.

### 2.1 Create an app registration for CI

```powershell
az ad app create --display-name "pronghorn-online-deployer"
$appId = az ad app show --id "<app>" --query appId -o tsv
az ad sp create --id $appId
```

### 2.2 Add a federated credential scoped to the deploy environment

Each deploy job declares `environment: <branch>`, so GitHub issues the OIDC token
with an **environment-scoped** subject. The federated credential must match that
environment (e.g. `dev`):

```powershell
az ad app federated-credential create --id $appId --parameters '{
  "name": "pronghorn-deploy-dev",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<org>/pronghorn:environment:dev",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

> The `subject` **must** be `repo:<org>/pronghorn:environment:<branch>` to match the
> job's `environment:` (which equals the branch name). A mismatch yields
> `AADSTS700213`. Add one credential per deploy environment you use, and delete
> any old `ref:refs/heads/<branch>`-scoped credential.

### 2.3 Assign RBAC

The deploying identity requires:

- **Contributor** on the target resource group (or subscription scope if
  Terraform creates the RG).
- **User Access Administrator** on the same scope — Terraform creates role
  assignments (e.g. granting Container Apps / managed identities access to Key
  Vault, ACR, storage), which requires
  `Microsoft.Authorization/roleAssignments/write`.
- **Storage Blob Data Contributor** on the tfstate storage account (state is
  accessed via `use_azuread_auth=true`).

```powershell
$appId = "<oidc-app-client-id>"
$sub   = "<subscription-id>"

az role assignment create --assignee $appId --role "Contributor" `
    --scope /subscriptions/$sub
az role assignment create --assignee $appId --role "User Access Administrator" `
    --scope /subscriptions/$sub
```

Verify:

```powershell
az role assignment list --assignee $appId --all `
    --query "[].{role:roleDefinitionName, scope:scope}" -o table
```

---

## 3. Entra ID App Registration (End-User Sign-In)

Pronghorn's frontend uses MSAL. Two options:

- **Terraform-managed** — set `create_entra_app_registration = true` (requires
  Graph permissions on the deploying SP). Terraform outputs `entra_app_client_id`.
- **Manual** (default in `dev.tfvars`) — create the app registration in the
  Entra portal, configure the SPA redirect URI to your frontend callback, then
  set:

  ```hcl
  create_entra_app_registration = false
  azure_client_id               = "<entra-app-client-id>"
  azure_tenant_id               = "<entra-tenant-id>"
  ```

---

## 4. Deployment configuration: GitHub Environment + committed files + Key Vault

Deployment inputs come from a **per-branch GitHub Environment** (non-secret
Variables), files committed to the repo, and Azure Key Vault:

- **Azure login identity** (`azure/login` + `ARM_*`) uses the `SUBSCRIPTION_ID`,
  `AZURE_CLIENT_ID`, and `AZURE_TENANT_ID` **environment Variables** set on the
  branch's GitHub Environment (the OIDC app from §2). The deploy job declares
  `environment: ${{ github.ref_name }}` to read them and to scope the OIDC token
  (§2.2).
- **Environment-specific Terraform inputs** (URL overrides; plus subnet/DNS
  inputs for the `corp`/PBMM archetype) come from the same environment's Variables
  and are injected as `TF_VAR_*`. They were removed from `params/<branch>.tfvars`
  so the committed `-var-file` cannot override them. See the
  [PBMM guide §6.0](PBMM_DEPLOYMENT.md#60-github-environment-variables-per-deploy-branch)
  for the full variable list.
- **tfstate backend** identifiers (`TFSTATE_RESOURCE_GROUP`,
  `TFSTATE_STORAGE_ACCOUNT`, `TFSTATE_CONTAINER`, `TFSTATE_KEY`) come from the
  branch's **GitHub Environment Variables** and are passed to `terraform init
  -backend-config`. See §6 for how the backing storage account is bootstrapped.
- **Generated secrets** (`postgres-password`, `postgres-genapps-password`,
  `jwt-secret`) are **created once and seeded into the platform Key Vault by
  Terraform** on first apply, then consumed via Key Vault references and
  write-only arguments. They never appear in tfvars, `-var` flags, GitHub, or
  Terraform state.
- **GitHub App identity** (`github-app-id`, `github-app-installation-id`,
  `github-app-private-key`) is **seeded as a placeholder by Terraform** and then
  set out-of-band in Key Vault (§5).

### 4.1 Set the tfstate backend variables

Set the remote-state identifiers as **GitHub Environment Variables** on the
branch's environment (non-secret resource names), using the storage identifiers
from §6:

```bash
gh variable set TFSTATE_RESOURCE_GROUP  --env dev --body "<tfstate-rg>"
gh variable set TFSTATE_STORAGE_ACCOUNT --env dev --body "<tfstate-storage-account>"
gh variable set TFSTATE_CONTAINER       --env dev --body "tfstate"
gh variable set TFSTATE_KEY             --env dev --body "pronghorn-dev.tfstate"
```

The workflow passes these to `terraform init -backend-config="key=value"` (plus a
constant `use_azuread_auth=true`).

---

## 5. GitHub App (Optional)

This is only required if your deployment uses **generated-app deployment**
(GitHub App), used server-side for repository operations and workflow dispatch.
If you are not deploying generated apps, skip this section.

The setup procedure is identical to the PBMM guide — see
[PBMM Guide §5.5](PBMM_DEPLOYMENT.md#55-github-app) for:

- GitHub App creation, permissions, and installation
- Reading the installation ID

Set `github_app_id` and `github_app_installation_id` **in the platform Key
Vault** (not in tfvars), along with the private key, via `az keyvault secret
set` after the first deploy. See
[PBMM Guide §6.2](PBMM_DEPLOYMENT.md#62-set-the-github-app-secrets-in-key-vault-two-phase)
for the secret names (`github-app-id`, `github-app-installation-id`,
`github-app-private-key`) and the two-phase procedure.

---

## 6. Bootstrap the Terraform State Backend

The tfstate storage account in Online mode uses **public access** (temporarily
opened during the bootstrap). The workflow runs:

```powershell
./infra/scripts/bootstrap-tfstate.ps1 `
    -SubscriptionId     "<subscription-id>" `
    -ResourceGroupName  "<tfstate-rg-name>" `
    -StorageAccountName "<tfstate-storage-name>" `
    -ContainerName      "tfstate" `
    -Location           "canadacentral" `
    -TfvarsPath         "infra/params/dev.tfvars"
```

In Online mode (without `-SkipSecurityControlTag`), the script:

1. Creates the resource group, storage account, and blob container if missing.
2. Tags the storage account with `SecurityControl=Ignore` to satisfy dev-only
   Azure Policy constraints.
3. Leaves public network access **enabled** (no private endpoint created).

The deploying identity needs **Storage Blob Data Contributor** on the tfstate
storage account (state uses `use_azuread_auth=true`).

---

## 7. Complete `params/dev.tfvars`

Open [infra/params/dev.tfvars](../infra/params/dev.tfvars) and replace placeholder
values. Key sections:

| Section | Key Variables | Notes |
| --- | --- | --- |
| Azure config | `subscription_id`, `resource_group_name`, `location` | Target subscription and RG |
| PostgreSQL | `postgresql_server_name`, `postgresql_sku_name` | Dev defaults use Burstable SKUs |
| Security | `enable_development_access = true` | Public access enabled for dev |
| Container Apps | `container_apps_subnet_id` | VNet subnet for CAE (even Online uses VNet injection) |
| APIM | `apim_sku = "Consumption_0"` | Dev uses Consumption tier |
| ACR | `acr_name`, `acr_sku = "Basic"` | Dev uses Basic SKU with public access |
| Entra ID | `azure_client_id`, `azure_tenant_id` | From §3 |
| GitHub App | _none in tfvars — set in Key Vault_ | From §5 (if applicable) |
| Tags | `client_organization`, `cost_center`, etc. | Policy-required tags |

Sensitive values (passwords, secrets) are **not** stored here — generated
secrets are seeded into the platform Key Vault by Terraform, and the GitHub App
identity is set out-of-band in Key Vault (see §4).

Validate locally:

```powershell
cd infra
terraform fmt -check
terraform validate
```

---

## 8. Run the Deployment

### Automatic deploy (push)

Push changes to the `dev`, `uat`, or `prod` branch. The `platform-deploy`
workflow triggers automatically on push; the target environment is driven by the
branch name (`params/<branch>.tfvars` + the branch's GitHub Environment
Variables).

### Manual deploy (workflow_dispatch)

**Actions → platform-deploy → Run workflow.**

Inputs:

| Input | Effect |
| --- | --- |
| `plan` | Terraform plan only — no apply/build/update |
| `skip_infra` | Skip core infrastructure stage |
| `skip_build` | Skip container image build and push |
| `skip_container_apps` | Skip Container Apps deploy |
| `deploy_ai_models` | Deploy AI model deployments afterward |
| `destroy` | **DESTRUCTIVE** — destroy infra before apply |
| `debug_logging` | Verbose Actions + Terraform logging |

Recommended first run: set **`plan = true`** to review the Terraform plan
before applying.

### Workflow stages

1. Parse deployment config from `params/dev.tfvars` + the `dev` GitHub
   Environment Variables (incl. `TFSTATE_*`)
2. OIDC login
3. Register `Microsoft.App` resource provider (if not already)
4. Bootstrap Terraform state backend
5. `terraform init` / `validate` / `plan` / `apply`
6. Build and push container images
7. Deploy Container Apps
8. Capture rollback snapshot artifact (`deployment-snapshot-dev`)

---

## 9. Post-Deployment Configuration

After the first successful deploy, complete these steps. They are a subset of
the PBMM post-deploy steps — no App Gateway wiring is needed.

### 9.1 Get the deployed frontend FQDN

```powershell
az containerapp show -n ca-pronghorn-frontend -g <resource-group> `
  --query "properties.configuration.ingress.fqdn" -o tsv
```

### 9.2 Entra SPA redirect URI — portal only, no redeploy

1. **Entra ID → App registrations → your app → Authentication.**
2. Under **Single-page application**, **Add URI**:
   `https://<frontend-fqdn>` (no trailing slash, no path).
3. Leave **Access tokens** / **ID tokens** (implicit/hybrid) **unchecked** — MSAL
   uses authorization-code-with-PKCE.
4. Save. Sign-in works immediately.

> A redirect-URI mismatch surfaces as **AADSTS50011**.

### 9.3 CORS — already handled

The API automatically adds the deployed frontend URL to its CORS allowlist. The
`allowed_origins = ["*"]` default in dev.tfvars is permissive. Update it with
specific domains only when tightening for a shared environment.

---

## 10. Architecture Differences Summary

For a detailed comparison of all architectural differences between Online and
PBMM, see the [Architecture Differences table in the PBMM guide](PBMM_DEPLOYMENT.md#1-architecture-differences-dev-vs-pbmm).

Key simplifications in the Online path:

- **No self-hosted runner** — GitHub-hosted `ubuntu-latest` can reach all
  resources over public endpoints.
- **No private endpoints** — storage, Key Vault, ACR, and PostgreSQL are
  publicly accessible (with firewall rules).
- **No VNet DNS complexity** — no private DNS zone linking required.
- **Consumption-tier APIM** — lower cost, no VNet injection.
- **Burstable PostgreSQL SKUs** — cost-optimized for dev/test.

# Pronghorn PBMM Landing Zone Deployment Guide

This guide describes everything required to deploy Pronghorn into a Government of
Canada **Protected B / Medium Integrity / Medium Availability (PBMM)** Azure
Landing Zone, and how to replicate that deployment into a **customer's** PBMM
environment.

It covers two audiences:

1. **Operators deploying Pronghorn** into a PBMM subscription (you).
2. **Customers** standing up Pronghorn in their own PBMM landing zone.

> **How this differs from the Online deployment path**
>
> Both paths use the same `platform-deploy.yml` workflow; the archetype and the
> branch the workflow runs from select the behavior below.
>
> | Concern | Online | PBMM |
> | --- | --- | --- |
> | Runner | GitHub-hosted `ubuntu-latest` | Self-hosted inside the VNet |
> | Archetype | `online` (public endpoints) | `corp` (VNet + private endpoints) |
> | Storage / Key Vault | Public access opened per run | **Always private** |
> | Image build | `docker build` + `docker push` | `az acr build` on private agent pool |
>
> For the Online deployment guide, see [Online Deployment Guide](ONLINE_DEPLOYMENT.md).

## Quick-Start Checklist

Complete these steps in order. Each links to the detailed section below.

1. [GitHub org & repo (§0)](#0-github-organization--repository)
2. [Platform inputs from connectivity team (§2)](#2-prerequisites--platform--connectivity-team)
3. [Provision self-hosted runner (§3)](#3-provision-the-self-hosted-build-runner)
4. [Configure OIDC (§4)](#4-configure-oidc-github--azure-passwordless)
5. [Entra ID app registration (§5)](#5-entra-id-app-registration-end-user-sign-in)
6. [GitHub App (§5.5)](#55-github-app)
7. [Deployment configuration: GitHub Environment + Key Vault (§6)](#6-deployment-configuration-committed-files--key-vault)
8. [Bootstrap Terraform state backend (§7)](#7-bootstrap-the-terraform-state-backend)
9. [Complete `params/pbmm.tfvars` (§8)](#8-complete-paramspbmmtfvars)
10. [Run the deployment (§9)](#9-run-the-deployment)
11. [Post-deploy auth wiring (§9.5)](#95-post-deployment-configuration-two-pass-auth-wiring)
12. [Re-running the deploy / redeploy methodology (§9.6)](#96-re-running-the-deploy-redeploy-methodology)
13. [Customer replication (§10)](#10-customer-replication-checklist) — if deploying to a customer's environment

---

## 0. GitHub Organization & Repository

The rest of this guide assumes a GitHub **organization** and a **`pronghorn`
repository** already exist. If you are standing up a brand-new environment,
create them first — every later reference to `<org>/pronghorn`,
`https://github.com/<org>/pronghorn`, and
`repo:<org>/pronghorn:environment:<branch>` depends on them.

### 0.1 Create (or identify) the organization

1. Use an existing org, or create one at
   **https://github.com/account/organizations/new**. Record the org login (the
   `<org>` slug used throughout this guide).
2. You must be an **org owner** to register GitHub Apps (§5.5),
   configure deployment inputs (§6), and approve the GitHub App installation (§5.5.2).

### 0.2 Bring the Pronghorn code into the org

Get the `pronghorn` repository into the org by whichever route fits your
licensing/source arrangement:

- **Fork / import** the upstream Pronghorn repo into the org, **or**
- Create an empty `pronghorn` repo and push the code:

  ```powershell
  # from a clone of the Pronghorn source
  git remote add origin https://github.com/<org>/pronghorn.git
  git push -u origin main
  ```

### 0.3 Enable Actions and create the deploy branch

1. **Repo → Settings → Actions → General** — ensure Actions are **enabled** (and
   allowed by org policy). The self-hosted runner (§3) and the
   `platform-deploy.yml` workflow will not run otherwise.
2. The PBMM workflow is `workflow_dispatch`-only. Make sure the branch you intend
   to deploy from (e.g. `dev`) exists, has a matching **GitHub Environment** of the
   same name holding the deployment Variables (§6.0), has a matching federated
   credential scoped to that environment (§4.2), and contains
   `.github/workflows/platform-deploy.yml`.
3. The self-hosted runner registers at the **repository** level
   (**Settings → Actions → Runners**), so the runner-registration token in §3.1
   comes from this repo.

---

## 1. Architecture Differences (Dev vs. PBMM)

| Concern | Online (`online` archetype) | PBMM (`corp` archetype) |
| --- | --- | --- |
| Runner | GitHub-hosted `ubuntu-latest` | **Self-hosted** `[self-hosted, linux, pbmm]` inside the VNet |
| Trigger | Push to `dev-internal` + manual | **`workflow_dispatch` only** (deliberate prod deploys) |
| Archetype | `online` (public) | `corp` (VNet injection + private endpoints) |
| tfvars | `params/dev.tfvars` | `params/pbmm.tfvars` |
| Storage / Key Vault network | Opened then re-locked each run | **Always private** (never opened) |
| `SecurityControl=Ignore` tag | Applied to tfstate SA | **Skipped** (`-SkipSecurityControlTag`) |
| Image build | `docker build` + `docker push` on the runner | **`az acr build`** on the private ACR agent pool |
| GitHub Environment | **Per-branch** (`dev`/`uat`/`prod`) holding deployment Variables | **Per-branch** (`dev`/`uat`/`prod`) holding deployment Variables |
| Environment / retention | `dev`, shorter retention | `prod`, 35-day backups, 90-day logs |

---

## 2. Prerequisites — Platform / Connectivity Team

PBMM landing zones are typically split across subscriptions managed by a central
platform team. Obtain the following **before** filling in `params/pbmm.tfvars`.
All of these map to `REPLACE:` placeholders in that file.

> ⚠️ **Pick the correct workload subscription.** PBMM landing zones usually expose
> at least two subscriptions — a **LZ Platform** subscription (shared platform /
> connectivity resources) and a **LZ Apps** subscription (application workloads).
> Pronghorn is deployed into the subscription that owns the **delegated workload
> subnets** you were given. Confirm with the platform team which one to use, and
> make sure `subscription_id`, `central_dns_subscription_id`, and **every subnet
> ID** in `params/pbmm.tfvars` point at that same subscription. Mixing IDs from
> two different subscriptions is a common, hard-to-diagnose failure. Verify your
> CLI is pointed at the right one before you start:
>
> ```powershell
> az account show --query "{name:name, id:id, tenant:tenantId}" -o table
> az account set --subscription "<workload-subscription-id>"
> ```

### 2.1 Networking (delegated subnets in the workload VNet)

| Purpose | tfvars key | Notes |
| --- | --- | --- |
| PostgreSQL (app) | `delegated_subnet_id` | Delegated to `Microsoft.DBforPostgreSQL/flexibleServers` |
| Container Apps Env | `container_apps_subnet_id` | Requires `/21` or larger |
| Container Apps PE | `aca_environment_private_endpoint_subnet_id` | Private endpoint subnet |
| Workload Container Apps | `workload_aca_subnet_id` | Tenant-deployed app containers |
| Workload Container Apps PE | `workload_aca_private_endpoint_subnet_id` | Private endpoint subnet |
| APIM | `apim_subnet_id` | Internal VNet mode (Premium SKU) |
| Private endpoints (shared) | `storage_private_endpoint_subnet_id`, `keyvault_private_endpoint_subnet_id`, `acr_private_endpoint_subnet_id`, `ai_foundry_private_endpoint_subnet_id` | May all be the same PE subnet |

> **No pre-provided subnets?** If the platform team has *not* carved out dedicated
> workload subnets and you have `Network Contributor` on the VNet's resource group,
> you can create them imperatively with
> [infra/scripts/New-PbmmSubnets.ps1](../infra/scripts/New-PbmmSubnets.ps1). It
> mirrors the existing deployment's networking pattern (shared `RouteTable` for
> hub force-tunnelling + approved NSGs + Container Apps / PostgreSQL delegations),
> is idempotent, and prints each new subnet ID mapped to its `pbmm.tfvars` key.
> Run with `-DryRun` first to preview. The `pubsec` governance policies do **not**
> deny subnet/NSG creation (only Classic resource types and certain VM/AKS/SQL SKUs).

### 2.2 Central Private DNS (vWAN hub / connectivity subscription)

Private DNS is handled one of two ways, selected by `delegate_private_dns_to_policy`:

**Mode A — Azure Policy delegation (default for PBMM/GoA).** Set
`delegate_private_dns_to_policy = true` and leave `central_dns_subscription_id` /
`central_dns_resource_group_name` **empty**. Terraform skips every central Private
DNS Zone lookup and passes empty zone IDs to all private endpoints. The landing
zone's `DeployIfNotExists` policy attaches the `default` zone group out-of-band,
and the private endpoints carry `lifecycle { ignore_changes = [private_dns_zone_group] }`
so re-applies don't strip the policy-added integration. **The deploying identity
needs no access to the central DNS subscription** in this mode.

**Mode B — Terraform-resolved central zones.** Set
`delegate_private_dns_to_policy = false` and supply the central DNS location, when
the deploying identity *can* read the central zones:

| Purpose | tfvars key |
| --- | --- |
| Connectivity subscription ID | `central_dns_subscription_id` |
| DNS resource group | `central_dns_resource_group_name` |

In both modes, `private_endpoint_dns_wait` and `dns_registration_wait_minutes`
give Terraform time for DNS registration to propagate before data-plane calls.

The policy assigns the deterministic zone-group name `default` to each private
endpoint. For the **core Key Vault**, Terraform waits for that attachment
natively: the keyvault module polls the
`Microsoft.Network/privateEndpoints/privateDnsZoneGroups` resource (via the
`azapi` provider's retry-on-404) and gates the data-plane secret writes on it,
so a first-deploy secret write never races ahead of private DNS registration.
Set `private_endpoint_dns_wait = { enabled = true, timeout = "10m", interval = "10s" }`
to turn this on (it is a no-op when `enabled = false`, the dev default).

### 2.3 RBAC the deploying identity needs

The OIDC service principal / managed identity (see §4) requires:

- **Contributor** on the target resource group (or subscription scope if the RG
  is created by Terraform).
- **User Access Administrator** on the same scope as Contributor. Terraform
  **creates role assignments** (e.g. granting Container Apps / managed identities
  access to Key Vault, ACR, storage), which requires
  `Microsoft.Authorization/roleAssignments/write`. Contributor alone **cannot**
  create role assignments and the deploy will fail partway through.
- **Storage Blob Data Contributor** on the **tfstate** storage account (state is
  accessed via `use_azuread_auth=true` — no storage keys).
- **Network Contributor** (or join permission) on the delegated subnets if
  Terraform creates VNet integrations / private endpoints in a shared VNet.
- **Private DNS Zone Contributor** on the central DNS zones *only if* Terraform
  manages DNS records directly (usually handled by policy instead).
- If `create_entra_app_registration = true`: **Application.ReadWrite.OwnedBy**
  (Microsoft Graph) — otherwise create the Entra app manually (§5) and leave it
  `false`.

> ⚠️ **Who can grant these roles?** Assigning roles to the SP itself requires
> `Microsoft.Authorization/roleAssignments/write` on the target scope — i.e. the
> person doing the grant must be **Owner** or **User Access Administrator** on the
> subscription/RG. **Inherited Contributor is not enough.** If you only have
> Contributor (common when your access is inherited from a management group), you
> cannot self-assign these roles — hand the commands in §4.3 to a subscription
> **Owner / User Access Administrator** to run on your behalf.

### 2.4 Policy-required tags (Deny enforced)

The `pubsec` management group enforces a **Deny** policy
(`required-tags-on-resource-group`) that blocks creation of **any resource group**
that is missing the following **six** tags. This applies to *every* RG you create —
including the tfstate RG (§7) and the runner RG (§3) — not just Terraform-managed
resources. A missing tag yields `RequestDisallowedByPolicy`.

| Required tag (RG) | tfvars source key |
| --- | --- |
| `ClientOrganization` | `client_organization` |
| `CostCenter` | `cost_center` |
| `DataSensitivity` | `data_sensitivity` (already `Protected B`) |
| `ProjectContact` | `project_contact` |
| `ProjectName` | `project_name_tag` |
| `TechnicalContact` | `technical_contact` |

Fill every one of these placeholders in `params/pbmm.tfvars` (plus the `extra_tags`
map). Terraform applies them automatically to its resources via `local.common_tags`.
For **manually** created resource groups, you must pass the tags explicitly:

- `bootstrap-tfstate.ps1` reads the values from `pbmm.tfvars` and applies them for you.
- `New-PbmmRunner.ps1` accepts a `-Tags` hashtable (see §3.2).

---

## 3. Provision the Self-Hosted Build Runner

GitHub-hosted runners **cannot reach private endpoints**, so the workflow runs on
a self-hosted runner deployed **inside the PBMM VNet**. Use the provided script.

### 3.1 Get a runner registration token

In GitHub: **Settings → Actions → Runners → New self-hosted runner**, copy the
registration token (valid ~1 hour). Or via the API/`gh`:

```powershell
gh api -X POST repos/<org>/pronghorn/actions/runners/registration-token --jq .token
```

### 3.2 Run the provisioning script

```powershell
$tags = @{
    ClientOrganization = "<client-org>"
    CostCenter         = "<cost-center>"
    DataSensitivity    = "Protected B"
    ProjectContact     = "<project-contact>"
    ProjectName        = "<project-name>"
    TechnicalContact   = "<technical-contact>"
}

./infra/scripts/New-PbmmRunner.ps1 `
    -SubscriptionId      "<workload-subscription-id>" `
    -ResourceGroupName   "<runner-resource-group>" `
    -SubnetId            "/subscriptions/.../subnets/<runner-subnet>" `
    -GitHubRepoUrl       "https://github.com/<org>/pronghorn" `
    -RunnerToken         "<registration-token>" `
    -Tags                $tags
```

> ⚠️ **Pass `-Tags`.** The runner script creates its own resource group. Without
> the six policy-required tags (§2.4) that RG creation is **denied**
> (`RequestDisallowedByPolicy`). Reuse the same values you put in `pbmm.tfvars`.

The script provisions an **Ubuntu 22.04 VM with no public IP** and a
system-assigned managed identity, then (via cloud-init) installs Docker, Azure
CLI, Terraform, Node.js, PowerShell, and git, and registers a GitHub Actions
runner as a systemd service with labels `self-hosted,linux,pbmm`.

Defaults (override as needed): `-Location canadacentral`,
`-VmName pronghorn-pbmm-runner`, `-VmSize Standard_D4s_v3`,
`-RunnerLabels "self-hosted,linux,pbmm"`. The script is idempotent — re-running
skips an existing VM.

> **Egress check.** The runner must reach `github.com` over HTTPS to register.
> Confirm the chosen subnet has **no forced-tunnel route table** sending traffic
> to a firewall that blocks GitHub, and that its NSG permits outbound HTTPS
> (the default `AllowInternetOutBound` rule is sufficient if not overridden).

### 3.2.1 Verify the runner registered

The VM has **no public IP**, so verify from the VM itself via `az vm run-command`
(cloud-init takes ~5-10 min to install tooling and register):

```powershell
az vm run-command invoke -g "<runner-resource-group>" -n pronghorn-pbmm-runner `
    --command-id RunShellScript `
    --scripts "cloud-init status; systemctl is-active 'actions.runner.*'" `
    --query "value[0].message" -o tsv
```

Expect `status: done` and the runner service reporting `active`. The runner then
shows **Online** with labels `self-hosted, linux, pbmm` under
**Settings → Actions → Runners**, and workflows targeting
`runs-on: [self-hosted, linux, pbmm]` will dispatch to it.

### 3.3 Grant the runner (or OIDC identity) build access

`az acr build` is invoked from the runner. Whichever identity authenticates to
Azure (the OIDC SP from §4 is used by the workflow) needs **AcrPush** on the
container registry and **Contributor** on the agent pool's resource group.

---

## 4. Configure OIDC (GitHub → Azure, passwordless)

The workflow authenticates with `azure/login@v2` using OIDC federated
credentials — **no client secrets**.

### 4.1 Create an app registration / managed identity for CI

```powershell
az ad app create --display-name "pronghorn-pbmm-deployer"
$appId = az ad app show --id "<app>" --query appId -o tsv
az ad sp create --id $appId
```

### 4.2 Add a federated credential scoped to the deploy environment

Each deploy job declares `environment: <branch>`, so GitHub issues the OIDC token
with an **environment-scoped** subject. The federated credential must match that
environment — create one per environment you deploy (`dev`, `uat`, `prod`):

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
> `AADSTS700213`. Add one credential per deploy environment you use. If you
> previously created a `ref:refs/heads/<branch>`-scoped credential, delete it.

### 4.3 Assign RBAC

Assign the roles listed in §2.3 to the service principal (`$appId`). These must be
run by an **Owner** or **User Access Administrator** on the subscription (see the
warning in §2.3):

```powershell
$appId = "<oidc-app-client-id>"
$sub   = "<workload-subscription-id>"

az role assignment create --assignee $appId --role "Contributor" `
    --scope /subscriptions/$sub
az role assignment create --assignee $appId --role "User Access Administrator" `
    --scope /subscriptions/$sub
```

Verify the assignments landed before deploying:

```powershell
az role assignment list --assignee $appId --all `
    --query "[].{role:roleDefinitionName, scope:scope}" -o table
```

> Scope these to the target **resource group** instead of the whole subscription
> if the RG already exists and you want tighter least-privilege. Use subscription
> scope when Terraform creates the resource group itself.

---

## 5. Entra ID App Registration (end-user sign-in)

Pronghorn's frontend uses MSAL. Two options:

- **Terraform-managed** — set `create_entra_app_registration = true` (requires
  Graph permissions on the deploying SP). Terraform outputs `entra_app_client_id`.
- **Manual** (default in `pbmm.tfvars`) — create the app registration in the
  portal, configure the SPA redirect URI to your frontend callback, then set:

  ```hcl
  create_entra_app_registration = false
  azure_client_id               = "<entra-app-client-id>"
  azure_tenant_id               = "<entra-tenant-id>"
  ```

---

## 5.5 GitHub App

Pronghorn integrates with GitHub through a **GitHub App**, used server-side for
repository operations and dispatching the GenApp deploy workflow. It is **not**
an identity provider — there is no per-user GitHub sign-in.

| Identity | Purpose | tfvars keys | Secret |
| --- | --- | --- | --- |
| **GitHub App** | Backend **repository operations** and **dispatches the GenApp deploy workflow** | _none — set in Key Vault_ | `github-app-id`, `github-app-installation-id`, `github-app-private-key` (Key Vault, §6) |

### 5.5.1 GitHub App (workflow dispatch)

1. **Org → Settings → Developer settings → GitHub Apps → New GitHub App.**
2. **Repository permissions** (set the rest to *No access*):

   | Permission | Level | Why |
   | --- | --- | --- |
   | **Actions** | **Read & write** | Dispatch the GenApp deploy workflow and poll run status on the platform repo |
   | **Contents** | **Read-only** | Read the canonical Terraform template files from the platform repo |
   | **Metadata** | **Read-only** | Mandatory baseline for every GitHub App |

3. Copy the **App ID** — you will store it in Key Vault as `github-app-id` (§6),
   not in tfvars.
4. Generate a **private key** (`.pem`) — you will store its contents in Key Vault
   as `github-app-private-key` (§6).

> **Why so few permissions?** The GitHub App only **dispatches/polls the deploy
> workflow** and **reads the platform repo's templates** — that's why `Contents`
> is read-only.

### 5.5.2 Install the GitHub App (required — this is what creates the installation ID)

A GitHub App does nothing until it is **installed** on the org. Installing it is a
one-time action on GitHub.com that grants the app access to your repos **and
generates the installation ID** Pronghorn needs at runtime. Pronghorn cannot
install itself.

1. On the app's page click **Install App**, choose the **org** (e.g.
   `<org>`), and grant access to the **pronghorn** repository (or all repos per
   org policy). Org-owner approval may be required.
2. After installing, go to
   **Org → Settings → Third-party Access → GitHub Apps** (or
   `https://github.com/organizations/<org>/settings/installations`) and click
   **Configure** next to the app.
3. Read the installation ID from the end of the browser URL:
   `.../settings/installations/<INSTALLATION_ID>`.
4. Store that number in Key Vault as `github-app-installation-id` (§6), not in tfvars.

> The number in an `installations/new/permissions?target_id=...` URL is the **org
> ID**, not the installation ID. The installation ID only exists **after** the app
> is installed, and is shown on the **Configure** page URL.

---

## 6. Deployment configuration: GitHub Environment + committed files + Key Vault

Deployment inputs come from three places: a **per-branch GitHub Environment**
(non-secret deployment Variables), files committed to the repo, and Azure Key
Vault. Nothing sensitive is stored in GitHub repo secrets or in Terraform state.

- **Environment-specific values** (subscription / subnet / DNS / URL-override
  inputs) come from the branch's **GitHub Environment Variables** and are injected
  as `TF_VAR_*` at runtime (§6.0). They have been removed from
  `params/<branch>.tfvars` so the committed `-var-file` cannot override them.
- **Azure login identity** (`azure/login` + `ARM_*`) uses the `SUBSCRIPTION_ID`,
  `AZURE_CLIENT_ID`, and `AZURE_TENANT_ID` environment Variables (§6.0). This is
  the OIDC app from §4 (the same app registration).
- **tfstate backend** identifiers (`TFSTATE_RESOURCE_GROUP`,
  `TFSTATE_STORAGE_ACCOUNT`, `TFSTATE_CONTAINER`, `TFSTATE_KEY`) come from the
  branch's **GitHub Environment Variables** (§6.0) and are passed to `terraform
  init -backend-config`. See §7 for how the backing storage account is
  bootstrapped.
- **Generated secrets** (`postgres-password`, `postgres-genapps-password`,
  `jwt-secret`) are **created once and seeded into the platform Key Vault by
  Terraform** on first apply, then consumed by the database/API via Key Vault
  references and write-only arguments. They never appear in tfvars, `-var`
  flags, GitHub, or Terraform state.
- **GitHub App identity** (`github-app-id`, `github-app-installation-id`,
  `github-app-private-key`) is **seeded as a placeholder by Terraform** and then
  set by you out-of-band (two-phase, §6.2). The API and `genapp-deploy` read it
  from Key Vault at runtime.

### 6.0 GitHub Environment Variables (per deploy branch)

Each deploy branch has a **GitHub Environment of the same name** (`dev`, `uat`,
`prod`) under **Repo → Settings → Environments**. The deploy jobs declare
`environment: ${{ github.ref_name }}`, so the workflow reads that environment's
**Variables** and the OIDC token is issued with subject
`repo:<org>/pronghorn:environment:<branch>` (see §4.2).

Set these as environment **Variables** (not Secrets, not repo-level). Unset
variables fall back to the Terraform default, so set only what an environment
needs. Names are UPPER_SNAKE_CASE and each maps to the lower-case `TF_VAR_*` of
the same name.

**Always required (every environment):**

| Variable | `TF_VAR_*` | Purpose |
| --- | --- | --- |
| `SUBSCRIPTION_ID` | `subscription_id` | Workload subscription GUID; also the `azure/login` subscription. |
| `AZURE_CLIENT_ID` | `azure_client_id` | OIDC + Entra sign-in app (client) ID. |
| `AZURE_TENANT_ID` | `azure_tenant_id` | Entra tenant ID. |

**Terraform state backend (every environment):**

These feed `terraform init -backend-config` directly (they are not `TF_VAR_*`).
`use_azuread_auth=true` is constant and hardcoded in the workflow.

| Variable | Backend key | Purpose |
| --- | --- | --- |
| `TFSTATE_RESOURCE_GROUP` | `resource_group_name` | Resource group holding the tfstate storage account. |
| `TFSTATE_STORAGE_ACCOUNT` | `storage_account_name` | tfstate storage account name. |
| `TFSTATE_CONTAINER` | `container_name` | Blob container (typically `tfstate`). |
| `TFSTATE_KEY` | `key` | State blob key (e.g. `pronghorn-<branch>.tfstate`). The `genapp-deploy` workflow overrides this with a per-app key. |

**Required for the `corp` / PBMM archetype (private networking):**

| Variable | `TF_VAR_*` | Purpose |
| --- | --- | --- |
| `DELEGATED_SUBNET_ID` | `delegated_subnet_id` | PostgreSQL VNet-injection subnet. |
| `KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID` | `keyvault_private_endpoint_subnet_id` | Key Vault private endpoint. |
| `STORAGE_PRIVATE_ENDPOINT_SUBNET_ID` | `storage_private_endpoint_subnet_id` | Storage private endpoint. |
| `CONTAINER_APPS_SUBNET_ID` | `container_apps_subnet_id` | Platform Container Apps env injection. |
| `ACA_ENVIRONMENT_PRIVATE_ENDPOINT_SUBNET_ID` | `aca_environment_private_endpoint_subnet_id` | Platform ACA private endpoint. |
| `WORKLOAD_ACA_SUBNET_ID` | `workload_aca_subnet_id` | Workload Container Apps env injection. |
| `WORKLOAD_ACA_PRIVATE_ENDPOINT_SUBNET_ID` | `workload_aca_private_endpoint_subnet_id` | Workload ACA private endpoint. |
| `APIM_SUBNET_ID` | `apim_subnet_id` | APIM VNet integration subnet. |
| `ACR_PRIVATE_ENDPOINT_SUBNET_ID` | `acr_private_endpoint_subnet_id` | ACR private endpoint. |
| `AI_FOUNDRY_PRIVATE_ENDPOINT_SUBNET_ID` | `ai_foundry_private_endpoint_subnet_id` | AI Foundry private endpoint. |

**Conditional / optional:**

| Variable | `TF_VAR_*` | When to set |
| --- | --- | --- |
| `CENTRAL_DNS_SUBSCRIPTION_ID` | `central_dns_subscription_id` | Only when `delegate_private_dns_to_policy = false` (Terraform resolves central DNS). Leave unset in policy-DNS mode. |
| `CENTRAL_DNS_RESOURCE_GROUP_NAME` | `central_dns_resource_group_name` | Same as above. |
| `FRONTEND_APP_URL_OVERRIDE` | `frontend_app_url_override` | Optional — public frontend URL (MSAL redirect / CORS) when fronting with a custom domain. |
| `API_BASE_URL_OVERRIDE` | `api_base_url_override` | Optional — public API URL (`VITE_API_BASE_URL` + derived `VITE_WS_URL`). |

Set them in the portal (**Settings → Environments → `<branch>` → Add variable**)
or with the GitHub CLI:

```bash
gh variable set SUBSCRIPTION_ID --env dev --body "<workload-subscription-guid>"
gh variable set DELEGATED_SUBNET_ID --env dev --body "/subscriptions/.../subnets/<data-subnet>"
# ...repeat per variable, per environment (dev / uat / prod)
```

The `export-terraform-environment-config` workflow step copies each non-empty
variable into `$GITHUB_ENV` as `TF_VAR_<name>`, which Terraform reads natively.
Because these keys were removed from `params/<branch>.tfvars`, there is no
`-var-file` value to override them.

> Non-secret only: these are deployment **Variables**, not Secrets. Runtime
> secrets (DB passwords, JWT, GitHub App key) still live in Key Vault (§6.2),
> never in GitHub.

### 6.1 Set the tfstate backend variables

The remote tfstate identifiers are **GitHub Environment Variables** (see the
Terraform-state-backend table in §6.0), not a committed file. Set them on each
deploy environment alongside the other Variables, using the storage identifiers
from §7:

```bash
gh variable set TFSTATE_RESOURCE_GROUP  --env dev --body "<tfstate-rg>"
gh variable set TFSTATE_STORAGE_ACCOUNT --env dev --body "<tfstate-storage-account>"
gh variable set TFSTATE_CONTAINER       --env dev --body "tfstate"
gh variable set TFSTATE_KEY             --env dev --body "pronghorn-dev.tfstate"
```

The workflows pass these to `terraform init -backend-config="key=value"` (plus a
constant `use_azuread_auth=true`). The `genapp-deploy` workflow reuses the RG /
storage account / container and overrides only the blob `key` (one state file per
generated app).

### 6.2 Set the GitHub App secrets in Key Vault (two-phase)

Terraform seeds the three GitHub App secrets with the placeholder value
`REPLACE_VIA_KEY_VAULT` (under `lifecycle { ignore_changes = [value] }`, so a
re-apply never clobbers your real values). After the **first** deploy creates the
platform Key Vault, set the real values once. The three secrets are:

| Secret name | Value | Where to get it |
| --- | --- | --- |
| `github-app-id` | numeric App ID | GitHub App settings → **App ID** |
| `github-app-installation-id` | numeric installation ID | the number in the install URL `…/installations/<id>` (§5.5.2) |
| `github-app-private-key` | **RSA private key (PEM)** | GitHub App settings → **Private keys → Generate a private key** (downloads a `.pem`) |

> **Use the private key, not the client secret.** The backend signs a JWT with
> `RS256` using this key (see `app/backend/src/utils/githubAppAuth.ts`). A GitHub
> App **client secret** (the short opaque OAuth string) will **not** work and will
> break workflow dispatch. `github-app-private-key` must contain the full PEM,
> beginning with `-----BEGIN RSA PRIVATE KEY-----`.

**The platform Key Vault is private-endpoint-only** (public network access
disabled). All three commands must run from **inside the PBMM VNet**, and the
calling identity needs **Key Vault Secrets Officer** on the vault. There are two
supported ways to do this:

#### Option A — from the self-hosted runner (preferred)

The runner is already inside the VNet and has the Azure CLI. From a shell on the
runner, authenticate as an identity that holds **Key Vault Secrets Officer** on
the platform vault, then:

```bash
VAULT=<platform-vault-name>   # e.g. kv-<project>-<suffix>

az keyvault secret set --vault-name "$VAULT" --name github-app-id --value "<app-id>"
az keyvault secret set --vault-name "$VAULT" --name github-app-installation-id --value "<installation-id>"
az keyvault secret set --vault-name "$VAULT" --name github-app-private-key --file ./app.private-key.pem
```

#### Option B — locked-down VNet with no outbound internet (REST over IMDS)

In a hardened PBMM landing zone the in-VNet host may have **no outbound internet**
(so `az` cannot be installed and `az login` cannot reach Entra) while still
reaching the vault's private endpoint. In that case, use a VM/host inside the
VNet with a **managed identity** that holds **Key Vault Secrets Officer** on the
vault, and call the Key Vault REST API directly with `curl` — the token comes
from the **link-local IMDS endpoint** (`169.254.169.254`, never leaves the host,
needs no internet):

```bash
VAULT=<platform-vault-name>

# 1. Get a vault-scoped token from IMDS (no internet required)
TOKEN=$(curl -s -H "Metadata: true" \
  "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net" \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

# 2. Set the two IDs
set_secret() {
  curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"value\":\"$2\"}" \
    "https://$VAULT.vault.azure.net/secrets/$1?api-version=7.4" \
    | grep -o '"id":"[^"]*"' && echo "  -> $1 set"
}
set_secret github-app-id "<app-id>"
set_secret github-app-installation-id "<installation-id>"

# 3. Set the PEM private key (paste it into /tmp/app.pem via a heredoc first),
#    using python3 to JSON-escape the newlines correctly:
python3 - "$VAULT" "$TOKEN" <<'PY'
import json, sys, urllib.request
vault, token = sys.argv[1], sys.argv[2]
pem = open("/tmp/app.pem").read()
body = json.dumps({"value": pem}).encode()
req = urllib.request.Request(
    f"https://{vault}.vault.azure.net/secrets/github-app-private-key?api-version=7.4",
    data=body, method="PUT",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
print(urllib.request.urlopen(req).status, "github-app-private-key set")
PY

# 4. Shred the PEM from disk when done
shred -u /tmp/app.pem 2>/dev/null || rm -f /tmp/app.pem
```

To **read back / validate** any secret with the same token:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://$VAULT.vault.azure.net/secrets/github-app-id?api-version=7.4" \
  | grep -o '"value":"[^"]*"'
```

> **RBAC note.** A `Forbidden` / `Caller is not authorized` response means the
> calling identity lacks the role — grant **Key Vault Secrets Officer** scoped to
> the vault (an **Owner** / **User Access Administrator** must run this; it is a
> control-plane call and works from anywhere):
> ```bash
> az role assignment create --assignee <identity-object-id> \
>   --role "Key Vault Secrets Officer" \
>   --scope "/subscriptions/<sub>/resourceGroups/<platform-rg>/providers/Microsoft.KeyVault/vaults/<vault>"
> ```
> A `ForbiddenByConnection` / "Public network access is disabled" response instead
> means the **network path** is wrong — you are not inside the VNet.

The runner and the API's managed identity also need **Key Vault Secrets User** on
the platform vault to **read** these at runtime; the deploying identity needs
**Key Vault Secrets Officer** so Terraform can seed the placeholders.

> **Rotate exposed keys.** If a private key is ever pasted into a chat, ticket,
> terminal history, or any file, treat it as compromised: generate a **new**
> private key in the GitHub App, delete the old one, and re-set
> `github-app-private-key` in the vault.

> Until you set real values, `genapp-deploy` (which fetches `github-app-id` and
> `github-app-private-key` from the vault) fails fast on the
> `REPLACE_VIA_KEY_VAULT` placeholder rather than dispatching with a bad key.

After setting the real values, **re-run the platform deploy once** so the
containers pick them up (the `lifecycle { ignore_changes = [value] }` guard means
this redeploy will not overwrite what you just set).

> Recommended: gate production with **GitHub Environment protection rules** — add
> **required reviewers** (and optionally a wait timer) to the `prod` environment so
> prod deploys pause for manual approval. Combine with branch protection on the
> deploy branch for defence in depth.

---

## 7. Bootstrap the Terraform State Backend

The tfstate storage account is **private** in PBMM. Because the runner is inside
the VNet, it reaches the account through its private endpoint — no network is
opened. The workflow's `bootstrap-terraform-shared-state` step runs:

```powershell
./infra/scripts/bootstrap-tfstate.ps1 ... -TfvarsPath "infra/params/pbmm.tfvars" -SkipSecurityControlTag
```

The script is **idempotent** and self-enforces PBMM networking on every run:

1. Creates the resource group, storage account (shared-key **and** blob-public
   access disabled), and blob container if missing.
2. Creates a **blob private endpoint** named `<account>-blob-pe` in the subnet
   resolved from `storage_private_endpoint_subnet_id` in the tfvars file (or pass
   `-PrivateEndpointSubnetId` explicitly).
3. Attaches the central `privatelink.blob.core.windows.net` DNS zone group —
   either via Azure Policy (DeployIfNotExists, the default) or, if you pass
   `-BlobPrivateDnsZoneId`, by wiring the zone group directly.
4. Sets **public network access = Disabled** and **default network action = Deny**
   so the account is reachable **only** over the private endpoint.

> **Hard requirement (enforced).** When `-SkipSecurityControlTag` is set (PBMM
> mode) and **no** private-endpoint subnet can be resolved from
> `-PrivateEndpointSubnetId` or `storage_private_endpoint_subnet_id`, the script
> **fails fast** — public network access is never permitted in PBMM.

`-SkipSecurityControlTag` also ensures the `SecurityControl=Ignore` policy-exemption
tag is **not** applied (PBMM keeps full policy enforcement). Because the account
is locked to its private endpoint, the bootstrap step (and all later
`terraform init` state operations) must run from **inside the VNet** — i.e. on the
self-hosted runner (§3), never from a workstation outside the network.

Prerequisites for the bootstrap identity (the OIDC SP from §4):

- **Storage Blob Data Contributor** on the tfstate storage account (state uses
  `use_azuread_auth=true`; shared-key access is disabled). This is a **data-plane**
  role and is separate from the `Contributor` role — without it `terraform init`
  fails with `AuthorizationPermissionMismatch`. Assigning it requires an
  **Owner** or **User Access Administrator** on the scope.
- **Contributor** (or equivalent) on the tfstate resource group and the
  private-endpoint subnet's network, so the script can create the storage account
  and the private endpoint.

> If you provisioned the tfstate account **before** this script enforced private
> networking (e.g. it still shows public access enabled), simply re-run the
> `bootstrap-terraform-shared-state` step from the runner — the idempotent script
> will create the private endpoint and disable public access in place.

---

## 8. Complete `params/pbmm.tfvars`

Open [infra/params/pbmm.tfvars](../infra/params/pbmm.tfvars) and replace **every**
value marked `REPLACE:`. Sensitive values (passwords, secrets) are **not** stored
here — generated secrets are seeded into the platform Key Vault by Terraform, and
the GitHub App identity is set out-of-band in Key Vault (see §6).

> **Two-pass values (host-dependent).** A few values depend on the public
> hostname(s) of the deployed app, which don't exist until the **first** apply
> creates the Container Apps environment. On the first pass, leave the placeholder
> defaults; after the first deploy yields the real FQDN, patch these and re-run:
> `allowed_origins`, `apim_publisher_email`, and the **MSAL SPA redirect URI** on
> the Entra app (§5).

Production SKUs are already set (see §11). Validate locally if you have private
network access:

```powershell
cd infra
terraform fmt -check
terraform validate
```

---

## 9. Run the Deployment

1. Push the `pbmm.tfvars` changes to the branch the workflow runs from.
2. **Actions → platform-deploy → Run workflow** (`workflow_dispatch`).
3. Recommended first run: set **`plan = true`** to review the Terraform plan.
4. Re-run with `plan = false` to apply.

Inputs:

| Input | Effect |
| --- | --- |
| `plan` | Terraform plan only — no apply/build/update |
| `skip_infra` | Skip core infrastructure stage |
| `skip_build` | Skip image build (`az acr build`) |
| `skip_container_apps` | Skip Container Apps deploy |
| `deploy_ai_models` | Deploy AI model deployments afterward |
| `destroy` | **DESTRUCTIVE** — destroy infra before apply |
| `debug_logging` | Verbose Actions + Terraform logging |

The workflow stages: validate auth → OIDC login → start PostgreSQL (if stopped) →
bootstrap state (`-SkipSecurityControlTag`) → `terraform init/validate/plan/apply`
(with import/retry/private-endpoint reconciliation) → build images on the ACR
agent pool → deploy Container Apps → capture a rollback snapshot artifact
(`deployment-snapshot-prod`).

---

## 9.5 Post-Deployment Configuration (two-pass auth wiring)

Several auth values depend on the deployed frontend hostname (FQDN), which does
not exist until the **first** apply creates the Container Apps environment. After
the first successful deploy, complete the steps below. Each step is tagged with
whether it needs a **redeploy** or is a **portal-only** change.

> **Get the deployed frontend FQDN first.** Run this from the self-hosted runner
> (inside the VNet):
>
> ```powershell
> az containerapp show -n ca-pronghorn-frontend -g <resource-group> `
>   --query "properties.configuration.ingress.fqdn" -o tsv
> ```
>
> Example result:
> `ca-pronghorn-frontend.<random>.<region>.azurecontainerapps.io`
> The `<random>` segment is generated by the Container Apps environment and
> **changes if the environment is ever recreated** — see the custom-domain note
> at the end of this section.

### 9.5.1 Entra SPA redirect URI — **portal only, no redeploy**

The MSAL redirect URI is computed by Terraform from the frontend output and is
already baked into the deployed build (`VITE_AZURE_REDIRECT_URI`). The only
remaining action is to register that exact URI on the Entra app registration
(Terraform does **not** manage the app when `create_entra_app_registration = false`).

1. **Entra ID → App registrations → your app → Authentication.**
2. Under **Single-page application** (not "Web"), **Add URI**:
   `https://<frontend-fqdn>` (no trailing slash, no path).
3. Leave **Front-channel logout URL** blank and leave **Access tokens** /
   **ID tokens** (implicit/hybrid) **unchecked** — MSAL.js uses the
   authorization-code-with-PKCE flow, so the implicit-grant checkboxes are not
   needed.
4. Save. Sign-in works immediately — **no redeploy required**.

> A redirect-URI mismatch surfaces as **AADSTS50011**. The registered URI must
> byte-match what MSAL sends (scheme, host, no trailing slash).

### 9.5.2 GitHub App (workflow dispatch) — **nothing to set here**

The GitHub **App** authenticates server-to-server with a JWT signed by its
private key — there is **no browser redirect**. Leave its **Callback URL**,
**Setup URL**, **Request user authorization (OAuth) during installation**, and
**Enable Device Flow** fields blank/unchecked. Only its **permissions**
(Actions: Read & write) and **installation** matter (§5.5.1–5.5.2).

### 9.5.3 CORS allowed origins — **already handled**

The API automatically adds the deployed frontend URL to its CORS allowlist, so
the `allowed_origins` placeholder in tfvars does not block the app. Update it
with the real domain(s) only when you want to tighten/extend CORS explicitly
(requires a redeploy).

### 9.5.4 Apply the redeploy

For any change that needs a redeploy (§9.5.3), commit the tfvars change
and re-run **§9** (`platform-deploy`). The redeploy rebuilds the affected images
and updates the Container Apps env vars.

> **Custom domain recommendation.** The auto-generated `<random>` segment in the
> Container Apps FQDN regenerates if the environment is recreated, which would
> break the baked-in redirect URIs. For a stable production deployment, assign a
> **custom domain**, set `frontend_app_url_override` in tfvars to that domain, and
> register the auth redirect URIs against the custom domain **once** — this avoids
> re-doing §9.5.1 on every environment rebuild.

---

## 9.6 Re-running the deploy (redeploy methodology)

The entire deploy is driven by the branch, its matching **GitHub Environment**
(deployment Variables incl. `TFSTATE_*`, §6.0), its committed
`params/<branch>.tfvars`, and the platform Key Vault. Re-running is therefore just
re-triggering the
**`platform-deploy`** workflow against the target branch. Use this whenever you
need to propagate a Key Vault change (e.g. after §6.2), a tfvars change, or a new
image into the running containers.

**When a redeploy is required:**

- After **setting/rotating the GitHub App secrets** in Key Vault (§6.2) — the
  containers only re-read them on a fresh revision.
- After editing `params/<branch>.tfvars` (e.g. CORS, SKUs, env vars).
- After merging code that should ship to the environment.

> **Key Vault values are safe across redeploys.** The three GitHub App secrets and
> the generated secrets (`postgres-password`, `postgres-genapps-password`,
> `jwt-secret`) are seeded by Terraform with `lifecycle { ignore_changes = [value] }`.
> A redeploy **never** overwrites the real values you set out-of-band — it only
> re-mounts them into the new container revision.

### Option A — fresh `workflow_dispatch` (recommended)

UI: **Actions → platform-deploy → Run workflow** → pick the branch (e.g. `dev`) →
leave `plan` **unchecked** (false) → **Run workflow**.

CLI (GitHub CLI, authenticated against the repo):

```bash
gh workflow run platform-deploy.yml --ref <branch> \
  -f plan=false -f skip_infra=false -f skip_build=false
```

To **review the plan first** without applying, set `plan=true`, inspect the run,
then dispatch again with `plan=false`.

> **To force the containers to pick up new Key Vault values, do NOT set
> `skip_build=true` or `skip_container_apps=true`.** The Container Apps deploy
> stage is what creates a new revision that re-reads the secrets. A full run
> (all stages, `plan=false`) guarantees the API/frontend containers are
> recreated with the current vault values mounted.

### Option B — re-run a previous run (same commit)

UI: **Actions → platform-deploy →** open the last run **→ Re-run all jobs**.

CLI:

```bash
gh run list --workflow platform-deploy.yml --branch <branch> --limit 5
gh run rerun <run-id>
```

### Option C — push to the branch

Any non-doc push to `dev` / `uat` / `prod` auto-triggers `platform-deploy`.
Pure docs/markdown changes (`**/*.md`, `docs/**`, `.vscode/**`, etc.) are
**path-ignored** and will **not** trigger a deploy on their own.

### Verifying the redeploy picked up the secrets

After a green run, confirm the GitHub App auth is live (the API logs the
"GitHub App is not configured" error only when a value is missing/placeholder):

```powershell
# From the self-hosted runner (inside the VNet):
az containerapp revision list -n ca-pronghorn-api -g <resource-group> `
  --query "[?properties.active].{rev:name, created:properties.createdTime}" -o table
```

The newest active revision should post-date your Key Vault `set`. A genapp deploy
(or any GitHub-App-backed action) should now succeed instead of failing fast on
`REPLACE_VIA_KEY_VAULT`.

---

## 10. Customer Replication Checklist

To deploy into a **customer's** PBMM environment, complete the following in their
tenant/subscriptions:

- [ ] **Platform inputs** — obtain all subnet IDs, central DNS subscription/RG,
      and ACR/resource names from the customer platform team (§2), and set them as
      **GitHub Environment Variables** on the deploy environment (§6.0).
- [ ] **`params/pbmm.tfvars`** — copy to a customer-specific file (or fork) and
      replace **all** `REPLACE:` placeholders, including policy tags and
      `allowed_origins`.
- [ ] **OIDC** — create an app registration + federated credential scoped to
      `repo:<org>/pronghorn:environment:<branch>` in the customer tenant; assign RBAC
      (§2.3, §4).
- [ ] **Entra sign-in app** — create or configure (§5); set the `AZURE_CLIENT_ID` /
      `AZURE_TENANT_ID` GitHub Environment Variables (§6.0).
- [ ] **tfstate backend + Key Vault** — set the `TFSTATE_*` GitHub Environment
      Variables with the customer's tfstate identifiers (§6.0/§6.1). After the
      first deploy, set the GitHub App secrets in the platform Key Vault
      out-of-band (§6.2). Ensure `workload_aca_environment_name` in
      `params/pbmm.tfvars` matches the customer's workload Container Apps
      environment.
- [ ] **Self-hosted runner** — provision inside the customer VNet via
      `New-PbmmRunner.ps1` (§3); confirm AcrPush + agent-pool access.
- [ ] **tfstate backend** — bootstrap a private storage account in the customer
      subscription (§7).
- [ ] **GitHub App** — register against the customer's
      GitHub org (§5.5). **Install** the GitHub App on the org and read the
      installation ID from the Configure page URL. Store `github-app-id`,
      `github-app-installation-id` and `github-app-private-key` in the platform
      Key Vault out-of-band (§6.2).
- [ ] **DNS / certificates** — map the frontend/APIM hostnames and provide TLS
      certificates per the customer's PBMM ingress pattern.
- [ ] **Dry run** — run with `plan = true`, review, then apply.
- [ ] **Post-deploy auth wiring** — after the first apply, complete §9.5: register
      the Entra SPA redirect URI (portal-only) and verify CORS.

---

## 11. Production SKU Summary

The following resources are sized for production in `params/pbmm.tfvars`
(upgraded from dev defaults):

| Resource | tfvars key(s) | Dev value | PBMM (prod) value |
| --- | --- | --- | --- |
| App PostgreSQL compute | `postgresql_sku_name` | `GP_Standard_D2s_v3` | `GP_Standard_D4s_v3` (4 vCore) |
| App PostgreSQL storage | `postgresql_storage_mb` | 65536 (64 GB) | 131072 (128 GB) |
| Gen-apps PostgreSQL compute | `postgresql_genapps_sku_name` | `GP_Standard_D2s_v3` | `GP_Standard_D4s_v3` (4 vCore) |
| Gen-apps PostgreSQL storage | `postgresql_genapps_storage_mb` | 65536 (64 GB) | 131072 (128 GB) |
| API container CPU / memory | `container_cpu` / `container_memory` | 1.0 / 2Gi | 2.0 / 4Gi |
| Frontend container CPU / memory | `frontend_container_cpu` / `frontend_container_memory` | 0.25 / 0.5Gi | 0.5 / 1Gi |
| API Management | `apim_sku` | `Standard_1` | `Premium_1` (Internal VNet + multi-AZ + SLA) |
| ACR agent pool tier | `acr_agent_pool_tier` | `S1` | `S2` |
| Key Vault | `keyvault_sku` | standard | `premium` (HSM-backed) |
| Container Registry | `acr_sku` | Standard | `Premium` (PE, zone redundancy) |
| Min replicas (API + frontend) | `container_min_replicas` / `frontend_min_replicas` | 1 | 2 (HA) |
| HA / geo-redundant backup | `enable_high_availability`, `geo_redundant_backup_enabled` | off | on |
| Backup retention | `backup_retention_days` | shorter | 35 days |
| Log retention | `log_retention_days` | shorter | 90 days |
| Storage replication | `storage_replication_type` | LRS | `GRS` |

---

## 12. Known Infrastructure Gaps & Troubleshooting

For known PBMM infrastructure gaps (APIM Internal VNet mode, Front Door,
AMPLS, ACR agent pools, genapp Key Vaults, genapp workflow constraints) and the
**private DNS zone linking checklist** (the single most common class of PBMM
runtime failure), refer to the internal PBMM troubleshooting runbook.

Key topics covered there:

- APIM, Front Door, AMPLS, and ACR agent pool constraints
- Per-app genapp Key Vault private endpoint lifecycle
- GenApp deploy workflow PBMM requirements (self-hosted runner, Key Vault-sourced GitHub App identity)
- Private DNS zone → spoke VNet linking checklist (with symptom table)
- APIM drift diagnostics (stale `azure-api.net` A-records)

---

## 13. Rollback

Each successful run uploads a `deployment-snapshot-prod` artifact containing
Terraform outputs and the active Container Apps revisions/images. To roll back,
redeploy the previous image tags / revisions recorded in that snapshot via
`platform-deploy`, or pin the affected Container Apps to the prior revision.

---

## 14. Exposing the App on a Public Custom Domain

For the full procedure to expose Pronghorn on a public custom domain via the
two-tier App Gateway pattern, refer to the internal custom domain setup runbook.

That runbook covers:

- Traffic flow (public App Gateway → internal App Gateway → Container Apps / APIM)
- Terraform configuration (`frontend_app_url_override`, `api_base_url_override`)
- App Gateway / DNS plumbing (backend pools, host headers, probes)
- Reference topology and discovery commands
- Private DNS records for Container Apps zone
- Internal APIM resolution (`azure-api.net` zone)
- Entra and GitHub OAuth portal steps
- Post-change verification

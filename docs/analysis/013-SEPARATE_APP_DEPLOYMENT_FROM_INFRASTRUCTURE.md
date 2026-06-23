# 013 — Separate Application Deployment from Infrastructure

## Current state (from code audit)
The dev-internal pipeline runs infrastructure provisioning and application
deployment in a single Terraform-driven workflow:

- [`deploy-dev-internal.yml`](../../.github/workflows/deploy-dev-internal.yml)
  runs `terraform apply` for the core infra, then `docker build` + `docker
  push`, then a second `terraform apply` that passes `-var=container_image=…`
  and `-var=frontend_container_image=…`, then an imperative
  `az containerapp update --image … --set-env-vars …` for both apps.
- [`infra/modules/container-apps/main.tf`](../../infra/modules/container-apps/main.tf)
  writes the full container app `template` (image, env vars, scaling) and
  relies on the AVM module internally ignoring `body.properties.template`
  changes so the `az` updates don't drift the next run. The intent comment
  reads `# AVM module ignores body.properties.template changes (CI/CD safe)`
  — `ignore_changes` is masking dual ownership, not fixing it.
- [`infra/main.tf` L421, L591](../../infra/main.tf) seed a placeholder
  `mcr.microsoft.com/azuredocs/containerapps-helloworld:latest` image so the
  first `terraform apply` can succeed before any image exists. A second
  apply overwrites it.
- Terraform ingress is hard-coded
  `traffic_weight = [{ percentage = 100, latest_revision = true }]`, so
  rollback today re-runs Terraform with an older SHA (the
  `infra/scripts/*-rollback-*.ps1` + `get-deployment-snapshot.ps1`
  scaffolding exists only to support that workflow).
- The infra-derived env-var contract already exists as
  [`local.api_environment_variables`](../../infra/locals.tf) (POSTGRES_HOST,
  AZURE_STORAGE_ACCOUNT_NAME, AZURE_ACR_LOGIN_SERVER, ENTRA_*, …) and
  [`local.frontend_build_environment_variables`](../../infra/locals.tf) for
  VITE_*. Both are surfaced as Terraform outputs
  `api_container_env_vars` and `frontend_build_env_vars` in
  [`infra/outputs.tf`](../../infra/outputs.tf).
- Secrets are already routed through Key Vault via
  [`local.api_secret_environment_variables`](../../infra/locals.tf) (maps env
  var name → KV secret name) and the container-app `secrets` block resolves
  them with the UAMI. The runtime contract is `process.env.X` regardless of
  source.
- DB migrations run on container startup in
  [`app/backend/src/index.ts` L204–L218](../../app/backend/src/index.ts),
  gated by `RUN_MIGRATIONS_ON_STARTUP=true` (set in
  [`infra/locals.tf` L102](../../infra/locals.tf)). The migrations folder is
  baked into the API image at
  [`app/backend/Dockerfile` L29](../../app/backend/Dockerfile).
- [`ci.yml`](../../.github/workflows/ci.yml) handles PR validation (lint,
  build, test, terraform fmt/validate/plan, npm audit, gitleaks, checkov).
  Application deploy has no equivalent dedicated workflow.

## Summary
Split the dev-internal pipeline into two: keep `deploy-dev-internal.yml`
(renamed `deploy-infra-dev.yml`) for infrastructure only, and add a new
`cd.yml` that owns build → push → `az containerapp update`. Strip
Terraform's ownership of `template.containers[*].image`,
`template.containers[*].env`, `template.revision_suffix`, and
`ingress.traffic_weight` via explicit `lifecycle.ignore_changes` so the
two pipelines stop fighting over the same fields. DB migrations stay on
container startup; infra-derived env vars stay in Terraform as the single
source of truth and flow to CD via `terraform output -json` at deploy
time. The Key-Vault promotion path is already supported by the existing
secrets contract — no app or CD changes required to move a value later.

This is the Microsoft-recommended shape for Container Apps deployments:
> Separate the microservice deployment pipelines from the infrastructure
> pipelines because they often don't share a similar life cycle. Your
> declarative pipeline for Azure infrastructure should deploy all
> resources except the container app resources. Use an imperative
> approach to creating, updating, and removing container apps from the
> environment.
> — [Deploy Microservices to Azure Container Apps — Considerations](https://learn.microsoft.com/azure/architecture/example-scenario/serverless/microservices-with-container-apps#considerations)

Reinforcing references:
- [CI/CD for microservices](https://learn.microsoft.com/azure/architecture/microservices/ci-cd#update-services)
- [Blue-green deployment in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/blue-green-deployment)
- [Container Apps revisions overview](https://learn.microsoft.com/azure/container-apps/revisions#work-with-multiple-revisions)
- [`azd` image-based deployment strategy](https://learn.microsoft.com/azure/developer/azure-developer-cli/container-apps-workflows#image-based-deployment-strategy)
- [Deploy to Azure Container Apps from Azure Pipelines](https://learn.microsoft.com/azure/container-apps/azure-pipelines)

## Decisions
- Two workflows: `deploy-infra-dev.yml` (infra-only) and a new `cd.yml`
  (app build + deploy). `ci.yml` is unchanged.
- Terraform stops writing the container app image and env-var map. Add
  explicit `lifecycle { ignore_changes = […] }` on the container app
  resource. Bootstrap placeholder image stays for first-create only.
- DB migrations stay on container startup. Container Apps readiness probe
  holds traffic until startup (incl. migrations) completes. Forward-compat
  rule for the team: every migration must keep the previous revision
  running until traffic flips. Destructive schema changes go through the
  expand/contract pattern over two deploys. Container Apps Jobs for
  migrations is **not** in scope; introduce only if a non-additive change
  is unavoidable.
- Infra-derived env vars are read live with `terraform output -json
  api_container_env_vars` and `terraform output -json frontend_build_env_vars`
  at the start of every CD run. No artifact snapshot, no separate config
  store. This is option A from the "Further considerations" section of the
  earlier analysis — chosen because the data is always current and the
  required OIDC + tfstate access is already configured for `pbmm-dev`.
- CD fails closed when `terraform output` is missing a key it expects.
  The output contract is treated as a typed interface and validated
  before `az containerapp update`.
- Single-revision mode stays for now. Blue/green with labels is a
  follow-up; the `lifecycle` changes make it possible without further
  re-architecting.
- `deploy.yml` (the ACR-pool / pbmm variant) is **out of scope** for this
  change. Port the pattern after dev-internal proves out.

## Pipeline contract
**Trigger model**

| Workflow | Trigger | Owns |
| --- | --- | --- |
| `ci.yml` | PR | Lint, build, test, `terraform plan`, security scans |
| `deploy-infra-dev.yml` | Push to `dev-internal` on `infra/**`; manual dispatch | VNet, ACR, KV, Postgres, Container App Environment, identities, RBAC, private endpoints, APIM, Front Door, container-app shells (no image/env) |
| `cd.yml` | Push to `dev-internal` on `app/**`; manual dispatch; downstream `workflow_run` after infra deploy succeeds | Image build/push, `az containerapp update`, post-deploy verification |

**Terraform output contract (consumed by CD)**

| Output | Purpose |
| --- | --- |
| `container_registry_login_server` | Image tag prefix |
| `container_registry_name` | `az acr login` target |
| `resource_group_name` | Target RG for `az containerapp …` |
| `api_uami_id` | `az containerapp registry set --identity` |
| `frontend_uami_id` | Same, frontend |
| `api_container_env_vars` (JSON) | `--replace-env-vars` for API |
| `frontend_build_env_vars` (JSON) | Injected as VITE_* into `npm run build` |

## Phase 1 — Decouple Terraform from app deploy fields
1. Add explicit `lifecycle.ignore_changes` to the container app resource in
   [`infra/modules/container-apps/main.tf`](../../infra/modules/container-apps/main.tf)
   for `template[0].container[0].image`,
   `template[0].container[0].env`, `template[0].revision_suffix`, and
   `ingress[0].traffic_weight`. If the AVM
   `Azure/avm-res-app-containerapp/azurerm` module does not expose a
   user-supplied `lifecycle` block, replace that one resource with a
   direct `azapi_resource` so the contract is owned, not implicit.
2. Remove the placeholder/overwrite duality from
   [`deploy-dev-internal.yml`](../../.github/workflows/deploy-dev-internal.yml):
   - Delete `build-frontend`, `build-and-push-frontend-image`,
     `build-api`, `build-and-push-api-image`,
     `update-container-apps-images` steps.
   - Remove `-var=container_image=…` and
     `-var=frontend_container_image=…` from
     `deploy-container-apps-apply`.
   - Rename the file to `deploy-infra-dev.yml` and update the
     `concurrency.group` accordingly.
3. Run `terraform plan` against current dev tfstate — must show zero diff
   on container-app `template` and `ingress.traffic_weight`.

## Phase 2 — New `cd.yml`
Triggers: `push` on `dev-internal` with `paths: ['app/**']`,
`workflow_dispatch`, and a downstream
`workflow_run` after `deploy-infra-dev.yml` completes successfully.

Jobs:
1. **`read-infra-outputs`** — OIDC login to `pbmm-dev`; `terraform init
   -backend-config=…`;
   `terraform output -json api_container_env_vars > api-env.json`;
   `terraform output -json frontend_build_env_vars > fe-env.json`;
   capture `container_registry_login_server`, `container_registry_name`,
   `resource_group_name`, `api_uami_id`, `frontend_uami_id` as job
   outputs. Validate that every key the API/frontend expects is present —
   fail closed if not.
2. **`build-and-push-api`** — needs `read-infra-outputs`. `cp -r
   infra/migrations app/backend/migrations` (preserves current Dockerfile
   contract). `npm ci && npm run build`. `az acr login`. `docker build
   -t $ACR/pronghorn-api:$SHA`. `docker push`.
3. **`build-and-push-frontend`** — runs in parallel with
   `build-and-push-api`. Exports VITE_* from `fe-env.json` into the shell
   before `npm run build` (Vite bakes them in). `docker build`, `docker
   push`.
4. **`deploy-api`** — needs `build-and-push-api`. `az containerapp
   registry set --name ca-pronghorn-api --server $ACR --identity
   $API_UAMI` (idempotent). `az containerapp update --name
   ca-pronghorn-api --image $ACR/pronghorn-api:$SHA --revision-suffix
   $(git rev-parse --short HEAD) --replace-env-vars @api-env.json`.
5. **`deploy-frontend`** — same shape as `deploy-api`, but no runtime
   env-var injection (VITE_* are baked in).
6. **`verify`** — `curl -fSs https://$API_FQDN/api/health` and
   `curl -fSs https://$FRONTEND_FQDN/`. Fail on non-2xx.

## Phase 3 — Migrations & rollback story
- **Migrations:** keep the current behavior in
  [`index.ts` L204–L218](../../app/backend/src/index.ts) — `runMigrations()`
  runs before `app.listen()` when `RUN_MIGRATIONS_ON_STARTUP=true`. The
  new revision runs migrations during startup; the Container Apps
  readiness probe holds traffic until the new revision is healthy. No CD
  step is needed for additive migrations. Document the forward-compat
  rule: every migration must leave the previous revision functional
  until traffic flips. For destructive changes, follow expand/contract
  across two deploys.
- **Rollback:** replace the snapshot/replay machinery in
  `infra/scripts/*-rollback-*.ps1` with the documented Container Apps
  primitive:
  ```bash
  az containerapp ingress traffic set \
    --name ca-pronghorn-api \
    --resource-group "$RG" \
    --revision-weight <previous-revision>=100 latest=0
  ```
  Per the [blue-green Container Apps doc](https://learn.microsoft.com/azure/container-apps/blue-green-deployment),
  traffic re-points within seconds. Pair with `az containerapp revision
  activate --revision <previous>` if the previous revision was
  deactivated.

## Phase 4 — Key Vault promotion ergonomics
The contract already supports it:

- `local.api_environment_variables` — plain values; injected via
  `--replace-env-vars` in CD.
- `local.api_secret_environment_variables` — KV-secret-name map; resolved
  by the container-app `secrets` block + UAMI; surfaces as
  `process.env.X` at runtime.

To promote a plain env var to a Key Vault secret later (e.g. `GITHUB_CLIENT_ID`):
1. Add the value as an `azurerm_key_vault_secret` in
   [`infra/main.tf`](../../infra/main.tf).
2. Add the env-var name → KV secret name mapping in
   `local.api_secret_environment_variables` in
   [`infra/locals.tf`](../../infra/locals.tf).
3. Remove the same key from `local.api_environment_variables`.

No app code changes. No CD pipeline changes. `api_container_env_vars`
shrinks by one entry, the secret appears at the same `process.env.X`
location at runtime, and `--replace-env-vars` keeps writing only the
non-secret env vars (the secret block stays under Terraform control).

## Steps
1. Add `lifecycle.ignore_changes` to the container app resource for
   `template.containers[*].image`, `template.containers[*].env`,
   `template.revision_suffix`, and `ingress.traffic_weight`. *Blocks all
   later steps.*
2. Verify infra-only `terraform plan` shows zero template/ingress diff
   against current dev tfstate. *Depends on 1.*
3. Create `cd.yml` with the six jobs above. *Parallel with 4.*
4. Strip build/push/update steps from `deploy-dev-internal.yml`; remove
   the two image `-var` flags; rename to `deploy-infra-dev.yml`.
   *Parallel with 3.*
5. End-to-end on `dev-internal`: trigger infra apply (no template diff
   expected), then push an app-only change and confirm exactly one new
   revision per app. *Depends on 1–4.*
6. Update [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) and
   [`docs/deployment-rollback.md`](../deployment-rollback.md) for the
   two-pipeline model and CLI rollback. *Depends on 5.*
7. Retire or slim `infra/scripts/*-rollback-*.ps1`,
   `get-deployment-snapshot.ps1`, and the `capture-*` /
   `upload-deployment-snapshot` steps in the infra workflow. *Depends on
   5.*

## Relevant files
- [`.github/workflows/deploy-dev-internal.yml`](../../.github/workflows/deploy-dev-internal.yml)
  — strip app-build steps; rename `deploy-infra-dev.yml`.
- `.github/workflows/cd.yml` — new file; mirrors `ci.yml` job style; OIDC
  into `pbmm-dev`.
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — unchanged.
- [`infra/modules/container-apps/main.tf`](../../infra/modules/container-apps/main.tf)
  — add explicit `lifecycle.ignore_changes`; switch to `azapi_resource` if
  the AVM wrapper blocks it.
- [`infra/main.tf` L421](../../infra/main.tf), [`infra/main.tf` L591](../../infra/main.tf)
  — placeholder bootstrap images stay (first-create only).
- [`infra/locals.tf` L81–L113](../../infra/locals.tf) —
  `api_environment_variables`, `api_secret_environment_variables`,
  `frontend_build_environment_variables` remain the single source of
  truth.
- [`infra/outputs.tf` L276, L285](../../infra/outputs.tf) —
  `frontend_build_env_vars` and `api_container_env_vars` consumed by CD.
- [`app/backend/src/index.ts` L204–L218](../../app/backend/src/index.ts)
  — startup migrations stay.
- [`app/backend/Dockerfile` L29](../../app/backend/Dockerfile) —
  `COPY migrations/` stays; CD still copies `infra/migrations` into the
  build context before `docker build`.
- `infra/scripts/*-rollback-*.ps1`,
  `infra/scripts/get-deployment-snapshot.ps1` — retire after Phase 3.

## Verification
1. After Phase 1: `terraform plan` against current dev tfstate shows zero
   diff on container-app `template` and `ingress.traffic_weight`.
2. After Phase 2: `az containerapp revision list --name ca-pronghorn-api
   --query "length(@)"` increments by exactly one per CD run (current
   runs can produce two).
3. API log line `Database migrations completed` (from
   [`index.ts` L212](../../app/backend/src/index.ts)) appears on the new
   revision before it serves traffic.
4. Promote `GITHUB_CLIENT_ID` to a Key Vault secret as a Phase 4 dry
   run; observe a Terraform-only diff, no CD changes.
5. Rollback drill:
   `az containerapp ingress traffic set --revision-weight
   <previous>=100 latest=0` flips traffic in seconds without any
   pipeline run.

## Scope notes
- Single-revision mode stays. Blue/green with labels is a follow-up; the
  `lifecycle.ignore_changes` changes here are the prerequisite.
- Container Apps Job for migrations is **not** in scope.
- `deploy.yml` (the pbmm / ACR-pool variant) is **not** in scope; port
  the pattern after dev-internal proves out.

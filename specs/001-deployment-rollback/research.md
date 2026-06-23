# Research: Deployment Rollback Controls

## Decision 1: Extend the existing deployment workflow instead of creating a separate rollback workflow

- **Decision**: Add rollback mode and rollback-specific inputs to
  `.github/workflows/deploy-to-azure.yml`, while moving rollback planning and
  execution logic into dedicated helper scripts under `infra/scripts/`.
- **Rationale**: The current deployment workflow already owns environment
  selection, Azure OIDC login, Terraform backend bootstrap, deployment staging,
  and job bundling for infrastructure, container apps, and AI models. Reusing
  that orchestration avoids drift between deployment and rollback contracts and
  satisfies the spec requirement to preserve current workflow inputs.
- **Alternatives considered**:
  - Create a separate `rollback-from-azure.yml` workflow: rejected because it
    would duplicate environment, auth, and component grouping logic.
  - Implement rollback only as local scripts: rejected because operators need a
    repeatable, auditable GitHub Actions path matching the deployed workflow.

## Decision 2: Persist immutable deployment snapshots and rollback execution records as workflow artifacts

- **Decision**: Capture a deployment snapshot during successful deploy runs and
  emit rollback plan and execution records as JSON artifacts plus job-summary
  output for each rollback run.
- **Rationale**: The current workflow does not persist enough immutable release
  metadata to safely reverse container images, AI deployment mutations, or
  targeted infrastructure state. Artifacts are low-friction, auditable, and do
  not require changing application data stores. They also avoid storing
  operational rollback state inside the runtime database.
- **Alternatives considered**:
  - Store rollback state in PostgreSQL: rejected because database rollback is a
    target of the feature and cannot be the trusted control plane for its own
    destructive reversal.
  - Rely only on Git history and Terraform state: rejected because container
    images and AI deployment mutations are not fully reconstructable from those
    sources alone.

## Decision 3: Model rollback by component-set strategies rather than a single generic reverse action

- **Decision**: Implement rollback through explicit component-set strategies:
  planning-only inspection, application runtime rollback, AI model rollback,
  and guarded infrastructure or database rollback.
- **Rationale**: The repo already deploys these areas differently. Container
  apps are updated via image pushes and Terraform apply, AI models are mutated
  by Azure CLI deployment commands, and infrastructure is governed by Terraform
  state and targeted module behavior. A single generic reverse command would be
  too coarse and unsafe.
- **Alternatives considered**:
  - Use blanket `terraform destroy` for all rollback: rejected because it would
    couple stateless and stateful resources, increase blast radius, and ignore
    non-Terraform resources like model deployments.
  - Use only Azure Portal or manual CLI guidance: rejected because the feature
    requires reproducible operator-controlled rollback inside the workflow.

## Decision 4: Require immutable identifiers for application-runtime rollback

- **Decision**: Promote image digests or immutable tags into deployment
  snapshots and use Container Apps revision history or prior image references as
  the rollback source for frontend and API runtime rollback.
- **Rationale**: The current workflow pushes images as `latest`, which is not a
  reliable rollback target. A safe stateless rollback path requires the prior
  deployable image reference or revision to be recoverable.
- **Alternatives considered**:
  - Rebuild an older commit on demand during rollback: rejected because it can
    reproduce different outputs and depends on external registries and build
    context remaining unchanged.
  - Roll back runtime only through Terraform variables: rejected because the
    workflow currently injects `latest` image values, which is insufficiently
    precise.

## Decision 5: Gate stateful rollback behind preflight checks and explicit destructive acknowledgement

- **Decision**: Database-related and foundational rollback paths must perform
  resource-state inspection before execution and must require an explicit
  acknowledgement token for destructive actions.
- **Rationale**: The feature spec explicitly calls out service-state and
  configuration prerequisites, such as PostgreSQL needing to be in an allowed
  state before delete or detach operations. This matches the repo's existing
  emphasis on prechecks, import recovery, and safe operational sequencing.
- **Alternatives considered**:
  - Allow stateful rollback with only a boolean confirmation: rejected because
    it provides weak protection against accidental environment teardown.
  - Disallow all database rollback: rejected because the spec requires guarded
    support rather than prohibition.

## Decision 6: Use Terraform module ownership as the baseline source for infrastructure rollback scope membership

- **Decision**: Derive infrastructure and database-related component membership
  from Terraform module ownership in `infra/main.tf`, then augment it with
  runtime-only resources handled by scripts and Azure CLI.
- **Rationale**: `infra/main.tf` already groups logging, ACR, Key Vault,
  storage, PostgreSQL, container apps, API Management, frontend, and AI
  Foundry resources. This is the safest baseline for dependency analysis and
  scope definitions.
- **Alternatives considered**:
  - Hardcode scope membership only in workflow YAML: rejected because it would
    drift from the Terraform source of truth.
  - Build scopes only from resource tags in Azure: rejected because the feature
    needs repo-owned determinism before contacting Azure.

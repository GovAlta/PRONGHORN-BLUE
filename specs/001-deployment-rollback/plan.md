# Implementation Plan: Deployment Rollback Controls

**Branch**: `001-deployment-rollback` | **Date**: 2026-03-27 | **Spec**: `specs/001-deployment-rollback/spec.md`
**Input**: Feature specification from `/specs/001-deployment-rollback/spec.md`

## Summary

Add rollback planning and execution controls to the existing Azure deployment
workflow so operators can select deployment component sets, inspect
dependencies and safeguards before execution, and perform targeted stateless
or guarded stateful rollback using the repo's current GitHub Actions,
Terraform, Azure CLI, and PowerShell automation paths.

The design keeps the current `deploy-to-azure.yml` workflow as the orchestration
surface, introduces explicit rollback mode and scope contracts, persists a
machine-readable deployment snapshot and rollback execution record, and routes
each rollback component set through a strategy appropriate to its risk profile:
read-only planning, container revision or image rollback, AI deployment
reconciliation, or guarded infrastructure and database reversal.

## Technical Context

**Language/Version**: GitHub Actions YAML, Bash on Ubuntu runners, PowerShell 7
helper scripts, Terraform 1.x, Node.js 20 build tooling  
**Primary Dependencies**: GitHub Actions `workflow_dispatch`, Azure Login
OIDC, Azure CLI, Terraform `azurerm` and `azapi` providers, PowerShell helper
scripts in `infra/scripts/`, Docker image build and push flow, Azure Container
Apps, Azure AI Services deployment commands  
**Storage**: Azure Storage-backed Terraform remote state, workflow artifacts and
job summaries for rollback snapshots and execution records, existing Azure
PostgreSQL environment as a managed rollback target rather than record store  
**Testing**: `terraform validate`, targeted workflow condition validation,
PowerShell script parameter and dry-run tests where feasible, frontend/API
build verification, JavaScript-based validation tests under
`infra/scripts/tests/`, and manual workflow-dispatch validation for protected
rollback paths  
**Target Platform**: GitHub-hosted Ubuntu runners operating against Azure dev,
test, and prod environments via OIDC and environment-scoped secrets  
**Project Type**: Brownfield CI/CD and infrastructure orchestration for a
TypeScript web platform with Terraform-managed Azure resources  
**Performance Goals**: Produce rollback plan output for a selected environment
and scope in under 5 minutes; add minimal latency to standard deployment paths
when rollback mode is not selected  
**Constraints**: Preserve existing deployment inputs and non-rollback behavior;
default rollback to plan-only inspection first; require immutable release
metadata before live rollback; never expose secrets in logs or artifacts; block
database and foundation teardown unless prechecks and acknowledgements pass;
support partially drifted environments  
**Scale/Scope**: One shared deployment workflow per environment; four primary
rollback component sets at minimum (infrastructure, database-related,
application runtime, AI models) with environment-specific dependency rules

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Contract Preservation**: PASS. The design keeps current workflow inputs for
  branch, environment, archetype, plan, and skip controls, and adds rollback
  inputs in a backward-compatible manner. Existing deployment dispatch remains
  valid when rollback mode is not selected.
- **Traceability**: PASS. User Story 1 maps to workflow input expansion,
  rollback planning scripts, and plan artifact generation; User Story 2 maps to
  application runtime and AI model rollback strategies; User Story 3 maps to
  guarded infrastructure and database prechecks, acknowledgements, and
  execution record paths.
- **Verification**: PASS. The implementation will require workflow-level
  condition validation, Terraform validation, build verification, and documented
  manual validation for stateless and blocked stateful rollback scenarios.
- **Security and Compliance**: PASS. Azure OIDC, existing environment-scoped
  secrets, and least-privilege CLI usage remain in place. Rollback artifacts
  must exclude secret values and only record resource metadata, execution
  outcomes, and operator acknowledgements.
- **Operability**: PASS. The design includes rollback planning mode, execution
  records, dependency-safe ordering, safe-stop behavior, and post-rollback
  validation expectations for each component set.

**Post-Design Re-check**: PASS. Research, contracts, data model, and quickstart
define the compatibility strategy, security model, operational rollback record,
and validation flow required by the constitution.

## Project Structure

### Documentation (this feature)

```text
specs/001-deployment-rollback/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── rollback-workflow-dispatch.md
│   └── rollback-record.schema.json
└── tasks.md
```

### Source Code (repository root)

```text
.github/
└── workflows/
    └── deploy-to-azure.yml

infra/
├── main.tf
├── outputs.tf
├── params/
│   └── dev.tfvars
└── scripts/
  ├── tests/
    ├── bootstrap-tfstate.ps1
    ├── deploy-containers.ps1
    ├── deploy-models.ps1
    ├── deploy.ps1
    ├── link-private-dns-zones.ps1
    └── validate-bastion-subnet.ps1

src/
├── components/
├── pages/
└── utils/

api/
└── src/
    ├── config/
    ├── middleware/
    ├── routes/
    └── utils/
```

**Structure Decision**: Treat this feature as workflow-and-infrastructure-first.
Primary implementation work will live in `.github/workflows/deploy-to-azure.yml`
and new or extended `infra/scripts/` helpers, with optional UI or API follow-on
work only if operators need surfaced rollback history inside the product later.
Rollback validation automation is expected to live under `infra/scripts/tests/`
and be runnable from root package scripts. Terraform files remain the source of
truth for infrastructure component-set membership and dependencies.

## Complexity Tracking

No constitution violations currently require justification.

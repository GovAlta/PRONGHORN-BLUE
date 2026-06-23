---
applyTo: ".github/workflows/**"
---

# CI/CD Layer — Pronghorn GitHub Actions

## Platform
- GitHub Actions on Ubuntu runners

## Existing Workflows
- `deploy-to-azure.yml` — Full IaC deployment with rollback support via workflow_dispatch. Inputs: operation (deploy/rollback-plan/rollback-execute), branch, environment, archetype, plan flag, rollback scopes.
- `deploy.yml` — Container image build via ACR dedicated agent pool + deploy to Azure Container Apps. Triggered by push to main or workflow_dispatch.

## Auth Pattern
- OIDC federated credentials for Azure login (preferred)
- Secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
- Fallback: `AZURE_CREDENTIALS` (service principal JSON)

## Patterns
- Preserve existing workflow_dispatch input contracts.
- Use ACR dedicated agent pool (`pronghorn-build-pool`) for container builds.
- Path-ignore `*.md`, `docs/**`, `.github/skills/**` for push triggers.
- Keep deployment workflows idempotent and rollback-capable (per 001-deployment-rollback spec).

## MCP Tools Available
- **GitHub MCP** (`actions` toolset): Monitor workflow runs, analyze build failures, trigger workflows, manage releases
- **Azure MCP**: Deployment best practices, resource validation

## External Skills Available
- `azure-deploy` — deployment execution and guidance
- `azure-diagnostics` — troubleshoot production issues, analyze logs
- `azure-validate` — pre/post deployment validation

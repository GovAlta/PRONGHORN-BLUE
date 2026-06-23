---
name: 23.deploy-via-workflow
description: Triggers the deploy-to-azure GitHub Actions workflow via workflow dispatch. Guides through environment and archetype selection matching the workflow's input contract.
argument-hint: Specify environment (dev, test, prod) and operation (deploy, rollback-plan, rollback-execute)
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Deploy via Workflow — GitHub Actions Dispatch

## Pre-requisites
- GitHub CLI (`gh`) installed and authenticated, OR GitHub MCP server connected
- Push access to the repository
- Azure OIDC federated credentials configured in GitHub Actions secrets

## Steps

1. **Select deployment parameters**:
   - **operation**: `deploy` | `rollback-plan` | `rollback-execute`
   - **branch**: target branch (e.g., `feature/iac-deployment-prestopa`)
   - **environment**: `dev` | `test` | `prod`
   - **archetype**: `online` (non-PBMM) | `corp` (PBMM)
   - **plan**: `true` for dry-run (terraform plan only), `false` for apply

2. **Trigger via GitHub MCP** (preferred):
   Use the GitHub MCP `actions` toolset to dispatch the workflow with the selected inputs.

3. **Trigger via GitHub CLI** (alternative):
   ```bash
   gh workflow run deploy-to-azure.yml \
     -f operation=deploy \
     -f branch=feature/iac-deployment-prestopa \
     -f environment=dev \
     -f archetype=online \
     -f plan=false
   ```

4. **Monitor the workflow run**:
   Use GitHub MCP or `gh run watch` to track progress.

## Validation
- Workflow run completes successfully (green check).
- Post-deployment: verify API health endpoint responds.
- Post-deployment: verify frontend is reachable.
- Use the `azure-diagnostics` external skill for troubleshooting if needed.

## Trigger
- After terraform plan review is approved.
- As part of the deployment agent workflow.

## Rollback
- Use operation `rollback-plan` to preview rollback scope.
- Use operation `rollback-execute` to perform rollback.
- See `specs/001-deployment-rollback/` for full rollback documentation.

## Ownership
- Infrastructure team / DevOps.

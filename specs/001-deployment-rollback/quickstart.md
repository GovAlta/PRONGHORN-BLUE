# Quickstart: Deployment Rollback Controls

## Goal

Validate that operators can inspect rollback scope membership, execute
stateless rollback safely, and observe blocked stateful rollback when
preconditions are not met.

## Prerequisites

1. Use an environment with an existing successful deployment snapshot.
2. Ensure the GitHub Environment contains the current Azure OIDC variables and
   Terraform backend variables used by `deploy-to-azure.yml`.
3. Ensure a known-good application runtime image or container revision is
   available for the selected snapshot.

## Scenario 1: Generate a rollback plan

1. Dispatch `.github/workflows/deploy-to-azure.yml` with:
   - `operation=rollback-plan`
   - `environment=dev`
   - `rollback_snapshot=latest` or `rollback_snapshot=<workflow-run-id>`
   - `rollback_scopes=application-runtime,ai-models`
2. Confirm the workflow produces `rollback-plan.json`.
3. Confirm the job summary lists:
   - included scopes
   - excluded scopes
   - dependency-safe step ordering
   - any blocked checks or acknowledgement requirements

## Scenario 2: Execute stateless rollback

1. Dispatch `.github/workflows/deploy-to-azure.yml` with:
   - `operation=rollback-execute`
   - `environment=dev`
   - `rollback_snapshot=latest`
   - `rollback_scopes=application-runtime`
2. Confirm the workflow reverts frontend and API runtime references without
   changing infrastructure or database resources.
3. Confirm `rollback-execution.json` records completed steps and post-validation
   for the runtime scope.

## Scenario 3: Execute AI model rollback

1. Dispatch `.github/workflows/deploy-to-azure.yml` with:
   - `operation=rollback-execute`
   - `environment=dev`
   - `rollback_snapshot=latest`
   - `rollback_scopes=ai-models`
2. Confirm only AI deployment reconciliation steps run.
3. Confirm application runtime and infrastructure scopes are listed as excluded.

## Scenario 4: Verify blocked database rollback

1. Dispatch `.github/workflows/deploy-to-azure.yml` with:
   - `operation=rollback-execute`
   - `environment=dev`
   - `rollback_snapshot=latest`
   - `rollback_scopes=database`
   - `rollback_allow_destructive=true`
   - omit or intentionally mismatch `rollback_ack_token`
2. Confirm execution stops before destructive actions.
3. Confirm the job summary and `rollback-plan.json` explain which precondition
   or acknowledgement requirement blocked the run.

## Expected Validation Signals

- `terraform validate` passes for infrastructure changes.
- `npm run test:rollback` passes locally before workflow execution.
- Existing non-rollback deploy mode still works with no new required inputs.
- Runtime rollback does not mutate unselected scopes.
- Destructive scopes cannot run without explicit acknowledgement and passing
  preflight checks.

## Local Validation

1. Run `npm run test:rollback` from the repository root.
2. Review generated workflow artifacts:
   - `deployment-snapshot-<environment>`
   - `rollback-plan-<environment>-<run-id>`
   - `rollback-execution-<environment>-<run-id>`
3. For destructive scopes, verify that the rollback plan lists explicit
   acknowledgement requirements before dispatching `rollback-execute`.

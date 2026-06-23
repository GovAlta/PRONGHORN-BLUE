# Contract: Rollback Workflow Dispatch

## Purpose

Define the backward-compatible `workflow_dispatch` interface for
`.github/workflows/deploy-to-azure.yml` after rollback support is added.

## Existing Inputs Preserved

These inputs remain valid and keep their current meaning when rollback mode is
not selected:

- `branch`
- `environment`
- `archetype`
- `plan`
- `skip_infra`
- `skip_build`
- `skip_container_apps`
- `deploy_ai_models`
- `private_dns_source_subscription_id`
- `private_dns_source_resource_group`
- `target_private_dns_vnet_name`
- `target_private_dns_vnet_resource_group`
- `debug_logging`

## New Inputs

| Input | Type | Required | Allowed Values | Description |
| --- | --- | --- | --- | --- |
| `operation` | choice | yes | `deploy`, `rollback-plan`, `rollback-execute` | Selects normal deployment, read-only rollback planning, or live rollback execution. Default is `deploy`. |
| `rollback_snapshot` | string | conditional | snapshot identifier or workflow run reference | Snapshot or successful run to roll back to. Required for rollback modes. |
| `rollback_scopes` | choice | conditional | preset scope combinations | A drop-down of one or more comma-separated scope IDs drawn from `infrastructure`, `database`, `application-runtime`, and `ai-models`. Required for rollback modes. |
| `rollback_allow_destructive` | boolean | conditional | `true`, `false` | Indicates whether destructive scopes may be considered during execution. |
| `rollback_ack_token` | string | conditional | exact confirmation text | Required when any selected scope is destructive or stateful. |

## Validation Rules

1. `operation=deploy` MUST ignore rollback-only inputs.
2. `operation=rollback-plan` MUST require `rollback_snapshot` and
   `rollback_scopes` and MUST NOT execute destructive steps.
3. `operation=rollback-execute` MUST require `rollback_snapshot` and
   `rollback_scopes` and MUST fail early if preflight checks block execution.
4. Selecting `database` or `infrastructure` in `rollback_scopes` MUST require
   `rollback_allow_destructive=true` and a non-empty `rollback_ack_token`.
5. `rollback_scopes` MUST be normalized to known scope keys before workflow
   branching begins.

## Contracted Outputs

Rollback-capable runs MUST publish or emit:

- `rollback-plan.json`: resolved scopes, excluded scopes, dependency order,
  preflight results, and safe-stop strategy
- `rollback-execution.json`: per-step execution record for live runs
- job summary text that lists selected scopes, blocked checks, and follow-up
  actions

## Compatibility Guarantee

Existing deployment dispatchers that call the workflow with current inputs only
must continue to execute the current deployment path without requiring any new
values.

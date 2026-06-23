# Contract — Deployment Service HTTP API

**Feature**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)

This document records the request and response contracts for every action
handled by `handleDeploymentService` in [functions.ts](../../../app/backend/src/routes/functions.ts)
after the cutover. The endpoint URL, auth middleware, and request body
top-level shape are **preserved** (CR-001); only the action implementations
change.

## Endpoint

```
POST  /api/v1/cloud-deployment           (mounted under existing path)
Auth: existing auth middleware (unchanged)
Content-Type: application/json
```

## Common request envelope (unchanged — CR-001)

```jsonc
{
  "action":       "create|deploy|destroy|status|logs|getEvents|getEnvVars|updateEnvVars|syncEnvVars|updateServiceConfig|start|stop|restart",
  "deploymentId": "uuid",
  "shareToken":   "string | null",
  "envVars":      { "KEY": "value" }, // updateEnvVars/syncEnvVars only
  "newEnvVars":   { "KEY": "value" }, // syncEnvVars only
  "keysToDelete": ["KEY"],            // syncEnvVars only
  "clearExisting": true               // syncEnvVars only
}
```

`updateServiceConfig` adds (FR-010, FR-011):

```jsonc
{
  "action": "updateServiceConfig",
  "deploymentId": "uuid",
  "shareToken": "string | null",
  "config": {
    "run_command":     "string | null",
    "build_command":   "string | null",
    "install_command": "string | null",
    "dockerfile_path": "string | null",
    "branch":          "string | null",
    "run_folder":      "string | null",
    "build_folder":    "string | null"
  }
}
```

Env-var fields in the `updateServiceConfig` request are **rejected with 400**
(FR-011).

## Response envelope (unchanged — CR-001)

```jsonc
{ "success": true,  "data":  { /* per-action */ } }
{ "success": false, "error": "string" }
```

## Per-action contracts

### `create`

- **Preconditions**: deployment row exists; project has a connected GitHub
  repository; `resolveGitHubToken({ userId })` yields a token.
- **Behaviour** (FR-001, FR-002, FR-005, US1 AS1):
  1. Compute `{ appName, resourceGroup }` via `computeGenappResourceNames`.
  2. Persist `status='pending'`, `dispatched_by_user_id`, `dispatched_at`,
     `azure_container_app_name`, `azure_resource_group`.
  3. Push Terraform templates to the user repo (existing
     `pushTerraformTemplates`).
  4. Dispatch the workflow with `action='create'`.
  5. Persist `workflow_run_id` (may be `0`/null if GitHub didn't return it
     — the poller resolves it later).
  6. Broadcast `{ action: 'created' }` on `deployments-{projectId}`.
- **Response**: `202 { success: true, data: { status: 'pending', workflowRunId } }`
- **Errors**:
  - `404` deployment not found / access denied.
  - `502 { success: false, error }` if dispatch HTTP fails. Row marked
    `failed`, `last_failure_cause = 'dispatch-http-<status>: …'`, broadcast.

### `deploy`

- **Preconditions**: deployment row exists.
- **Idempotency / concurrency** (FR-009, US5):
  - If `status ∈ {pending, building, deploying}` → return `409 { success:
    false, error: 'Deployment already in progress' }`. No state change.
  - If `status === 'failed'` → clear `last_failure_cause`,
    `workflow_run_url`, `workflow_run_id`, `url`, then proceed.
  - If `status === 'running'` → proceed (redeploy).
  - If `status === 'deleted'` → proceed (creates a fresh resource group,
    orphan trade-off per CR-003).
- **Behaviour** (FR-001, FR-002, FR-004, FR-005, US1, US4 AS1, US4 AS2):
  1. Compute names (idempotent; preserves existing names when present).
  2. Run pre-deploy auto-push (committed blob store → user repo). On
     failure → row marked `failed`, `last_failure_cause =
     'pre-push-failed: …'`, broadcast, return `502`.
  3. Persist `status='pending'`, `dispatched_by_user_id`, `dispatched_at`,
     resource names.
  4. Dispatch the workflow with `action='deploy'` (`runs/dispatches`).
  5. Persist returned `workflow_run_id` (or null).
  6. Broadcast `{ action: 'status_updated' }`.
- **Response**: `202 { success: true, data: { status: 'pending', workflowRunId } }`
- **Errors**: same as `create`.

### `destroy`

- **Preconditions**: deployment row exists; `azure_container_app_name` is
  set (otherwise nothing to destroy — return `200 { success: true, data: {
  status: 'deleted' } }` and mark `status='deleted'` directly).
- **Idempotency / concurrency**: same 409 rule as `deploy` for transitional
  rows; `failed` rows accept `destroy` and clear failure attributes
  (FR-018, US6 AS2). `deleted` rows reject with `409`.
- **Behaviour** (FR-001, FR-018, US2):
  1. Persist `dispatched_by_user_id`, `dispatched_at`.
  2. Dispatch the workflow with `action='destroy'`.
  3. Persist `workflow_run_id`.
  4. Broadcast `{ action: 'status_updated' }`.
  5. Row stays `pending`/`building` until the poller observes
     conclusion=success → `deleted` or conclusion=failure → `failed` with
     `last_failure_cause='workflow-conclusion-failure-destroy'`.
- **Response**: `202 { success: true, data: { status: 'pending', workflowRunId } }`

### `status`

- **Behaviour**: unchanged from current code path — routes through
  `pollWorkflowStatus` when `workflow_run_id` is set; returns the latest
  observed status to the caller. The server-side poller does the same job
  in the background.
- **Response**: `200 { success: true, data: { status, url, workflowRunId } }`

### `updateServiceConfig` (FR-010, FR-011, US3)

- **Behaviour**:
  1. Validate that the request `config` object contains only the seven
     allowed keys. Reject anything else with `400 { success: false, error:
     'unsupported config field: <key>' }`.
  2. `UPDATE project_deployments SET run_command = COALESCE($1,
     run_command), … updated_at = NOW() WHERE id = $deploymentId`.
  3. Broadcast `{ action: 'config_updated' }`.
- **Response**: `200 { success: true, data: { id, ...persistedConfig } }`
- **No Azure call. No workflow dispatch.**

### `start` / `stop` / `restart` (FR-014)

- **Behaviour**: relocated unchanged. Still hit Azure Container Apps REST
  API directly. Out of scope for this feature beyond the relocation.

### `logs` / `getEvents` / `getEnvVars` / `updateEnvVars` / `syncEnvVars`

- **Behaviour**: relocated unchanged. Existing functionality preserved.

## Broadcast contract (unchanged channel — CR-002)

Channel: `deployments-{projectId}`
Event:   `deployment_refresh`
Payload (extended with new `action` values; existing values unchanged):

```jsonc
{
  "action": "created" | "status_updated" | "config_updated" | "deleted",
  "deploymentId": "uuid",
  "status":  "pending|building|deploying|running|failed|deleted",  // when action='status_updated' or 'created'
  "url":     "string | null"                                       // when action='status_updated' and url just resolved
}
```

See [deployment-ws-events.md](./deployment-ws-events.md) for the WebSocket
event contract.

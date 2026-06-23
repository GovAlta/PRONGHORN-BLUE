# Phase 1 — Data Model

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

## Schema changes

### Migration: `infra/migrations/008_deployment_dispatch_columns.sql`

```sql
-- Migration: Add dispatch-side columns to project_deployments
-- Date: 2026-05-28
-- Purpose: Support the genapp-workflow cutover (spec 006) — server-side
-- polling, multi-replica safety, retry-from-failed, and failure surfacing.

ALTER TABLE project_deployments
  ADD COLUMN IF NOT EXISTS dispatched_by_user_id uuid
    REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dispatched_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_failure_cause text,
  ADD COLUMN IF NOT EXISTS workflow_run_url   text;

-- Partial index supporting the poller's transitional-row scan.
-- The poller selects rows where status is in the transitional set; this
-- index keeps that scan cheap regardless of total table size.
CREATE INDEX IF NOT EXISTS idx_deployments_in_flight
  ON project_deployments (dispatched_at)
  WHERE status IN ('pending', 'building', 'deploying');

COMMENT ON COLUMN project_deployments.dispatched_by_user_id IS
  'Pronghorn user who initiated the most recent dispatch. Used by the poller to resolve a GitHub token via resolveGitHubToken. NULL when the user has been deleted; the poller then falls through to the system PAT.';

COMMENT ON COLUMN project_deployments.dispatched_at IS
  'Wall-clock timestamp of the most recent workflow dispatch. Anchor for the stall-window check (default 30 min, see spec FR-007 / SC-004).';

COMMENT ON COLUMN project_deployments.last_failure_cause IS
  'Free-text tag describing the most recent failure (e.g., pre-push-failed, dispatch-http-<status>, stall-window-exceeded, workflow-conclusion-failure). Cleared when a new deploy moves the row out of failed.';

COMMENT ON COLUMN project_deployments.workflow_run_url IS
  'GitHub Actions run URL captured when a workflow concludes (success or failure). Surfaced in the UI for operator debugging.';
```

**Reversibility**: All columns and the index are additive with
`IF NOT EXISTS`. Reverting the feature PR leaves the columns in place
unused; an optional `006/...` cleanup migration could DROP them later. Per
CR-005 the cutover is a single PR; no rollback migration is required for
this feature.

### Columns already present (no change)

The following columns already exist on `project_deployments` and are reused
by this feature without modification:

| Column | Source migration | Used for |
|---|---|---|
| `id uuid` | base schema | row identity; also the advisory-lock key source |
| `project_id uuid` | base schema | WebSocket channel scoping (`deployments-{projectId}`) |
| `status text` | base schema | state machine (see below) |
| `url text` | base schema | running URL when workflow concludes success |
| `azure_container_app_name text` | [004](../../infra/migrations/004_azure_deployment_columns.sql) | workflow-scheme name persisted at dispatch |
| `azure_resource_group text` | [004](../../infra/migrations/004_azure_deployment_columns.sql) | workflow-scheme RG persisted at dispatch |
| `workflow_run_id bigint` | [006](../../infra/migrations/006_deployment_workflow_columns.sql) | GitHub Actions run id for status polling |
| `terraform_state_key text` | [006](../../infra/migrations/006_deployment_workflow_columns.sql) | unchanged; written by the workflow itself |
| `created_at`, `updated_at` | base schema | unchanged |

## Entities

### DeploymentRow (read model used inside the new service module)

```ts
export interface DeploymentRow {
  id: string;
  project_id: string;
  status: DeploymentStatus;
  url: string | null;
  azure_container_app_name: string | null;
  azure_resource_group: string | null;
  workflow_run_id: number | null;
  workflow_run_url: string | null;
  dispatched_by_user_id: string | null;
  dispatched_at: string | null;      // ISO timestamp
  last_failure_cause: string | null;
  // Editable service-config fields (FR-010):
  run_command: string | null;
  build_command: string | null;
  install_command: string | null;
  dockerfile_path: string | null;
  branch: string | null;
  run_folder: string | null;
  build_folder: string | null;
  created_at: string;
  updated_at: string;
}
```

The row is loaded via the existing `rpc.getDeploymentWithSecretsWithToken`
helper; no new RPC helper is introduced. Writes go through a new
`updateDeploymentRow(id, patch)` thin wrapper around `db.query` that the new
service module owns.

### DeploymentStatus (FR-016)

```ts
export type DeploymentStatus =
  | 'pending'    // transitional — dispatched but not yet observed in GitHub Actions
  | 'building'   // transitional — workflow run in progress
  | 'deploying'  // transitional — reserved; treated identically to 'building' today
  | 'running'    // terminal     — workflow concluded success, running URL resolved
  | 'failed'     // terminal     — terminal failure (deploy or destroy)
  | 'deleted';   // terminal     — post-successful-destroy

export const TRANSITIONAL: ReadonlySet<DeploymentStatus> =
  new Set(['pending', 'building', 'deploying']);

export const TERMINAL: ReadonlySet<DeploymentStatus> =
  new Set(['running', 'failed', 'deleted']);

export const isTransitional = (s: DeploymentStatus | string): boolean =>
  TRANSITIONAL.has(s as DeploymentStatus);
```

### LastFailureCause taxonomy (free text, but documented)

| Tag | Emitted by | Notes |
|---|---|---|
| `pre-push-failed: <message>` | `actions/deploy.ts` when the pre-deploy auto-push throws | FR-004; do **not** dispatch the workflow |
| `dispatch-http-<status>: <message>` | `actions/{create,deploy,destroy}.ts` when `dispatchGenappWorkflow` throws | FR-008 / US4 AS2 |
| `stall-window-exceeded` | `poller.ts` when `NOW() - dispatched_at > stallWindow` and status still transitional | FR-007 / SC-004 |
| `workflow-conclusion-failure` | `poller.ts` when `pollWorkflowStatus` returns `status === 'failed'` | FR-008 / US4 AS4 |
| `workflow-conclusion-failure-destroy` | same, for destroy runs | FR-018 / US6 AS1 |
| `no-github-token` | poller when `resolveGitHubToken` yields null *and* the row has been transitional long enough that no-poll would otherwise hide the issue | Logged at warn; only written when stall-window also exceeded |

The taxonomy is **descriptive, not validated**. The `last_failure_cause`
column is plain text so operators can read it in `psql` and the values are
not coerced. Tests only assert prefix matches (e.g., `startsWith('dispatch-
http-')`).

## State machine (FR-009, FR-016, FR-017, FR-018)

```text
                 deploy / create (any non-transitional state)
                     │
                     ▼
[any non-trans] ─► pending ──observe run──► building/deploying ─┬─► running    (terminal: success)
                                                                ├─► failed     (workflow conclusion failure)
                                                                └─► failed     (stall window exceeded)

pending|building|deploying ── second deploy request ──► 409 (no change)

failed     ── deploy ──► pending  (clears last_failure_cause + workflow_run_url + workflow_run_id; sets dispatched_at = NOW())
running    ── deploy ──► pending  (re-deploy)
running    ── destroy ──► pending (with destroy intent)
deleted    ── deploy ──► pending  (creates a fresh deployment under the workflow naming scheme — orphan trade-off accepted, CR-003)
failed     ── destroy ──► pending (with destroy intent; FR-018)
deleted    ── destroy ──► 409     (cannot re-destroy a deleted row)
```

### Transition table — guard, action, postcondition

| From | Event | Guard | Action | To | Notes |
|---|---|---|---|---|---|
| any non-transitional | `create` request | none | compute names; push templates; dispatch `action=create`; persist run id, names, dispatcher, dispatched_at | `pending` | US1 AS1 |
| `pending`, `building`, `deploying` | any `deploy`/`destroy`/`create` request | already transitional | reject 409 | — | FR-009, US5 AS1 |
| `failed` | `deploy` request | none | clear `last_failure_cause`, `workflow_run_url`, `workflow_run_id`, `url`; pre-push; dispatch `action=deploy`; persist new dispatch fields | `pending` → `building` | FR-009 second sentence, US5 AS2 |
| `running` | `deploy` request | none | pre-push; dispatch `action=deploy`; persist new dispatch fields (preserve `azure_container_app_name`, `azure_resource_group`) | `pending` → `building` | redeploy of a healthy app |
| `running` | `destroy` request | none | dispatch `action=destroy`; persist dispatcher and dispatched_at | `pending` → `building` → `deleted` (on success) | US2 |
| `failed` | `destroy` request | row has `azure_container_app_name` | dispatch `action=destroy`; preserve names; clear `last_failure_cause` | `pending` → `building` → `deleted` (on success) | FR-018, US6 AS2 |
| `pending`, `building`, `deploying` | poller tick, advisory lock acquired, conclusion observed | none | call `pollWorkflowStatus`; map to `running`/`failed`; persist; broadcast | `running` or `failed` | US1 AS2, US4 AS4 |
| `pending`, `building`, `deploying` | poller tick, conclusion not observed, `NOW() - dispatched_at > stallWindow` | stall exceeded | persist `failed`, `last_failure_cause = 'stall-window-exceeded'`; broadcast | `failed` | FR-007, SC-004 |
| `pending`, `building`, `deploying` | poller tick, advisory lock NOT acquired | another replica holds it | no-op | — | FR-017, SC-008 |
| `pending`, `building`, `deploying` | poller tick, `resolveGitHubToken` returns null | dispatched_at within stall window | log warn, skip tick | — | edge case |

### Advisory-lock procedure (FR-017)

For each row selected by the transitional-status scan, the poller runs a
short transaction:

```sql
BEGIN;
SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS got;
-- if got = false → COMMIT (release tx, skip row)
-- if got = true  → SELECT … workflow conclusion … UPDATE project_deployments
COMMIT;
```

The lock key is the deployment row UUID hashed to a `bigint` via
`hashtextextended` (built into PostgreSQL 16). Transactional variant
auto-releases on COMMIT/ROLLBACK; no explicit unlock required.

## Validation rules (data-level)

- `status` is constrained at the application layer to one of the six
  enum values; the DB column remains plain `text` to avoid an enum-type
  migration this feature does not require.
- `workflow_run_id` MAY be `NULL` immediately after dispatch when GitHub
  did not return a correlatable run id; the poller resolves it on first
  tick using `findWorkflowRunByAppId` (research D-2).
- `azure_container_app_name` and `azure_resource_group` MUST be present
  before a workflow is dispatched (FR-002). The new service module
  computes both via `computeGenappResourceNames` before the dispatch HTTP
  call.
- `dispatched_by_user_id` MAY be `NULL` after the dispatching user is
  deleted; the poller's token resolution falls through the
  `resolveGitHubToken` chain naturally.
- `last_failure_cause` and `workflow_run_url` are **always cleared** when
  the row transitions out of `failed` via a new deploy (US5 AS2).

## Relationships (unchanged by this feature)

- `project_deployments.project_id → projects.id` (existing)
- `project_deployments.dispatched_by_user_id → users.id` (new,
  `ON DELETE SET NULL`)

No other foreign keys touch the new columns.

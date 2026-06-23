# Phase 0 — Research and Decisions

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Scope of this document

Every NEEDS CLARIFICATION on the plan template has been resolved by the spec's
Clarifications session (2026-05-28). This document records the technical
decisions that flow from those clarifications, plus the small number of
implementation choices that arose during research.

## Resolved unknowns from the spec

| Topic | Decision | Source |
|---|---|---|
| Multi-replica poller safety | Per-row `pg_try_advisory_lock(deployment_row_id)` per tick; second replica skips | Spec Clarifications #1, FR-017, SC-008 |
| Retry from `failed` state | Same `deploy` action transitions `failed → building`, clears prior failure | Spec Clarifications #2, FR-009, US5 AS2 |
| Destroy failure handling | Row stays `failed` with run URL + cause; idempotent re-issue | Spec Clarifications #3, FR-018, US6 |
| Token resolution at poll time | `resolveGitHubToken({ userId: dispatched_by_user_id })` per tick; falls through chain naturally | Spec Clarifications #4, FR-012, CR-007 |
| Status enum & transitional set | `{pending, building, deploying, running, failed, deleted}`; transitional = `{pending, building, deploying}` | Spec Clarifications #5, FR-016 |
| `updateServiceConfig` scope | Non-env fields only | Spec FR-010, FR-011 |
| Backfill of legacy rows | Out of scope; orphan trade-off accepted | Spec CR-003 |
| Cutover strategy | Single commit, manual pre-merge smoke, no flag | Spec CR-005, FR-013 |

## Decisions discovered during research

### D-1 — `dispatched_at` column for stall-window math

**Decision**: Add a `dispatched_at timestamptz NOT NULL DEFAULT NOW()` column
to `project_deployments` in the new migration, in addition to the columns
already implied by the spec (`dispatched_by_user_id`, `last_failure_cause`,
`workflow_run_url`).

**Rationale**: FR-007 and SC-004 require failing a row whose workflow run
never reaches a terminal state within the stall window. Computing
"in-flight for > 30 min" needs a known dispatch timestamp. The existing
`updated_at` is rewritten on every poller tick and therefore cannot serve as
the stall-window anchor. Cheapest correct solution is a dedicated column.

**Alternatives considered**:
- Reuse `created_at` — wrong, because the same row gets re-dispatched on
  retry-from-failed (US5 AS2) and retry-from-deleted-by-Azure scenarios.
- Reuse `updated_at` — wrong because the poller writes to it on every tick.
- Store on the GitHub run only — impossible to compute until we observe the
  run, defeating the purpose for the dispatched-but-unobservable case.

### D-2 — Run-id correlation when dispatch does not return a run id

**Decision**: Keep the existing post-dispatch poll-by-app_id strategy now
housed in `services/deployment/docker/genappWorkflowClient.ts`
(`findWorkflowRunByAppId`, relocated per [D-11](#d-11--relocate-utilsgenappdeployts-into-the-docker-module))
for the synchronous post-dispatch lookup. When that helper returns `0`,
persist `workflow_run_id = NULL` plus `dispatched_at = NOW()` and let the
poller resolve the run id on a later tick (the poller's first tick for a
row whose run_id is null re-runs `findWorkflowRunByAppId` filtered by
app_id and a `created>since` window anchored at `dispatched_at - 60s`).

**Rationale**: The existing helper is already a known-good correlation
strategy. Persisting `dispatched_at` (D-1) gives the poller a stable anchor
to re-query GitHub when the dispatch response is empty. Avoids a separate
polling state machine for the "no run id yet" case.

**Alternatives considered**:
- Block the API response until run id resolves — adds variable latency
  (currently `await new Promise(r => setTimeout(r, 3000))` in
  `dispatchGenappWorkflow`); not viable inside the API request.
- Use the in-workflow `runs/<id>/jobs` endpoint to match by `app_id` input —
  more accurate but requires changing the workflow to emit identifying job
  names; CR (no workflow change in this feature) rules it out.

### D-3 — Advisory-lock key derivation

**Decision**: Derive the `bigint` lock key from the deployment row UUID via
`hashtextextended(deployment_id::text, 0)::bigint`. Acquire with
`pg_try_advisory_xact_lock` inside the per-row transaction; release happens
automatically at transaction end.

**Rationale**: UUIDs don't fit a bigint. `hashtextextended` is deterministic
across replicas, collision-resistant enough at this scale (tens of
in-flight rows), and ships with PostgreSQL 16 (in scope per the local-dev
Docker compose, which pins `postgres:16-alpine`). The transactional variant
removes the need for explicit `pg_advisory_unlock` and is safe under
exceptions.

**Alternatives considered**:
- A small `deployment_poller_locks` table with `FOR UPDATE SKIP LOCKED` —
  works but adds a table for a problem the built-in primitive solves.
- A row-level `SELECT ... FOR UPDATE NOWAIT` directly on
  `project_deployments` — would also work but couples lock duration to the
  whole tick, blocking innocent reads from other code paths.

### D-4 — Poller startup and shutdown

**Decision**: Start the poller from [app/backend/src/index.ts](../../app/backend/src/index.ts)
immediately after `app.listen(...)` resolves, gated by
`process.env.NODE_ENV !== 'test'`. Expose a `stopDockerDeploymentPoller()`
function and wire it into the existing SIGTERM handler so the interval does
not outlive a graceful shutdown. Default interval: 15 s. Default stall
window: 30 min. Both configurable via constructor arguments (not env vars,
to keep CR-007's no-new-env-vars discipline; an env var can be added later
if operators ask).

**Rationale**: Matches the deferred-poller pattern requested in the original
analysis doc. The NODE_ENV gate prevents Jest from holding the loop alive.

### D-5 — Action map vs. switch

**Decision**: Use a const `actions` record keyed by action name, each value
an `async (ctx) => Response` function, in `dockerDeploymentService.ts`. The
entry point does `const handler = actions[action] ?? unknownAction; return
handler(ctx)`. No `switch` statement.

**Rationale**: Keeps each action body in its own small file (per the user's
anti-monolith directive). The record is the explicit registry; the
typescript `keyof typeof actions` then types `DockerDeploymentAction`
without a separate union literal. Adding a new action means adding a file
and one entry to the map.

**Alternatives considered**:
- One big `switch` in the new file — reproduces the monolith problem at a
  smaller scale.
- Class with methods named by action — invites action methods drifting from
  the on-wire action names.

### D-6 — Frontend status component change

**Decision**: One-line extension of `isTransitionalStatus` in
[DeploymentCard.tsx](../../app/frontend/src/components/deploy/DeploymentCard.tsx)
and [DeploymentLogsDialog.tsx](../../app/frontend/src/components/deploy/DeploymentLogsDialog.tsx)
to include `'pending'`. `statusConfig` already renders all six enum values.
No layout, navigation, modal, or component-positioning change. Existing
10-second safety poll continues to act as the fallback when the WebSocket
event is missed.

**Rationale**: Constitution VI; the existing UI already covers the visual
states.

### D-7 — Pre-deploy auto-push location

**Decision**: The pre-deploy GitHub commit (committed blob store → user
repo) lives in [actions/deploy.ts](../../app/backend/src/services/deployment/docker/actions/deploy.ts)
and runs **before** `dispatchGenappWorkflow`. The deploy action wraps the
push in a try/catch; failure marks the row `failed` with `last_failure_cause
= 'pre-push-failed: <message>'`, broadcasts a `deployment_refresh`, and
returns `502` without dispatching the workflow (FR-004).

**Rationale**: Matches the original analysis doc's intent (the workflow
checks out the user repo, so source must land first) and the spec's
US4 AS1. Keeping the push inside the action keeps the failure handling
co-located with the dispatch call.

### D-8 — Resource names format (typescript implementation of the bash)

**Decision**: `computeGenappResourceNames({ appName, appId, environment })`
returns `{ appName: string; resourceGroup: string }`. Implementation:

```ts
const APP_NAME_RAW = String(appName).toLowerCase();
const APP_NAME_SAFE = APP_NAME_RAW.replace(/[^a-z0-9-]/g, '').slice(0, 32);
const APP_ID_SHORT  = String(appId).replace(/-/g, '').slice(0, 8);
const ENV_NAME      = String(environment);
return {
  appName: `${ENV_NAME}-${APP_NAME_SAFE}-${APP_ID_SHORT}`,
  resourceGroup: `rg-genapp-${APP_NAME_SAFE}-${APP_ID_SHORT}-${ENV_NAME}`,
};
```

Validated by Jest tests against ~10 representative inputs (length cap at
33, all-hyphens-after-strip, leading/trailing hyphens, mixed case, unicode
characters, uppercase GUIDs, 8-char-or-shorter app ids, empty environment).

**Rationale**: Byte-for-byte equivalent of the bash in `genapp-deploy.yml`
lines 234–237. The user opted for TypeScript-only parity tests (spec
Clarifications, naming-tests question).

### D-9 — Re-using `pollWorkflowStatus`

**Decision**: The new poller calls `pollWorkflowStatus` from the relocated
`services/deployment/docker/genappWorkflowClient.ts` (was
`utils/genappDeploy.ts`; see [D-11](#d-11--relocate-utilsgenappdeployts-into-the-docker-module))
with no behavior change. The poller's responsibilities are limited to:
select rows, acquire lock, resolve token, call `pollWorkflowStatus`,
decide transition via `statusMachine`, persist, broadcast.

**Rationale**: `pollWorkflowStatus` already handles status mapping and FQDN
fetch on success. Re-implementing it would risk drift. The poller adds the
multi-replica safety and stall-window logic that `pollWorkflowStatus` does
not own.

### D-10 — Deleting `routes/deployment.ts` and its test

**Decision**: Remove [app/backend/src/routes/deployment.ts](../../app/backend/src/routes/deployment.ts),
its mount in [routes/v1/index.ts](../../app/backend/src/routes/v1/index.ts)
(`router.use('/deployment', authMiddleware, deploymentRouter);`), and
[app/backend/src/__tests__/routes/deployment.test.ts](../../app/backend/src/__tests__/routes/deployment.test.ts).
The legacy `deployments` table the router operates on is left in place
(no DROP migration; the table is unused and dropping it is out of scope).

**Rationale**: CR-004. Confirmed via search that no frontend code calls
`/api/v1/deployment*`; all deployment traffic flows through the Edge
Function path that lands in `handleDeploymentService` in `functions.ts`.
Dropping the unused table is a separate cleanup that does not gate this
feature.

### D-11 — Relocate `utils/genappDeploy.ts` into the docker module

**Decision**: Move
[app/backend/src/utils/genappDeploy.ts](../../app/backend/src/utils/genappDeploy.ts)
(468 lines, three exported functions, three type exports) to
`app/backend/src/services/deployment/docker/genappWorkflowClient.ts`.
During the move:

1. Delete the file's local `DeploymentStatus` union; re-export the single
   definition from `./types.ts` (which is also consumed by
   `statusMachine.ts`, `poller.ts`, and every `actions/*.ts`). This
   removes a two-source-of-truth drift risk for the status enum (see
   [D-1](#d-1--dispatched_at-column-for-stall-window-math) for the related
   schema additions).
2. Tighten `GenappWorkflowParams.action` to `DockerDeploymentAction`
   (imported from `./types.ts`) instead of the inline `"create" | "deploy" | "destroy"` literal.
3. Keep `pushTerraformTemplates`, `dispatchGenappWorkflow`, and
   `pollWorkflowStatus` co-located in the one file — they share
   `gitHubApiFetch` plumbing and the workflow-name string `genapp-deploy.yml`
   is the single coupling point.
4. Update the lone call site
   ([functions.ts:28](../../app/backend/src/routes/functions.ts)) to import
   from the new path; this import goes away entirely once the
   `handleDeploymentService` cases are deleted under the action-extraction
   work.

**Rationale**: The `utils/` label is aspirational — there is exactly one
caller. Three concrete signals show the module is docker-specific, not
reusable infrastructure:

- `GenappWorkflowParams.action: "create" | "deploy" | "destroy"` is the
  docker action vocabulary, baked into the type. A future archetype
  (serverless, static) would not share these verbs.
- `DeploymentStatus` already overlaps the enum planned for
  `services/deployment/docker/types.ts`; keeping two definitions invites
  drift.
- `pollWorkflowStatus` reaches into the workflow run **name** to extract
  `azure_container_app_name` via
  `name.includes('Container App: <name>')` — that string is produced by
  [.github/workflows/genapp-deploy.yml](../../.github/workflows/genapp-deploy.yml)
  ~L237. It is coupled to one workflow file, not "any GitHub Actions
  workflow."

**Alternatives considered**:
- **Leave it under `utils/`** — keeps the misleading "reusable utility"
  framing, leaves the `DeploymentStatus` drift risk in place, and forces
  every action file plus the poller to reach across to `utils/` for
  module-private logic.
- **Split the three functions across the action files** — rejected.
  `pollWorkflowStatus` is called by both `actions/status.ts` and
  `poller.ts`, so inlining it into `status.ts` would force the poller to
  import across action boundaries, which inverts the module's read
  direction. Similarly, `dispatchGenappWorkflow` is called from
  `create.ts`, `deploy.ts`, and `destroy.ts`; triplicating it (or hoisting
  back to a sibling) gives no win over keeping it in one client file.
- **Inline only `pushTerraformTemplates` into `deploy.ts`** (single caller)
  — defensible, but it would re-fragment the client across two files
  (`genappWorkflowClient.ts` for dispatch + poll, `deploy.ts` for push)
  for no readability gain; all three functions share the same
  `gitHubApiFetch`/rate-limit plumbing.
- **Rename in place to `dockerWorkflowClient.ts` under `utils/`** —
  the rename alone does not fix the directory's "reusable" implication
  and still requires every action file plus the poller to import
  cross-tree from `utils/` for what is module-private behavior.

**What does NOT move**:
[githubAuth.ts](../../app/backend/src/utils/githubAuth.ts) (`resolveGitHubToken`,
`gitHubApiFetch`) and
[azureCredential.ts](../../app/backend/src/utils/azureCredential.ts)
(`getAzureTokenForScope`) are genuinely reusable across non-docker code
paths and stay under `utils/`.

## Verification of factual assumptions in the spec

- **`deployments-{projectId}` channel exists** — confirmed in
  [app/backend/src/websocket.ts](../../app/backend/src/websocket.ts) line 27
  (`deployments-{projectId} → deployment_refresh`) and 20+ broadcast sites in
  [functions.ts](../../app/backend/src/routes/functions.ts). No channel-
  registry change is required.
- **`workflow_run_id` column already exists** — confirmed in
  [infra/migrations/006_deployment_workflow_columns.sql](../../infra/migrations/006_deployment_workflow_columns.sql).
  The new migration adds only the four columns introduced by this feature.
- **`resolveGitHubToken` exists and accepts `{ userId }`** — confirmed in
  [app/backend/src/utils/githubAuth.ts](../../app/backend/src/utils/githubAuth.ts)
  L250.
- **PostgreSQL 16 advisory locks available** — confirmed in
  [docker-compose.yml](../../docker-compose.yml) (`postgres:16-alpine`).
- **No `.specify/extensions.yml` hooks registered** — confirmed by absence
  of the file.

## Open questions deferred to tasks/implementation

- **Logging payload shape** — the spec does not pin structured-log field
  names. Implementation will follow the existing `logger.info('[deployment]
  ...')` style; field naming is a code-style decision that does not warrant
  a clarification cycle.
- **Metrics** — deferred to a follow-up feature; the existing app emits no
  metrics today and adding telemetry plumbing is out of scope.

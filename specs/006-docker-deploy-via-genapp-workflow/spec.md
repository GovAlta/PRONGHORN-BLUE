# Feature Specification: Route Docker Container Deployments Through the Generated-App GitHub Actions Workflow

**Feature Branch**: `feature/deploy-using-github-workflows`
**Created**: 2026-05-28
**Status**: Draft
**Input**: Refactor Docker container–type project deployments so that create, deploy, and destroy actions all run through the existing `genapp-deploy.yml` GitHub Actions workflow instead of the legacy in-process Azure REST + ACR Tasks code path. Move the deployment-service handler out of the `functions.ts` monolith. Add a server-side poller so the database and UI converge to the final workflow conclusion without depending on the operator keeping the deploy UI open. Use the existing `resolveGitHubToken` helper everywhere a GitHub token is needed.

## Clarifications

### Session 2026-05-28

- Q: How should the poller behave when the API runs with more than one replica? → A: Each tick acquires a per-row Postgres advisory lock (`pg_try_advisory_lock` keyed by the deployment row id); a replica that fails to acquire the lock skips that row for the tick. No schema change, no leader election.
- Q: What is the retry behavior for a deployment row already in the `failed` state? → A: A new `deploy` action against a `failed` row clears the prior failure cause and run URL, transitions the row to `building`, and dispatches a fresh workflow run. No manual reset, no separate "retry" action.
- Q: What happens to the deployment row when the destroy workflow concludes with failure? → A: The row stays at status `failed` with the workflow run URL and failure cause captured. The operator may re-issue `destroy`; the workflow is idempotent and safely cleans up partial state on a subsequent run.
- Q: What happens to polling when the dispatching user's OAuth token becomes unusable (revoked, user deleted, or GitHub returns 401)? → A: The poller continues to call `resolveGitHubToken` per tick. The existing chain falls through to the system PAT (`GITHUB_PAT` / `GITHUB_TOKEN`) automatically, so polling continues. The `dispatched_by_user_id` foreign key uses `ON DELETE SET NULL`, so deleting the user does not delete the deployment row.
- Q: What are the allowed `status` values and which are transitional vs terminal? → A: Allowed values: `pending`, `building`, `deploying`, `running`, `failed`, `deleted`. Transitional set (polled by the server, treated as in-flight by the UI): `{pending, building, deploying}`. Terminal set: `{running, failed, deleted}`. `pending` = dispatched but not yet observed in GitHub Actions; `building` = workflow run in progress; `deploying` is reserved for future workflow stages and is treated identically to `building` today; `running` = workflow concluded success with a running URL resolved; `failed` = terminal failure (deploy or destroy); `deleted` = terminal post-successful-destroy.

## Scope

**In scope** — Docker container–type project deployments only. Actions covered:
`create`, `deploy`, `destroy` (workflow-dispatched); `status`, `logs`, `getEvents`,
`getEnvVars`, `updateEnvVars`, `syncEnvVars`, `updateServiceConfig` (DB + read-only).

**Out of scope** — Non-Docker deployment types (a future-deployment factory layer
is acknowledged but explicitly not built in this feature); `start` / `stop` /
`restart` actions (they remain ARM-direct, only relocated, not rewritten);
backfilling resource names for legacy `project_deployments` rows created before
cutover; any change to the `genapp-deploy.yml` workflow itself.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Deploy a Docker container project end-to-end via the workflow (Priority: P1)

An operator opens a project, configures a Docker container deployment with a
connected GitHub repository, and clicks **Save & Deploy**. The deployment is
dispatched to the existing GitHub Actions workflow. The status badge progresses
from Pending → Building → Running (or Failed) automatically — the operator does
not have to refresh.

**Why this priority**: This is the headline behavior change. Without it the
feature delivers no user value.

**Independent Test**: Create a deployment against a connected repo, click
Save & Deploy, verify that a `Deploy Generated App` run starts within seconds in
GitHub Actions, verify the deployment row carries a workflow run id, and verify
the badge converges to a terminal state without UI interaction.

**Acceptance Scenarios**:

1. **Given** a project with a connected GitHub repository and at least one
   committed file, **When** the operator clicks Save & Deploy, **Then** a
   GitHub Actions run of the generated-app deploy workflow is started, the
   deployment row's status is `building`, and the workflow run identifier plus
   the predicted Azure container-app name and resource-group name are persisted
   on the row before the API responds.
2. **Given** an in-flight deployment dispatched in step 1, **When** the
   workflow run progresses or concludes in GitHub Actions, **Then** the
   deployment row's status converges to the workflow's conclusion, and the
   running URL (when produced) is persisted, without the operator clicking
   refresh.
3. **Given** an in-flight deployment, **When** the operator closes the deploy
   dialog or the browser tab, **Then** status convergence still occurs because
   the server reconciles the row against the workflow run independently of any
   UI being mounted.

---

### User Story 2 — Destroy a deployment via the workflow (Priority: P1)

An operator deletes a deployment. The destroy action is dispatched to the
workflow, the underlying Azure resources are removed by the workflow, and the
row converges to a terminal deleted state.

**Why this priority**: Without this, deletes drift from the new naming
contract and orphan resources or leave stale rows.

**Independent Test**: Delete an existing deployment created in US1, verify a
`destroy` workflow run is dispatched, verify the row transitions to `deleted`
on workflow success.

**Acceptance Scenarios**:

1. **Given** a deployment row carrying a workflow-style container-app name and
   resource-group name, **When** the operator deletes it, **Then** a destroy
   workflow run is dispatched and the row transitions to `deleted` on
   successful conclusion.

---

### User Story 3 — Edit service configuration without dispatching a deploy (Priority: P2)

An operator opens the deployment dialog, changes the run command, build
command, install command, Dockerfile path, branch, run folder, or build
folder, and saves. The saved values are persisted immediately and take effect
on the next deploy. No Azure call is made.

**Why this priority**: The current frontend already sends this request; the
backend silently rejects it. Closing this gap unblocks an existing UI affordance
without changing layout.

**Independent Test**: Change a run command, save, reload the project, verify
the new value is shown, dispatch a deploy, verify the workflow inputs reflect
the change.

**Acceptance Scenarios**:

1. **Given** the deployment dialog with a modified run command, **When** the
   operator saves, **Then** the value is persisted on the deployment row,
   `200` is returned, and no workflow dispatch occurs.
2. **Given** persisted edits from step 1, **When** a later deploy is
   dispatched, **Then** the workflow receives the updated values as inputs.
3. **Given** an env-var-only edit in the dialog, **When** the operator saves,
   **Then** the existing env-var endpoints handle it; `updateServiceConfig`
   does not write env-vars.

---

### User Story 4 — Failure surfaces are actionable (Priority: P2)

When pre-deploy source synchronization fails, when the workflow cannot be
dispatched, when no workflow run is observed in a reasonable window, or when
the workflow concludes with failure, the operator sees a Failed badge with
enough information to retry.

**Why this priority**: Silent failures were a problem in the legacy path and
will be worse with an out-of-process workflow.

**Independent Test**: Force each failure mode (revoked token, malformed repo,
deliberately-failing workflow input) and confirm the row reflects the
distinct failure cause.

**Acceptance Scenarios**:

1. **Given** a deployment where pre-deploy source synchronization to the user
   repository cannot complete, **When** the operator dispatches a deploy,
   **Then** the workflow is not dispatched, the row is marked `failed`, and
   the failure cause is captured.
2. **Given** a deploy where the workflow dispatch HTTP call returns a non-2xx
   response, **When** the API processes the request, **Then** the row is
   marked `failed` and the operator sees a non-silent error.
3. **Given** a dispatched run that never appears in GitHub Actions or never
   leaves the queued state for the configured stall window, **When** the
   poller next ticks past that threshold, **Then** the row is marked `failed`.
4. **Given** a dispatched run that concludes with `failure`, **When** the
   poller observes the conclusion, **Then** the row is marked `failed`, the
   workflow run URL is captured on the row, and the conclusion is recorded.

---

### User Story 5 — Concurrent deploys are rejected (Priority: P3)

When two deploy requests are made against the same deployment row within the
same in-flight window, only the first proceeds.

**Why this priority**: Prevents racing dispatches and confusing duplicate
workflow runs against the same target.

**Independent Test**: Issue two deploy requests against the same row in quick
succession; only one workflow run appears.

**Acceptance Scenarios**:

1. **Given** a deployment row in `building` or `deploying` state, **When** a
   second deploy request is made against the same row, **Then** the second
   request returns `409` and no second workflow run is dispatched.
2. **Given** a deployment row in `failed` state, **When** the operator issues
   a new `deploy` action, **Then** the row's prior failure cause and run URL
   are cleared, the row transitions to `building`, a fresh workflow run is
   dispatched, and a `409` is **not** returned.

---

### User Story 6 — Destroy failure is recoverable (Priority: P3)

When the destroy workflow concludes with failure (for example, a partial
resource-deletion error), the deployment row reflects the failure with enough
information for the operator to retry. A subsequent `destroy` request safely
cleans up any remaining resources.

**Why this priority**: Avoids dead rows that block re-deletion when the
workflow hits transient Azure errors.

**Independent Test**: Force a destroy workflow run to fail (e.g., revoke a
required permission for one resource), observe the row reaches `failed` with
the workflow run URL captured, restore the permission, re-issue `destroy`,
confirm the row reaches `deleted`.

**Acceptance Scenarios**:

1. **Given** a destroy workflow run that concludes `failure`, **When** the
   poller observes the conclusion, **Then** the row's status is `failed`,
   the workflow run URL is persisted, and the failure cause is recorded.
2. **Given** a `failed` row left behind by a prior destroy attempt, **When**
   the operator re-issues `destroy`, **Then** a new destroy workflow run is
   dispatched and the row transitions to `deleted` on successful conclusion.

---

### Edge Cases

- **Legacy rows after cutover.** Rows created before this feature use the
  legacy ARM-style naming. On their next deploy under the new path, a *new*
  resource group and container app will be created under the workflow naming
  scheme, orphaning the old Azure resources. This is explicitly accepted; it
  is captured in Assumptions.
- **Repository token not available for polling.** When `resolveGitHubToken`
  yields no token for a given deployment (no per-repo PAT, no dispatching
  user's OAuth still valid, no system env var), the poller logs a warning and
  skips that row until a token becomes available.
- **Dispatching user's OAuth token becomes unusable mid-flight.** When the
  user's OAuth is revoked, expired, or the user is deleted, the poller's call
  to `resolveGitHubToken` falls through to the system PAT automatically.
  Polling continues uninterrupted. The deployment row is preserved when the
  user is deleted (`dispatched_by_user_id` is set to NULL).
- **Multiple API replicas polling the same row.** Each poller tick attempts a
  per-row Postgres advisory lock; a replica that does not acquire the lock
  skips the row for that tick. This guarantees at-most-one status update per
  row per tick across the fleet without requiring leader election.
- **Workflow dispatch succeeds but no run id is correlatable.** The dispatch
  endpoint does not always return an immediate run id. The system MUST
  reconcile dispatched runs by other correlatable input (e.g., the predicted
  resource names plus dispatch timestamp) until the run id is known.
- **`updateServiceConfig` race with an in-flight deploy.** Saving config while
  a deploy is in flight is allowed; the saved values take effect on the
  *next* deploy and do not change the in-flight run.
- **Frontend tab closed during a long deploy.** Status convergence is the
  server's responsibility; the UI is only an observer.
- **Pre-existing deployments with a `workflow_run_id` from the prior partial
  cutover.** Their next poll continues unchanged; no migration is required.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST perform `create`, `deploy`, and `destroy`
  actions for Docker container–type deployments by dispatching the existing
  generated-app deploy workflow. No in-process Azure REST or ACR Tasks code
  path may remain for these three actions.
- **FR-002**: On first dispatch for a deployment, the system MUST compute and
  persist the workflow-scheme container-app name and resource-group name on
  the deployment row **before** the workflow is dispatched, so subsequent
  status reads can resolve the target resources.
- **FR-003**: The naming computation MUST match the sanitization rules used by
  the workflow's container-app update step (lowercase, restricted to
  `a-z0-9-`, length-capped, suffixed with an 8-character app-id segment, with
  the resource group following the `rg-genapp-{name}-{id8}-{env}` pattern).
- **FR-004**: Pre-deploy source synchronization (committed blob store → user
  repository) MUST run **before** the workflow is dispatched. If it fails,
  the dispatch MUST be aborted and the row marked `failed`.
- **FR-005**: The workflow run identifier returned by GitHub MUST be persisted
  on the deployment row at dispatch time.
- **FR-006**: A server-side process MUST reconcile in-flight workflow runs
  against the deployment row's status independently of any UI being mounted,
  and MUST broadcast status changes over the existing WebSocket channel used
  by the deployment UI.
- **FR-007**: When a dispatched workflow run remains unobserved or
  non-terminal beyond a configurable stall window, the system MUST mark the
  row `failed` and stop polling it.
- **FR-008**: When a workflow run concludes `failure`, the system MUST persist
  the run URL and the conclusion on the deployment row.
- **FR-009**: When a deploy request targets a deployment row already in a
  transitional state (`pending`, `building`, or `deploying`), the system MUST
  return `409` and MUST NOT dispatch a second workflow run for that row. A
  deploy request against a row in any terminal state (`running`, `failed`, or
  `deleted`) MUST be accepted; for a `failed` row, the prior failure cause
  and run URL MUST be cleared as part of the transition to `building`.
- **FR-010**: The system MUST expose an `updateServiceConfig` action that
  persists run command, build command, install command, Dockerfile path,
  branch, run folder, and build folder on the deployment row, returns `200`,
  and does NOT invoke Azure or dispatch the workflow.
- **FR-011**: `updateServiceConfig` MUST NOT write environment variables.
  Environment-variable changes continue to flow through the existing
  `updateEnvVars` / `syncEnvVars` actions.
- **FR-012**: GitHub token resolution for both workflow dispatch and polling
  MUST use the existing `resolveGitHubToken` helper. No new environment
  variable for tokens may be introduced by this feature.
- **FR-013**: The `USE_GENAPP_WORKFLOW` environment flag and every reference
  to it MUST be removed. The `&& deployment.workflow_run_id` precondition
  that previously gated the workflow path MUST be removed.
- **FR-014**: The legacy `start`, `stop`, and `restart` actions remain
  ARM-direct and are out of scope for behavior changes, but MUST be
  relocated as part of the handler extraction (see CR-006).
- **FR-015**: The system MUST broadcast WebSocket events for create, status
  transitions, deletion, and configuration updates on the existing
  per-project deployment channel, so the deployment card auto-updates.
- **FR-016**: The deployment row's `status` MUST be one of `pending`,
  `building`, `deploying`, `running`, `failed`, or `deleted`. The set
  `{pending, building, deploying}` is transitional and is polled by the
  server. The set `{running, failed, deleted}` is terminal and is not
  polled.
- **FR-017**: When the API runs with more than one replica, the server-side
  poller MUST ensure at most one replica updates a given deployment row per
  tick by acquiring a per-row Postgres advisory lock before reading the
  workflow run and writing the row. A replica that cannot acquire the lock
  MUST skip that row for the tick without error.
- **FR-018**: When the destroy workflow run concludes with `failure`, the
  deployment row MUST be marked `failed` with the workflow run URL and
  failure cause persisted. A subsequent `destroy` request against the same
  row MUST be accepted and MUST dispatch a fresh destroy workflow run.

### Compatibility & Operational Requirements *(mandatory for brownfield changes)*

- **CR-001**: The existing HTTP request shape consumed by the deployment
  service (`{ action, deploymentId, shareToken, envVars, newEnvVars,
  keysToDelete, clearExisting }`) MUST continue to be accepted unchanged. No
  frontend layout, navigation, or component-positioning change is permitted
  (`UI/UX Layout Immutability`).
- **CR-002**: The existing WebSocket channel and event shape consumed by the
  deployment card MUST be preserved. New event types may be added; existing
  ones MUST NOT change name or payload shape.
- **CR-003**: Legacy `project_deployments` rows created before this feature
  are explicitly **not** migrated. Operators are informed that re-deploying a
  legacy row will create a new container app and resource group under the
  workflow naming scheme and orphan the legacy resources. This is the
  accepted trade-off.
- **CR-004**: The legacy `app/backend/src/routes/deployment.ts` router (which
  operates on an unused `deployments` table distinct from
  `project_deployments`) MUST be deleted along with its route registration.
- **CR-005**: Cutover is a single commit covering all environments. Before
  merge, a manual end-to-end smoke test MUST be performed in a non-production
  environment: create a deployment, observe automatic status convergence,
  delete the deployment, confirm the destroy workflow ran. No temporary
  feature flag is added.
- **CR-006**: All Docker-deployment switch-case logic — both the new
  workflow-dispatched actions and the relocated `start` / `stop` / `restart`
  / `status` / `logs` / `getEnvVars` / `updateEnvVars` / `syncEnvVars` /
  `updateServiceConfig` actions — MUST live in a new module dedicated to
  Docker container deployments. The deployment-service entry point in
  `functions.ts` MUST be reduced to a thin delegation; no new business logic
  may be added to `functions.ts`.
- **CR-007**: No new GitHub-token-bearing environment variable is introduced.
  Polling reuses the existing `resolveGitHubToken` chain (per-repo PAT →
  dispatching user's OAuth token → system `GITHUB_PAT` / `GITHUB_TOKEN`).
- **CR-008**: Token resolution at polling time requires knowing which user
  dispatched the deploy. The deployment row MUST therefore record the
  dispatching user identifier when a deploy is requested. The foreign key
  on the dispatching user MUST use `ON DELETE SET NULL` so deletion of a
  user does not cascade to deployment rows; the poller relies on the
  `resolveGitHubToken` system-PAT fallback when the user reference is null
  or the user's OAuth is no longer usable.

### Key Entities

- **Deployment record** — Represents a single Docker container deployment of
  a project. Attributes used by this feature: status (one of `pending`,
  `building`, `deploying`, `running`, `failed`, `deleted`), workflow run id,
  dispatching user id (nullable; `ON DELETE SET NULL`), predicted
  container-app name, predicted resource-group name, running URL, last
  failure cause (free-text describing the most recent failure — e.g.,
  `pre-push-failed`, `dispatch-http-<status>`, `stall-window-exceeded`,
  `workflow-conclusion-failure`), workflow run URL, and the editable
  service-config fields (run/build/install commands, Dockerfile path,
  branch, run folder, build folder).
- **Workflow run** — A GitHub Actions run of the generated-app deploy
  workflow, identified by its run id, with a conclusion observable via the
  GitHub API.
- **Deployment status broadcast** — A WebSocket message on the per-project
  deployment channel announcing a state change so subscribed UIs converge
  without polling.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of UI-initiated Docker container `create`, `deploy`, and
  `destroy` actions executed after merge result in a GitHub Actions run of
  the generated-app deploy workflow. Zero legacy in-process Azure REST or
  ACR Tasks invocations originate from the deployment service.
- **SC-002**: Within 5 seconds of the API response to a Save & Deploy
  request, the deployment row carries a workflow run id and the
  workflow-scheme container-app and resource-group names.
- **SC-003**: When a dispatched workflow run's conclusion changes in GitHub
  Actions, the deployment row's status reflects the new value within one
  poller interval (default 15 seconds) without any UI refresh.
- **SC-004**: When a dispatched workflow run never reaches a terminal state
  within the configured stall window (default 30 minutes), the deployment
  row converges to `failed` within one poller interval after the window
  elapses.
- **SC-005**: After merge, zero references to `USE_GENAPP_WORKFLOW` exist in
  the repository.
- **SC-006**: After merge, the deployment-service entry point in
  `functions.ts` is at least 1,400 lines shorter than before, and contains
  no `case '<action>':` body for Docker container deployments beyond a
  single delegation call.
- **SC-007**: A concurrent-deploy attempt against a row in a transitional
  state returns `409` 100% of the time; a deploy against a `failed` row is
  accepted and clears the prior failure attributes 100% of the time.
- **SC-008**: When the API runs with N>1 replicas all polling the same
  in-flight row in the same tick, exactly one replica updates the row and
  broadcasts; the remaining N−1 skip without error 100% of the time.

## Assumptions

- The Docker container deployment type is the only deployment type in scope.
  Other deployment types are planned for future work, and the new module is
  named and structured so a future dispatch / factory layer can be added
  without further extraction from `functions.ts`. The factory itself is
  **not** built in this feature.
- The `genapp-deploy.yml` workflow's resource-name sanitization remains the
  source of truth for the naming contract; the in-process implementation is
  validated against it by TypeScript unit tests covering representative
  inputs (length cap, character stripping, mixed case, app-id segmentation).
  No shell-side parity test is added in this feature.
- The `project_deployments` schema can be extended via a new migration in
  `infra/migrations/` to add a column recording the dispatching user
  identifier.
- The frontend's status component can be extended to treat `pending` as a
  transitional state without any layout, structural, or visual-hierarchy
  change.
- The existing WebSocket per-project deployment channel is either already
  registered or can be added through the existing channel registry without
  breaking any current subscriber.
- The configured stall window for FR-007 / SC-004 defaults to 30 minutes,
  chosen to comfortably exceed observed container build + push durations
  while still surfacing stuck runs in operator-relevant time. Operators may
  revisit the default if real-world data warrants.
- System-level `GITHUB_PAT` / `GITHUB_TOKEN` is available in deployed
  environments where dispatcher-user OAuth tokens may have expired. In local
  development the polling chain may yield no token and silently skip; this
  is acceptable for dev only because the frontend's safety poll covers
  developer workflows.

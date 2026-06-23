# Tasks: Route Docker Container Deployments Through the Generated-App GitHub Actions Workflow

**Input**: Design documents from `/specs/006-docker-deploy-via-genapp-workflow/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: REQUIRED. This is a brownfield refactor touching auth-adjacent code, persistent state, an external workflow contract, multi-replica safety, and WebSocket consumers. Validation per Constitution Principle III is non-negotiable.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and demoed independently. Within each story, tests precede implementation per Constitution III. `handleDeploymentService` in [app/backend/src/routes/functions.ts](../../app/backend/src/routes/functions.ts) shrinks incrementally as each story relocates its actions into the new module — no story adds new logic to `functions.ts` (CR-006).

## Format

`- [ ] [TaskID] [P?] [Story?] Description with file path`

- **[P]**: Different files, no dependency on incomplete tasks → can run in parallel.
- **[USx]**: Maps the task to a user story phase. Setup, Foundational, and Polish tasks carry no story label.
- Each task includes the exact absolute file path of the artifact created or modified.

## Path Conventions

- API source: `app/backend/src/`
- API tests: `app/backend/src/__tests__/`
- Frontend source: `app/frontend/src/`
- Migrations: `infra/migrations/`

---

## Phase 1: Setup

**Purpose**: Create the empty directory skeleton for the new module so subsequent [P] tasks can write into it without ordering conflicts.

- [X] T001 Create new directories `app/backend/src/services/deployment/docker/`, `app/backend/src/services/deployment/docker/actions/`, and `app/backend/src/__tests__/services/deployment/docker/actions/` (`mkdir -p`; no source files yet).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database schema, shared types, GitHub-workflow client (relocated per research [D-11](./research.md#d-11--relocate-utilsgenappdeployts-into-the-docker-module)), naming helper, state-machine helper, and the service entry-point skeleton. All user stories depend on these.

**⚠️ CRITICAL**: No user story phase may start until Phase 2 is complete. Shared modules (`types.ts`, `naming.ts`, `statusMachine.ts`, `genappWorkflowClient.ts`) are consumed by every action file and by the poller; their behavior is pinned by tests written here.

- [X] T002 Create migration `infra/migrations/008_deployment_dispatch_columns.sql` matching the SQL block in [data-model.md](./data-model.md): adds `dispatched_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL`, `dispatched_at timestamptz`, `dispatched_action text`, `last_failure_cause text`, `workflow_run_url text`, plus the `idx_deployments_in_flight` partial index and column COMMENTs. Verify locally per skill `03.run-local-schema-migration`.
- [X] T003 [P] Create `app/backend/src/services/deployment/docker/types.ts` exporting `DeploymentStatus` (union: `'pending' | 'building' | 'deploying' | 'running' | 'failed' | 'stopped' | 'deleted'`), `TRANSITIONAL` and `TERMINAL` sets, `isTransitional`/`isTerminal` predicates, `DeploymentRow`, `DockerDeploymentAction` (`'create' | 'deploy' | 'destroy' | 'status' | 'updateServiceConfig' | 'start' | 'stop' | 'restart' | 'logs' | 'getEvents' | 'getEnvVars' | 'updateEnvVars' | 'syncEnvVars'`), `DockerDeploymentContext`, and the `LastFailureCause` union per [data-model.md](./data-model.md).
- [X] T004 Move `app/backend/src/utils/genappDeploy.ts` → `app/backend/src/services/deployment/docker/genappWorkflowClient.ts` (use `git mv` to preserve history). During the move: (a) delete the file's local `DeploymentStatus` union and import it from `./types.ts` (eliminating the dual definition called out in research D-11); (b) tighten `GenappWorkflowParams.action` to `DockerDeploymentAction` from `./types.ts`; (c) update the lone import at [functions.ts line 28](../../app/backend/src/routes/functions.ts) to the new path. **No other behavior change.** Depends on T003.
- [X] T005 [P] Create `app/backend/src/__tests__/services/deployment/docker/genappWorkflowClient.test.ts` covering: `dispatchGenappWorkflow` issues a POST to the correct URL with the workflow file name embedded; `findWorkflowRunByAppId` returns `0` when no run matches and the resolved run id when one matches the app_id filter; `pollWorkflowStatus` maps GitHub `status='queued'` → `'pending'`, `'in_progress'` → `'building'`, `conclusion='success'` → `'running'`, `conclusion='failure'` → `'failed'`. Behaviour-pinning only (the move in T004 changes no runtime behaviour). Mocks `gitHubApiFetch` and `getAzureTokenForScope`. Depends on T004.
- [X] T006 [P] Create `app/backend/src/services/deployment/docker/naming.ts` exporting `computeGenappResourceNames({ appName, appId, environment })` implemented exactly per research [D-8](./research.md#d-8--resource-names-format-typescript-implementation-of-the-bash).
- [X] T007 [P] Create `app/backend/src/__tests__/services/deployment/docker/naming.test.ts` with at least 10 cases (lowercase passthrough, length cap at 32 chars, character stripping `[^a-z0-9-]`, mixed case, uppercase GUID app_id, app_id without dashes, app_id under 8 chars, leading/trailing hyphens, all-hyphens-after-strip, unicode characters) asserting byte-equality against expected `{ appName, resourceGroup }` (FR-003, SC-006 supporting evidence).
- [X] T008 [P] Create `app/backend/src/services/deployment/docker/statusMachine.ts` exporting `isTransitional`, `isTerminal`, `assertCanAcceptDeploy(currentStatus)` (throws `ConcurrentDeployError` for transitional states; returns `{ clearFailureAttrs: boolean }` otherwise), `assertCanAcceptDestroy(currentStatus)` (throws for `deleted`; returns `{ clearFailureAttrs: boolean }` otherwise), and the `ConcurrentDeployError` class.
- [X] T009 [P] Create `app/backend/src/__tests__/services/deployment/docker/statusMachine.test.ts` covering all enum values × {deploy, destroy} requests (FR-009, FR-016, FR-018, US5 AS1, US5 AS2, US6 AS2):
  - transitional × any → `ConcurrentDeployError`
  - `failed` × deploy → `{ clearFailureAttrs: true }`
  - `failed` × destroy → `{ clearFailureAttrs: true }` (FR-018)
  - `running` × deploy → `{ clearFailureAttrs: false }`
  - `deleted` × destroy → `ConcurrentDeployError`
  - `deleted` × deploy → `{ clearFailureAttrs: false }` (orphan trade-off CR-003)
- [X] T010 Create `app/backend/src/services/deployment/docker/dockerDeploymentService.ts` exporting `handle(req, res, body)`. Implementation per research [D-5](./research.md#d-5--action-map-vs-switch): a `const actions: Record<DockerDeploymentAction, Handler> = { ... }` registry; entries are imported lazily so per-story tasks can plug each action in. Until US1 lands, the map is empty and `handle` delegates to an injected fallback closure (the legacy `functions.ts` switch body). The file MUST NOT import from `functions.ts` itself — only the fallback closure passed at construction time. Depends on T003.
- [X] T011 Modify [`app/backend/src/routes/functions.ts`](../../app/backend/src/routes/functions.ts): at the top of `handleDeploymentService` (≈ L2025), construct the docker service with the existing switch body wrapped as the fallback closure, then `return dockerDeploymentService.handle(req, res, body);`. The existing switch becomes unreachable only for actions the registry handles. Depends on T010.

**Checkpoint**: Migration applied. Shared module files, the relocated client, the entry-point skeleton, and their tests are in place. Each user story may now plug its action handlers into the registry independently.

---

## Phase 3: User Story 1 — Deploy a Docker container project end-to-end via the workflow (Priority: P1) 🎯 MVP

**Goal**: End-to-end create + deploy of a Docker container project dispatched via the generated-app workflow, with server-side status convergence to a terminal state independent of any UI being mounted.

**Independent Test**: [Quickstart Phase B](./quickstart.md) — create a deployment against a connected GitHub repo, click Save & Deploy, verify within 5 s that the row carries `workflow_run_id` plus workflow-scheme `azure_container_app_name`/`azure_resource_group`, then observe the badge converge Pending → Building → Running without clicking refresh.

### Tests for User Story 1 ⚠️ Write first; must FAIL before implementation lands

- [X] T012 [P] [US1] Create `app/backend/src/__tests__/services/deployment/docker/actions/create.test.ts` asserting: row updated with `status='pending'`, `dispatched_by_user_id`, `dispatched_at`, `dispatched_action='create'`, computed `azure_container_app_name` + `azure_resource_group` BEFORE `dispatchGenappWorkflow` is called; `workflow_run_id` persisted from dispatch return value; `deployment_refresh` broadcast with `action='created'`; API responds `202 { success: true, data: { status: 'pending', workflowRunId } }`. Mock `dispatchGenappWorkflow`, `pushTerraformTemplates`, `db.query`, `resolveGitHubToken`, and the WebSocket broadcaster.
- [X] T013 [P] [US1] Create `app/backend/src/__tests__/services/deployment/docker/actions/deploy.test.ts` covering the happy path only (failure paths are added under US4): pre-push runs before dispatch; resource names preserved when already set; `dispatched_action='deploy'` persisted; `workflow_run_id` persisted; `deployment_refresh` broadcast with `action='status_updated'`; 202 response.
- [X] T014 [P] [US1] Create `app/backend/src/__tests__/services/deployment/docker/poller.test.ts` covering the happy-path tick: SELECT returns 1 transitional row, `pg_try_advisory_xact_lock` returns true, `pollWorkflowStatus` returns `{ status: 'running', conclusion: 'success', url: 'https://…' }`, row UPDATE'd to `status='running'` with the URL, single `deployment_refresh` broadcast with `action='status_updated'`, `status: 'running'`, and the URL. Mock `pollWorkflowStatus`, `db.query`, `resolveGitHubToken`, broadcaster.
- [X] T015 [P] [US1] Create `app/backend/src/__tests__/services/deployment/docker/dockerDeploymentService.test.ts` asserting that the entry point dispatches `body.action` through the action registry, falls through to the injected legacy handler for unregistered actions, and that the fallback is NOT invoked once `create`, `deploy`, and `status` are registered.

### Implementation for User Story 1

- [X] T016 [US1] Create `app/backend/src/services/deployment/docker/actions/create.ts` implementing the contract in [contracts/deployment-service-api.md § create](./contracts/deployment-service-api.md). Flow: load row → `resolveGitHubToken({ userId: req.user?.id, repoId })` → `computeGenappResourceNames` → persist names + `dispatched_by_user_id` + `dispatched_at` + `dispatched_action='create'` → call `pushTerraformTemplates` → call `dispatchGenappWorkflow({ action: 'create', ... })` (both imported from `../genappWorkflowClient`) → persist returned `workflow_run_id` → broadcast `deployment_refresh { action: 'created' }` on `deployments-${projectId}` → respond `202`.
- [X] T017 [US1] Create `app/backend/src/services/deployment/docker/actions/deploy.ts` happy path only: load row → resolve token → compute names (preserve existing) → pre-deploy GitHub auto-push (port the existing block at [functions.ts L2850–L2944](../../app/backend/src/routes/functions.ts) — keep BEFORE `dispatchGenappWorkflow` per research [D-7](./research.md#d-7--pre-deploy-auto-push-location)) → persist `dispatched_by_user_id` + `dispatched_at` + `dispatched_action='deploy'` → dispatch with `action: 'deploy'` → persist `workflow_run_id` → broadcast `{ action: 'status_updated' }` → respond `202`. Failure handling deferred to US4; leave a `// TODO(US4)` marker in each try/catch site but do NOT swallow errors silently.
- [X] T018 [US1] Create `app/backend/src/services/deployment/docker/actions/status.ts` containing the existing in-line `case 'status'` body from [functions.ts ≈ L2273](../../app/backend/src/routes/functions.ts): when `workflow_run_id` is set, call `pollWorkflowStatus({ workflowRunId, containerAppName, resourceGroup, githubToken })` (from `../genappWorkflowClient`); otherwise return the row's persisted status. Verbatim relocation; no behaviour change.
- [X] T019 [US1] Create `app/backend/src/services/deployment/docker/poller.ts` exporting `startDockerDeploymentPoller(opts?: { intervalMs?: number; stallWindowMs?: number; })` and `stopDockerDeploymentPoller()`. Per [data-model.md state machine](./data-model.md#state-machine-fr-009-fr-016-fr-017-fr-018):
  1. `setInterval(tick, intervalMs ?? 15000)` with an `isRunning` re-entrancy guard.
  2. `tick()`: `SELECT id, project_id, workflow_run_id, azure_container_app_name, azure_resource_group, dispatched_by_user_id, dispatched_at, dispatched_action, status FROM project_deployments WHERE status IN ('pending', 'building', 'deploying');`
  3. For each row, open a per-row transaction, attempt `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS got` (research [D-3](./research.md#d-3--advisory-lock-key-derivation)). If `got = false`, `COMMIT` and skip (`logger.debug` "skipped (lock not acquired)").
  4. Resolve token via `resolveGitHubToken({ userId: dispatched_by_user_id })`. If null and within stall window, log warn + `COMMIT` + skip.
  5. Call `pollWorkflowStatus` (from `./genappWorkflowClient`) — happy-path mapping `pending → building → running`. UPDATE only on status change; broadcast on change. `COMMIT`.
  6. Stall-window, workflow-conclusion-failure, and resolve-run-id-when-null branches are added under US4.
- [X] T020 [US1] Register `create`, `deploy`, and `status` in the `dockerDeploymentService` action registry (modify `dockerDeploymentService.ts` — registry entries only, no logic change).
- [X] T021 [US1] Modify [`app/backend/src/index.ts`](../../app/backend/src/index.ts): after `app.listen(PORT, ...)` resolves, call `startDockerDeploymentPoller()` gated by `process.env.NODE_ENV !== 'test'`. Add `stopDockerDeploymentPoller()` to the SIGTERM/SIGINT shutdown handler so the interval does not outlive a graceful shutdown.
- [X] T022 [US1] Modify [`app/backend/src/routes/functions.ts`](../../app/backend/src/routes/functions.ts): delete the `case 'create':` body (≈ L2424–L2670), the `case 'deploy':` body (≈ L2747–L3215 — including the legacy ARM/ACR-Tasks background IIFE ≈ L2973–L3066 and the in-line pre-push block ≈ L2850–L2944), and the `case 'status':` body (≈ L2273). The cases are now served by the registry. Run Jest to confirm no test imports from these regions.

**Checkpoint**: User Story 1 is independently functional. Operator clicks Save & Deploy → workflow dispatched → row carries run id + workflow-scheme names → poller observes happy-path conclusion → UI badge converges to Running without manual refresh.

---

## Phase 4: User Story 2 — Destroy a deployment via the workflow (Priority: P1)

**Goal**: Delete propagates as a `destroy` workflow run; the row converges to `deleted` on success.

**Independent Test**: [Quickstart Phase F (first half)](./quickstart.md) — delete a deployment created in US1, confirm a destroy workflow run starts, and the row transitions to `deleted` on conclusion success.

### Tests for User Story 2 ⚠️

- [X] T023 [P] [US2] Create `app/backend/src/__tests__/services/deployment/docker/actions/destroy.test.ts` asserting: 202 response; workflow dispatched with `action='destroy'` carrying the persisted `azure_container_app_name`/`azure_resource_group`; `dispatched_action='destroy'` and `dispatched_at` updated; `deployment_refresh { action: 'status_updated' }` broadcast; row left in `pending`/`building` (terminal `deleted` is set by the poller, not by the action). Also assert short-circuit: when `azure_container_app_name IS NULL`, no dispatch occurs, row transitions straight to `deleted`, broadcast carries `action: 'deleted'`.

### Implementation for User Story 2

- [X] T024 [US2] Create `app/backend/src/services/deployment/docker/actions/destroy.ts` per [contracts/deployment-service-api.md § destroy](./contracts/deployment-service-api.md). Use `assertCanAcceptDestroy` (T008). Set `dispatched_action='destroy'` on the row at dispatch time.
- [X] T025 [US2] Modify `app/backend/src/services/deployment/docker/poller.ts`: when the row's `dispatched_action='destroy'` and `pollWorkflowStatus` returns conclusion `success`, transition to `deleted` (not `running`). Pure UPDATE-mapping change; no schema change (T002 already added `dispatched_action`).
- [X] T026 [US2] Register `destroy` in the action registry (modify `dockerDeploymentService.ts`).
- [X] T027 [US2] Modify [`app/backend/src/routes/functions.ts`](../../app/backend/src/routes/functions.ts): delete the `case 'delete':` body (≈ L3325). Now served by the registry.

**Checkpoint**: User Stories 1 AND 2 work independently. Operator can create, deploy, and destroy via the workflow with full server-side status convergence.

---

## Phase 5: User Story 3 — Edit service configuration without dispatching a deploy (Priority: P2)

**Goal**: `updateServiceConfig` action persists non-env editable fields, returns `200`, never invokes Azure.

**Independent Test**: [Quickstart Phase C](./quickstart.md) — edit a run command in the deployment dialog, save, confirm no workflow run is triggered, then deploy and confirm the workflow inputs reflect the edit.

### Tests for User Story 3 ⚠️

- [X] T028 [P] [US3] Create `app/backend/src/__tests__/services/deployment/docker/actions/updateServiceConfig.test.ts` asserting: only the 7 allowed keys are persisted; any other key (including `envVars`, `newEnvVars`, anything from FR-011) returns `400 { error: 'unsupported config field: <key>' }`; `dispatchGenappWorkflow` is NEVER called; `pushTerraformTemplates` is NEVER called; broadcast carries `action='config_updated'`; response is `200`.

### Implementation for User Story 3

- [X] T029 [US3] Create `app/backend/src/services/deployment/docker/actions/updateServiceConfig.ts` per [contracts/deployment-service-api.md § updateServiceConfig](./contracts/deployment-service-api.md). Whitelist `run_command`, `build_command`, `install_command`, `dockerfile_path`, `branch`, `run_folder`, `build_folder`; reject extras with 400; UPDATE the row; broadcast `deployment_refresh { action: 'config_updated' }`; respond 200.
- [X] T030 [US3] Register `updateServiceConfig` in the action registry.

**Checkpoint**: Story 3 closes the silent-400 gap. The deploy dialog's existing Save button works.

---

## Phase 6: User Story 4 — Failure surfaces are actionable (Priority: P2)

**Goal**: Every failure mode in scope (pre-push, dispatch HTTP, stall window, workflow `failure` conclusion) marks the row `failed` with a recognisable `last_failure_cause` and a `workflow_run_url` when available.

**Independent Test**: [Quickstart Phase G](./quickstart.md) (stall window via targeted Jest test) plus manual triggers of dispatch HTTP failure (invalid token) and pre-push failure (non-existent repo).

### Tests for User Story 4 ⚠️

- [X] T031 [P] [US4] Create `app/backend/src/__tests__/services/deployment/docker/actions/failureModes.test.ts` covering (FR-004, FR-008):
  - Pre-push throws → row marked `failed` with `last_failure_cause` starting with `'pre-push-failed: '`; `dispatchGenappWorkflow` NOT called; 502 response; broadcast emitted.
  - `dispatchGenappWorkflow` throws → row marked `failed` with `last_failure_cause` starting with `'dispatch-http-'`; 502 response; broadcast emitted.
- [X] T032 [P] [US4] Extend `app/backend/src/__tests__/services/deployment/docker/poller.test.ts` with (FR-007, FR-008, SC-004):
  - `dispatched_at` older than stall window → row transitions to `failed` with `last_failure_cause='stall-window-exceeded'`; broadcast; not re-selected next tick.
  - `pollWorkflowStatus` returns `{ status: 'failed', conclusion: 'failure' }` AND `dispatched_action !== 'destroy'` → row transitions to `failed` with `last_failure_cause='workflow-conclusion-failure'` and `workflow_run_url` populated; broadcast carries both.
  - `workflow_run_id IS NULL` + `dispatched_at` within last 60 s → poller calls `findWorkflowRunByAppId`, persists resolved id, continues normally (research [D-2](./research.md#d-2--run-id-correlation-when-dispatch-does-not-return-a-run-id)).

### Implementation for User Story 4

- [X] T033 [US4] Modify `app/backend/src/services/deployment/docker/actions/deploy.ts`: wrap the pre-push call in try/catch. On failure, UPDATE `status='failed'` + `last_failure_cause='pre-push-failed: <error.message>'`, broadcast `deployment_refresh { action: 'status_updated', status: 'failed', lastFailureCause }`, respond `502 { success: false, error }`. Do NOT call `dispatchGenappWorkflow` on this path (FR-004).
- [X] T034 [US4] Modify `actions/create.ts`, `actions/deploy.ts`, `actions/destroy.ts`: wrap `dispatchGenappWorkflow` in try/catch. On failure, `last_failure_cause = 'dispatch-http-' + (err.statusCode ?? 'unknown') + ': ' + err.message`, mark `status='failed'`, broadcast, respond `502`.
- [X] T035 [US4] Modify `app/backend/src/services/deployment/docker/poller.ts`: add the stall-window branch — when `NOW() - dispatched_at > stallWindowMs` AND the workflow run is still non-terminal, transition to `failed` with `last_failure_cause='stall-window-exceeded'` and broadcast. Default `stallWindowMs = 30 * 60 * 1000`.
- [X] T036 [US4] Modify `app/backend/src/services/deployment/docker/poller.ts`: add the workflow-conclusion-failure branch — when `pollWorkflowStatus` returns `status='failed'` AND `dispatched_action !== 'destroy'`, persist `last_failure_cause='workflow-conclusion-failure'` plus the run's `html_url` as `workflow_run_url`. (Destroy-failure cause handled in US6.)
- [X] T037 [US4] Modify `app/backend/src/services/deployment/docker/poller.ts`: when row's `workflow_run_id IS NULL` and `dispatched_at` within last 60 s, call `findWorkflowRunByAppId` from `./genappWorkflowClient` with a `created>since` window anchored at `dispatched_at - 60s`. Persist any resolved id; otherwise leave NULL and re-try next tick.

**Checkpoint**: Story 4 promotes every spec-listed failure to a visible, debuggable terminal state. Operators see `last_failure_cause` and `workflow_run_url` on `failed` rows.

---

## Phase 7: User Story 5 — Concurrent deploys are rejected; retry from failed works (Priority: P3)

**Goal**: `409` on transitional rows; new `deploy` on `failed` clears the prior failure attributes; the poller is safe across N>1 API replicas via per-row advisory lock.

**Independent Test**: [Quickstart Phases D, E, H](./quickstart.md).

### Tests for User Story 5 ⚠️

- [X] T038 [P] [US5] Extend `app/backend/src/__tests__/services/deployment/docker/actions/deploy.test.ts` with: deploy against `status='building'` returns `409 { success: false, error: 'Deployment already in progress' }`; no dispatch; no broadcast. Deploy against `status='failed'` clears `last_failure_cause`, `workflow_run_url`, `workflow_run_id`, and `url` in the same UPDATE that sets `status='pending'`, then proceeds with dispatch (US5 AS2).
- [X] T039 [P] [US5] Extend `app/backend/src/__tests__/services/deployment/docker/poller.test.ts` with: simulate two concurrent ticks against the same row by stubbing `pg_try_advisory_xact_lock` to return `true` then `false`; assert only one UPDATE and only one broadcast (SC-008, FR-017). Also assert the second tick logs `'skipped (lock not acquired)'` at debug.

### Implementation for User Story 5

- [X] T040 [US5] Modify `app/backend/src/services/deployment/docker/actions/{deploy,create,destroy}.ts`: call `assertCanAcceptDeploy(row.status)` / `assertCanAcceptDestroy(row.status)` (from T008) at the top. Catch `ConcurrentDeployError` and respond `409`. When the assert returns `{ clearFailureAttrs: true }`, the UPDATE that sets `status='pending'` MUST also set `last_failure_cause = NULL, workflow_run_url = NULL, workflow_run_id = NULL, url = NULL` in the same statement.
- [X] T041 [US5] Modify `app/backend/src/services/deployment/docker/poller.ts`: ensure the per-row transaction wraps `SELECT pg_try_advisory_xact_lock(...)` first, with early `COMMIT` on `false` (T019 scaffolded this; T041 makes it real and tested). No UPDATE or broadcast on the skip path. Emit `logger.debug('[deployment-poller] skipped (lock not acquired) row=' + id)`.

**Checkpoint**: Story 5 makes the API safe to scale horizontally and lets operators retry without manual DB surgery.

---

## Phase 8: User Story 6 — Destroy failure is recoverable (Priority: P3)

**Goal**: A destroy workflow that concludes `failure` leaves the row in `failed` with the run URL captured; re-issuing `destroy` is accepted and dispatches a fresh run.

**Independent Test**: [Quickstart Phase F (second half)](./quickstart.md).

### Tests for User Story 6 ⚠️

- [X] T042 [P] [US6] Extend `app/backend/src/__tests__/services/deployment/docker/actions/destroy.test.ts` with: destroy against a `failed` row with `dispatched_action='destroy'` is accepted, clears `last_failure_cause`/`workflow_run_url`/`workflow_run_id`, dispatches a fresh destroy run, persists the new `workflow_run_id`, responds `202`. Destroy against a `deleted` row returns `409`.
- [X] T043 [P] [US6] Extend `app/backend/src/__tests__/services/deployment/docker/poller.test.ts` with: `pollWorkflowStatus` returns `status='failed'` AND `dispatched_action='destroy'` → row marked `failed` with `last_failure_cause='workflow-conclusion-failure-destroy'` AND `workflow_run_url` populated.

### Implementation for User Story 6

- [X] T044 [US6] Modify `app/backend/src/services/deployment/docker/poller.ts`: in the workflow-conclusion-failure branch (T036), choose `'workflow-conclusion-failure-destroy'` when `dispatched_action='destroy'`. Otherwise keep `'workflow-conclusion-failure'`.
- [X] T045 [US6] Modify `app/backend/src/services/deployment/docker/actions/destroy.ts`: when row arrives with `status='failed'`, clear `last_failure_cause`/`workflow_run_url`/`workflow_run_id` in the same UPDATE that sets `status='pending'`, dispatch the destroy run, persist the new `workflow_run_id`. `assertCanAcceptDestroy` (T008) already returns `clearFailureAttrs: true` for `failed`; reuse that contract.

**Checkpoint**: All six user stories independently functional. The MVP slice (US1+US2) is shippable; US3–US6 are net additions on top.

---

## Phase 9: Polish & Cross-Cutting

**Purpose**: Relocate the remaining handler bodies out of `functions.ts` so `handleDeploymentService` collapses to a single delegation call (CR-006 / SC-006); ship the frontend one-line change; remove the obsolete flag; run the quickstart.

- [X] T046 [P] Create `app/backend/src/services/deployment/docker/actions/lifecycleArm.ts` containing the `start`, `stop`, `restart` action bodies relocated verbatim from [functions.ts ≈ L3227, L3263, L3296](../../app/backend/src/routes/functions.ts). Export a single `handle(action, ctx)` that switches on `start`/`stop`/`restart` (FR-014). Behavior change: none.
- [X] T047 [P] Create `app/backend/src/services/deployment/docker/actions/envVars.ts` containing `getEnvVars`, `updateEnvVars`, `syncEnvVars` relocated verbatim from [functions.ts ≈ L3471, L3490](../../app/backend/src/routes/functions.ts). Behavior change: none. Out of scope for FR-011: env-var writes stay here.
- [X] T048 [P] Create `app/backend/src/services/deployment/docker/actions/logs.ts` containing `logs` and `getEvents` relocated verbatim from [functions.ts ≈ L3426](../../app/backend/src/routes/functions.ts). Behavior change: none.
- [X] T049 Register `start`, `stop`, `restart`, `getEnvVars`, `updateEnvVars`, `syncEnvVars`, `logs`, `getEvents` in the `dockerDeploymentService` action registry; delete the corresponding `case` bodies and surrounding setup (AZURE_SUBSCRIPTION_ID early bail-out, `azureToken`/`azureHeaders` constants now used only by `lifecycleArm.ts`) from [`app/backend/src/routes/functions.ts`](../../app/backend/src/routes/functions.ts). After this task, `handleDeploymentService` is a single `return dockerDeploymentService.handle(req, res, body);` plus its enclosing try/catch (CR-006).
- [X] T050 Delete [`app/backend/src/routes/deployment.ts`](../../app/backend/src/routes/deployment.ts); delete its mount line `router.use('/deployment', authMiddleware, deploymentRouter);` from [`app/backend/src/routes/v1/index.ts`](../../app/backend/src/routes/v1/index.ts) (≈ L45); delete the matching import (≈ L16); delete [`app/backend/src/__tests__/routes/deployment.test.ts`](../../app/backend/src/__tests__/routes/deployment.test.ts) (CR-004).
- [X] T051 Remove every `process.env.USE_GENAPP_WORKFLOW` reference and every `&& deployment.workflow_run_id` precondition repo-wide (quickstart Phase A asserts zero hits) (FR-013, SC-005). Also remove any stale `pushTerraformTemplates` import from [`app/backend/src/routes/functions.ts`](../../app/backend/src/routes/functions.ts) that survived T022.
- [X] T052 [P] Modify [`app/frontend/src/components/deploy/DeploymentCard.tsx`](../../app/frontend/src/components/deploy/DeploymentCard.tsx) line ≈ 56: change `const isTransitionalStatus = deployment.status === "building" || deployment.status === "deploying";` to include `'pending'`. NO layout/structure/visual-hierarchy change (Constitution VI). Keep the `azure_container_app_name` precondition so dev-time rows without resource names don't auto-refresh.
- [X] T053 [P] Modify [`app/frontend/src/components/deploy/DeploymentLogsDialog.tsx`](../../app/frontend/src/components/deploy/DeploymentLogsDialog.tsx) `isTransitionalStatus` helper (≈ L95): same one-line extension to include `'pending'`.
- [X] T054 [P] Create `app/frontend/src/components/deploy/__tests__/DeploymentCard.test.tsx` (Vitest) asserting a row with `status='pending'` AND `azure_container_app_name` set schedules the 10-second `syncStatus` interval (`vi.useFakeTimers`), and the interval clears when status reaches a terminal state.
- [ ] T055 Run the validation suite: `npm run lint && npm run build` in [app/frontend/](../../app/frontend/); `npm run build && npm test` in [app/backend/](../../app/backend/). Apply migration 008 locally per skill `03.run-local-schema-migration`. Execute [quickstart.md](./quickstart.md) Phases A through I against a non-production environment; record sign-off in the PR description (CR-005).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)** — no dependencies; start first.
- **Foundational (Phase 2)** — depends on T001; blocks every user story phase. T004 depends on T003; T005 depends on T004; T010 depends on T003; T011 depends on T010.
- **US1 (Phase 3)** — depends on Phase 2 complete. MVP slice.
- **US2 (Phase 4)** — depends on Phase 2 complete. Independent of US1; ships at any time after Phase 2.
- **US3 (Phase 5)** — depends on Phase 2 complete. Independent of US1/US2.
- **US4 (Phase 6)** — depends on US1 (modifies `actions/{create,deploy}.ts` and `poller.ts`). Soft dep on US2 for T034's `destroy.ts` wrap; scope it out if US2 hasn't landed.
- **US5 (Phase 7)** — depends on US1 + Phase 2. Soft dep on US2 for the destroy variant of the 409 guard.
- **US6 (Phase 8)** — depends on US2 + US4.
- **Polish (Phase 9)** — depends on US1–US6 having landed for the actions they own. T052–T054 (frontend) are independent of the API queue and can ship anytime after Phase 2.

### Critical-path tasks (block other phases)

- T002 (migration) — blocks every action that writes `dispatched_by_user_id`, `dispatched_at`, `dispatched_action`, `last_failure_cause`, `workflow_run_url`.
- T004 (genappDeploy → genappWorkflowClient relocation) — blocks T005, T010, T016, T017, T018, T019, T024.
- T010 (service entry skeleton) + T011 (delegation in functions.ts) — block every action registration task across all stories.
- T019 (poller skeleton) — blocks T025, T035, T036, T037, T041, T044.

### Within each user story

- Tests precede implementation (Constitution III).
- Shared types / module / migration precede their consumers (covered in Phase 2).

### Parallel opportunities

- Phase 2 (after T004 completes): T005, T006, T007, T008, T009 are all `[P]` — five tracks for shared modules and their tests.
- Phase 3 tests: T012, T013, T014, T015 are all `[P]`.
- Phase 6 tests: T031, T032 are both `[P]`.
- Phase 7 tests: T038, T039 are both `[P]`.
- Phase 8 tests: T042, T043 are both `[P]`.
- Phase 9: T046, T047, T048 (action relocations) are `[P]`; T052, T053, T054 (frontend) are `[P]` and independent of the API queue.

### Suggested staffing slices

- **Solo developer, MVP-only**: T001 → Phase 2 (T002–T011) → Phase 3 (T012–T022) → Phase 4 (T023–T027) → T052–T054 → T055. Ships US1 + US2 + frontend with smoke. US3–US6 follow.
- **Two-developer split after Phase 2**: Dev A owns US1 + US4 + US5 + US6 (workflow + failure + concurrency + destroy-failure). Dev B owns US2 + US3 + the relocations T046–T048 in parallel. Synchronise at T049, T051, T055.
- **MVP scope recommendation**: User Story 1 alone (T001 → Phase 2 → Phase 3 → T052–T054 → quickstart Phases A + B). Delivers the headline behaviour change.

## Validation checklist

After all tasks complete, verify:

- ✅ `wc -l app/backend/src/routes/functions.ts` reports at least 1,400 fewer lines than the pre-feature baseline (SC-006). Use `git diff main -- app/backend/src/routes/functions.ts | grep -c '^-'` to confirm.
- ✅ `grep -r USE_GENAPP_WORKFLOW app/` returns no matches (SC-005).
- ✅ `grep -rn "deployment.workflow_run_id" app/backend/src/routes/functions.ts` returns no matches (FR-013).
- ✅ `app/backend/src/routes/deployment.ts` does not exist (CR-004).
- ✅ `app/backend/src/utils/genappDeploy.ts` does not exist (research D-11).
- ✅ `app/backend/src/services/deployment/docker/genappWorkflowClient.ts` exists and is imported by `poller.ts` and every `actions/*.ts` that dispatches or polls.
- ✅ `npm test` in `app/backend/` passes the new `services/deployment/docker/**` suite.
- ✅ `npm test` in `app/frontend/` passes `DeploymentCard.test.tsx`.
- ✅ Migration 008 applies cleanly on a fresh local DB.
- ✅ Quickstart Phases A through I all signed off in the PR description.

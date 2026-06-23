# Implementation Plan: Route Docker Container Deployments Through the Generated-App GitHub Actions Workflow

**Branch**: `feature/deploy-using-github-workflows` | **Date**: 2026-05-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/006-docker-deploy-via-genapp-workflow/spec.md`

## Summary

Extract the Docker-container deployment-service handler out of [app/backend/src/routes/functions.ts](../../app/backend/src/routes/functions.ts) (currently 10,187 lines) into a new dedicated module, and replace the legacy in-process Azure REST + ACR Tasks code path with workflow dispatch against the existing [genapp-deploy.yml](../../.github/workflows/genapp-deploy.yml). Persist the workflow run id plus the workflow-scheme container-app and resource-group names at dispatch time so a new server-side poller can converge the deployment row to a terminal state independently of any UI being mounted. Reuse the existing `resolveGitHubToken` chain for every token resolution; record the dispatching user id on the row (new schema column, `ON DELETE SET NULL`) so the poller can fall through to the system PAT when a user OAuth becomes unusable. Multi-replica safety is enforced via per-row `pg_try_advisory_lock`. The `USE_GENAPP_WORKFLOW` flag and the `&& deployment.workflow_run_id` precondition are deleted in the same commit. The legacy `app/backend/src/routes/deployment.ts` router (which targets a different, unused `deployments` table) is deleted with its tests and v1 registration.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 18+ (API); TypeScript 5.x on Vite 5 / React 18 (frontend); SQL on PostgreSQL 16
**Primary Dependencies**: Express, `pg`, `ws`, the relocated `genappWorkflowClient.ts` (was `utils/genappDeploy.ts`) exporting `dispatchGenappWorkflow` / `pollWorkflowStatus` / `pushTerraformTemplates`, existing `githubAuth.ts` (`resolveGitHubToken`, `gitHubApiFetch`), existing `repoBlobStore.ts` and `repoChannels.ts` patterns. No new runtime dependencies.
**Storage**: PostgreSQL `project_deployments` table — schema-extended via a new migration adding `dispatched_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL`, `last_failure_cause text`, `workflow_run_url text`, and `dispatched_at timestamptz` (for stall-window computation).
**Testing**: Jest (API) for the new Docker-deployment service module, the naming helper, and the poller's transition logic (mocked `dispatchGenappWorkflow` / `pollWorkflowStatus` / `db`). Vitest (frontend) for the `DeploymentCard` transitional-status change. Manual end-to-end smoke per CR-005.
**Target Platform**: Pronghorn API as a Linux container (single Azure Container App replica today; the design assumes N>1 replicas are possible future state).
**Project Type**: Web application — frontend (`app/frontend/src/`) + API (`app/backend/`) + Postgres + GitHub Actions.
**Performance Goals**: Poller default interval 15s; stall window default 30 min; per-row advisory-lock acquisition < 5 ms; dispatch round-trip and DB persistence completed before the API responds (SC-002: workflow run id and resource names present within 5s of API response).
**Constraints**: No new env var introduced for tokens (CR-007); no `USE_GENAPP_WORKFLOW` references survive (FR-013, SC-005); functions.ts must shrink ≥1,400 lines and contain no Docker-deployment case body beyond a single delegation (CR-006, SC-006); UI layout unchanged (Constitution VI). The existing `deployments-{projectId}` WebSocket channel + `deployment_refresh` event already exist (verified in [websocket.ts](../../app/backend/src/websocket.ts)) — no channel-registry changes required.
**Scale/Scope**: Order-of-magnitude tens of in-flight deployments per project per day across the platform; poller fan-out is `O(in-flight rows)` per tick, bounded by the transitional-status filter.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Contract Preservation**: Affected contracts —
  - **HTTP request body** to the deployment-service endpoint: unchanged (CR-001).
  - **HTTP response shape** for `create` / `deploy` / `destroy`: returns `202` with `{ success, data: { status, workflowRunId } }`; existing callers already tolerate the existing shape.
  - **WebSocket channel and event name** (`deployments-{projectId}` / `deployment_refresh`): unchanged (CR-002, verified in [websocket.ts](../../app/backend/src/websocket.ts)). The new event sub-types (`action: 'created' | 'status_updated' | 'config_updated' | 'deleted'`) extend the existing payload's `action` discriminator and do not remove or rename existing fields.
  - **Database schema (`project_deployments`)**: additive only — four nullable columns added in a new migration. Legacy rows continue to read.
  - **Legacy `/api/v1/deployment` router**: deleted intentionally; spec records this as in-scope (CR-004). No frontend caller exists today (this router uses a different `deployments` table, not `project_deployments`).
  - **`USE_GENAPP_WORKFLOW` env var**: intentionally removed (FR-013); a single-commit cutover is the documented migration strategy (CR-005).
  ⇒ **PASS** — all breaks are intentional and have migration steps recorded.

- **Traceability**: Every requirement maps to a concrete subsystem; the mapping is in [Project Structure](#project-structure) below and the per-task mapping is deferred to `tasks.md`. User stories US1–US6 trace to specific files in the new `app/backend/src/services/deployment/docker/` module, the new poller, the migration, the frontend `DeploymentCard.tsx` change, and the deleted `routes/deployment.ts`. ⇒ **PASS**.

- **Verification**: API — `npm run build` in [app/backend/](../../app/backend/) and Jest tests (new files under `app/backend/src/__tests__/services/deployment/docker/`). Frontend — `npm run lint && npm run build` in [app/frontend/](../../app/frontend/) and Vitest tests for `DeploymentCard`. Infra — schema migration validated by re-running `init-createdb.sql` order locally per skill 03. Cross-layer manual smoke per CR-005 documented in [quickstart.md](./quickstart.md). ⇒ **PASS**.

- **Security and Compliance**: Token handling — every GitHub API call routes through `resolveGitHubToken` (CR-007). No token-bearing env var added. The dispatching user id is recorded; the foreign key is `ON DELETE SET NULL` so user deletion never deletes deployment rows and the poller falls through to the system PAT. No new secret values introduced. RBAC — the existing auth middleware on the deployment-service entry point is preserved by the extraction; no privilege escalation. Workflow dispatch already uses the user's GitHub token via `resolveGitHubToken`, which is the same authority model as today. ⇒ **PASS**.

- **Operability**: Deployment — single PR + single deploy; pre-merge smoke (CR-005). Monitoring — every poller tick logs at info level (row id, run id, observed status, decision); every state transition logs the cause; `resolveGitHubToken` no-token outcome logs a warning. Rollback — revert the PR; the migration is additive-only (`ADD COLUMN IF NOT EXISTS`), so revert is non-destructive (the new columns simply become unused). Post-deploy validation — see [quickstart.md](./quickstart.md). Multi-replica safety — per-row `pg_try_advisory_lock` (FR-017, SC-008). Test-environment safety — poller startup is gated on `process.env.NODE_ENV !== 'test'` so Jest does not keep an interval alive. ⇒ **PASS**.

- **UI/UX Layout Immutability**: The only frontend change is one-line: extending `isTransitionalStatus` in [DeploymentCard.tsx](../../app/frontend/src/components/deploy/DeploymentCard.tsx) to include `'pending'`. No layout, navigation, component-positioning, or visual-hierarchy change. The existing `statusConfig` already renders all enum values used by the spec. The `DeploymentLogsDialog.tsx` component, which has its own `isTransitionalStatus` helper, gets the same one-line extension for consistency. ⇒ **PASS**.

**Result**: Initial Constitution Check passes. No items added to Complexity Tracking.

### Post-design re-check (after Phase 1)

Re-evaluated against the artifacts produced in Phase 1 ([data-model.md](./data-model.md), [contracts/deployment-service-api.md](./contracts/deployment-service-api.md), [contracts/deployment-ws-events.md](./contracts/deployment-ws-events.md), [quickstart.md](./quickstart.md)):

- The data model only introduces additive nullable columns + one partial index. **PASS**.
- The HTTP contract preserves the request envelope; new response codes (`202`, `409`, `400` for unsupported config keys) are documented and aligned with FR-009 / FR-010. **PASS**.
- The WebSocket contract preserves the channel and event names; new payload fields are additive. **PASS**.
- The quickstart pins every CR-required validation step to a concrete commands or DB query. **PASS**.

No Complexity Tracking entries added at re-check.

## Affected Layers

| Layer                         | Touched? | Validation Required                                                                                          |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| Web App (`app/frontend/src/`) | Yes      | `npm run lint` + `npm run build` in `app/frontend/`; Vitest covers the transitional-status change            |
| API (`app/backend/`)          | Yes      | `npm run build` in `app/backend/`; Jest covers the new service module, naming helper, poller, and entry-point delegation |
| Infrastructure (`infra/`)     | Yes (migrations only) | `psql` re-apply of `infra/migrations/008_deployment_dispatch_columns.sql` on a fresh local DB per skill 03 |
| CI/CD (`.github/workflows/`)  | No       | The `genapp-deploy.yml` workflow is unchanged; assumption pinned by Jest unit tests against `computeGenappResourceNames` |

## Project Structure

### Documentation (this feature)

```text
specs/006-docker-deploy-via-genapp-workflow/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions and rationales
├── data-model.md        # Phase 1 — schema additions + state machine
├── quickstart.md        # Phase 1 — manual smoke procedure (CR-005)
├── contracts/
│   ├── deployment-service-api.md   # HTTP request/response per action
│   └── deployment-ws-events.md     # WebSocket event payloads
├── checklists/
│   └── requirements.md  # Existing (from /speckit.specify)
└── spec.md              # Existing
```

### Source Code (repository root)

```text
app/backend/
├── src/
│   ├── routes/
│   │   ├── functions.ts                            # MODIFIED — handleDeploymentService becomes a thin delegate
│   │   └── deployment.ts                           # DELETED (CR-004)
│   ├── routes/v1/
│   │   └── index.ts                                # MODIFIED — remove `/deployment` mount (CR-004)
│   ├── services/                                   # NEW DIRECTORY
│   │   └── deployment/                             # NEW DIRECTORY
│   │       └── docker/                             # NEW DIRECTORY
│   │           ├── dockerDeploymentService.ts      # NEW — single entry point: `handle(action, ctx)`
│   │           ├── genappWorkflowClient.ts         # NEW (relocated from utils/genappDeploy.ts; DeploymentStatus removed in favor of ./types.ts)
│   │           ├── naming.ts                       # NEW — `computeGenappResourceNames`
│   │           ├── poller.ts                       # NEW — `startDockerDeploymentPoller`
│   │           ├── statusMachine.ts                # NEW — transitional/terminal predicates + transitions
│   │           ├── types.ts                        # NEW — `DockerDeploymentAction`, `DeploymentRow`, etc.
│   │           └── actions/                        # NEW DIRECTORY — one file per action body
│   │               ├── create.ts
│   │               ├── deploy.ts
│   │               ├── destroy.ts
│   │               ├── status.ts
│   │               ├── logs.ts                     # covers `logs` + `getEvents`
│   │               ├── envVars.ts                  # covers `getEnvVars` + `updateEnvVars` + `syncEnvVars`
│   │               ├── updateServiceConfig.ts
│   │               └── lifecycleArm.ts             # `start` + `stop` + `restart` (relocated, behavior unchanged)
│   ├── utils/
│   │   └── genappDeploy.ts                         # DELETED — relocated into services/deployment/docker/genappWorkflowClient.ts (research D-11)
│   └── index.ts                                    # MODIFIED — start the poller after `app.listen` when NODE_ENV !== 'test'
├── src/__tests__/
│   ├── routes/
│   │   └── deployment.test.ts                      # DELETED with the router (CR-004)
│   └── services/                                   # NEW DIRECTORY
│       └── deployment/
│           └── docker/
│               ├── naming.test.ts                  # parity inputs (FR-003 / SC-006)
│               ├── statusMachine.test.ts           # transitions + 409 on transitional (FR-009, SC-007)
│               ├── poller.test.ts                  # tick logic, stall, advisory lock skip (FR-007, FR-017, SC-008)
│               ├── dockerDeploymentService.test.ts # action dispatch, delegation contract
│               └── actions/
│                   ├── create.test.ts
│                   ├── deploy.test.ts
│                   ├── destroy.test.ts
│                   ├── updateServiceConfig.test.ts # writes only non-env fields (FR-010, FR-011)
│                   └── failureModes.test.ts        # dispatch HTTP failure, pre-push failure (FR-004, FR-008)

app/frontend/
├── src/components/deploy/
│   ├── DeploymentCard.tsx                          # MODIFIED — `isTransitionalStatus` includes 'pending'
│   └── DeploymentLogsDialog.tsx                    # MODIFIED — same one-line extension
└── src/components/deploy/__tests__/
    └── DeploymentCard.test.tsx                     # NEW — asserts pending triggers the auto-refresh interval

infra/
└── migrations/
    └── 008_deployment_dispatch_columns.sql         # NEW — adds dispatched_by_user_id, last_failure_cause, workflow_run_url, dispatched_at
```

**Structure Decision**: Adopt the **single dedicated Docker-deployment module** at `app/backend/src/services/deployment/docker/`. Inside the module, split per action under `actions/` so each action body is small and independently testable; share state-machine, naming, and GitHub-workflow-client logic via sibling files. The previously-stand-alone `utils/genappDeploy.ts` is relocated into the module as `genappWorkflowClient.ts` because its three exports are docker-deployment-specific (action verb literals, workflow-name string coupling, `DeploymentStatus` overlap) and have exactly one caller; the rename is recorded in research [D-11](./research.md#d-11--relocate-utilsgenappdeployts-into-the-docker-module). This satisfies the user's directive to avoid adding to `functions.ts` while leaving room for a future deployment-type factory at `app/backend/src/services/deployment/` (e.g., `serverless/`, `static/`) without further extraction. The factory itself is **not** built in this feature (per spec Assumptions). The `dockerDeploymentService.ts` entry point exports a single `handle(req, res, body)` function; `handleDeploymentService` in `functions.ts` collapses to:

```ts
async function handleDeploymentService(req, res, body) {
  return dockerDeploymentService.handle(req, res, body);
}
```

## Traceability — requirement → artifact

| Req | Artifact |
|-----|----------|
| FR-001 (create/deploy/destroy go through workflow) | `actions/create.ts`, `actions/deploy.ts`, `actions/destroy.ts`; [deployment-service-api.md](./contracts/deployment-service-api.md) |
| FR-002 (persist names before dispatch) | `naming.ts` + `actions/{create,deploy}.ts`; [data-model.md](./data-model.md) |
| FR-003 (naming parity) | `naming.ts`; `__tests__/services/deployment/docker/naming.test.ts` |
| FR-004 (pre-push then dispatch) | `actions/deploy.ts`; research [D-7](./research.md#d-7--pre-deploy-auto-push-location) |
| FR-005 (persist workflow_run_id) | `actions/{create,deploy,destroy}.ts`; `genappWorkflowClient.ts` (relocated); [data-model.md](./data-model.md) |
| FR-006 (server-side reconciliation + WS) | `poller.ts` (calls `genappWorkflowClient.pollWorkflowStatus`); [deployment-ws-events.md](./contracts/deployment-ws-events.md) |
| FR-007 (stall window) | `poller.ts` + `dispatched_at` column; research [D-1](./research.md#d-1--dispatched_at-column-for-stall-window-math) |
| FR-008 (failure conclusion captured) | `poller.ts`; [data-model.md](./data-model.md) LastFailureCause |
| FR-009 (409 on transitional, clear on failed) | `statusMachine.ts`; `actions/deploy.ts`; [deployment-service-api.md](./contracts/deployment-service-api.md) |
| FR-010 / FR-011 (updateServiceConfig scope) | `actions/updateServiceConfig.ts`; [deployment-service-api.md](./contracts/deployment-service-api.md) |
| FR-012 / CR-007 (resolveGitHubToken everywhere) | `actions/*.ts`, `poller.ts` |
| FR-013 (remove USE_GENAPP_WORKFLOW) | `functions.ts` MODIFIED; quickstart Phase A |
| FR-014 (relocate start/stop/restart) | `actions/lifecycleArm.ts` |
| FR-015 (WS broadcasts) | [deployment-ws-events.md](./contracts/deployment-ws-events.md) |
| FR-016 (status enum) | `statusMachine.ts`; [data-model.md](./data-model.md) |
| FR-017 / SC-008 (advisory lock) | `poller.ts`; research [D-3](./research.md#d-3--advisory-lock-key-derivation) |
| FR-018 / US6 (destroy failure recovery) | `actions/destroy.ts`; `poller.ts`; quickstart Phase F |
| CR-003 (legacy rows orphan) | quickstart Phase B note; spec Assumptions |
| CR-004 (delete legacy router) | `routes/deployment.ts` DELETED; `routes/v1/index.ts` MODIFIED; quickstart Phase I |
| CR-005 (single-commit cutover + smoke) | [quickstart.md](./quickstart.md) |
| CR-006 (functions.ts thin delegate) | Structure Decision above; SC-006 check in quickstart Phase A |
| CR-008 (dispatched_by_user_id with SET NULL) | [data-model.md](./data-model.md) migration |

## Complexity Tracking

> No Constitution violations. Section intentionally empty.

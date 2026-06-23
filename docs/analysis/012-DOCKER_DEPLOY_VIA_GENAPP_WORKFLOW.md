# 012 — Route Docker Deploy Through the Deploy Generated App Workflow

## Current state (from code audit)
The workflow plumbing is present but **unreachable in practice** today:

- `case 'deploy'` and `case 'delete'` in
  [`functions.ts`](../../app/backend/src/routes/functions.ts) gate the genapp
  branch on `USE_GENAPP_WORKFLOW === 'true' && deployment.workflow_run_id`.
- `case 'create'` never calls `dispatchGenappWorkflow` and never writes
  `workflow_run_id`, so the `&& deployment.workflow_run_id` clause is always
  false for new deployments → every request silently falls through to the
  legacy ARM / ACR Tasks code.
- `case 'status'` already polls via `pollWorkflowStatus` when
  `workflow_run_id` is set; no flag check there.
- `computeGenappResourceNames` does **not** exist; the legacy `create` writes
  `azure_container_app_name` / `azure_resource_group` using a different
  scheme than the workflow's bash sanitization. Cutover requires writing the
  workflow-style names **before** dispatch so the FQDN lookup in
  `pollWorkflowStatus` resolves.
- Pre-deploy GitHub auto-push lives inside the legacy branch of
  `case 'deploy'`; if we move dispatch to the workflow, this block must run
  **before** the dispatch (the workflow does `actions/checkout` of the user
  repo).
- `DeploymentDialog.tsx` sends `action: 'updateServiceConfig'` on every edit
  save; the backend has no handler → silent HTTP 400. Pre-existing bug; in
  scope to fix as part of this cutover.
- `pushTerraformTemplates` is imported in `functions.ts` but never called.

## Summary
Replace the legacy ACR Tasks + ARM container-app code in
[`handleDeploymentService`](../../app/backend/src/routes/functions.ts) with a
single dispatch of the existing
[`genapp-deploy.yml`](../../.github/workflows/genapp-deploy.yml) workflow for
`create`, `deploy`, and `destroy`. Persist the workflow run id plus the
predicted container-app and resource-group names so we can correlate. Add a
server-side interval poller that updates `project_deployments.status` from the
GitHub Actions run and broadcasts via WebSocket. Extend the frontend
auto-refresh trigger to include `pending`; the existing status badge already
renders `building` / `running` / `failed`.

## Decisions (from clarifications)
- Both `action: 'create'` and `action: 'deploy'` route to the workflow.
- Delete the `USE_GENAPP_WORKFLOW` flag **and** the `&& deployment.workflow_run_id`
  precondition — neither survives. Removing the flag alone is not enough because
  the run-id precondition is the actual reason the genapp branch is unreachable
  today.
- Delete the legacy ARM / ACR Tasks build code paths.
- Remove the unused `pushTerraformTemplates` import in `functions.ts`.
- Add a backend background poller for in-flight workflow runs.
- `start` / `stop` / `restart` stay ARM-direct — out of scope (no workflow
  equivalents exist).
- Pre-deploy GitHub auto-push (committed blob store → user repo) **stays** and
  moves **above** the workflow dispatch so the workflow's `actions/checkout`
  sees the latest source.
- Implement a real `updateServiceConfig` handler (or stop the frontend from
  sending it). See Phase 1 step 6.

## Naming contract
Must match the `Update container app image` step in
[`genapp-deploy.yml`](../../.github/workflows/genapp-deploy.yml):

```
APP_NAME_SAFE = lower(app_name) | tr -cd 'a-z0-9-' | head -c 32
APP_ID_SHORT  = app_id without dashes | head -c 8
APP_NAME      = ${env}-${APP_NAME_SAFE}-${APP_ID_SHORT}
RG_NAME       = rg-genapp-${APP_NAME_SAFE}-${APP_ID_SHORT}-${env}
```

The backend computes and persists these on first dispatch so subsequent FQDN
reads and DB lookups resolve.

## Phase 1 — Backend: replace legacy code with workflow dispatch
1. Add `computeGenappResourceNames(deployment)` to
   [`genappDeploy.ts`](../../app/backend/src/utils/genappDeploy.ts) that
   returns `{ appName, resourceGroup }` mirroring the workflow's sanitization
   rules. Export it.
2. In [`functions.ts`](../../app/backend/src/routes/functions.ts) `case 'create'`
   (≈ L2424–L2670): delete the entire ARM / ACR Tasks body and replace with:
   - Resolve repo (existing `getRepoByIdWithToken` / prime-repo fallback).
   - Resolve GitHub token via `resolveGitHubToken`.
   - Compute names via `computeGenappResourceNames`.
   - `rpc.updateDeploymentWithToken(..., { status: 'building', azure_container_app_name, azure_resource_group })`.
   - `await dispatchGenappWorkflow({ action: 'create', ... envVars: envVarsObj })`.
   - Update row with the returned `workflow_run_id`.
   - Broadcast `deployment_refresh { action: 'created' }`.
   - Return `202 { success: true, data: { status: 'building', workflowRunId } }`.
3. In `case 'deploy'` (≈ L2747–L3215): drop both the `USE_GENAPP_WORKFLOW`
   flag *and* the `&& deployment.workflow_run_id` precondition; delete the
   legacy ARM / ACR-Tasks background-IIFE block (≈ L2973–L3066). Reorder so
   the pre-deploy GitHub auto-push (≈ L2850–L2944) runs **before** the
   dispatch. Then: compute names if missing, persist, run auto-push, dispatch
   with `action: 'deploy'`, persist `workflow_run_id`, broadcast, respond
   `202`.
4. In `case 'delete'` (≈ L3329): drop both the flag and the `workflow_run_id`
   precondition. For any deployment with `azure_container_app_name` set,
   dispatch `action: 'destroy'`, then mark `status='deleted'` on successful
   dispatch. Remove the legacy ARM-direct delete branch.
5. Remove all `process.env.USE_GENAPP_WORKFLOW` references in the file and
   drop the unused `pushTerraformTemplates` import.
6. Implement `case 'updateServiceConfig'`: persist the dialog's editable
   fields (`run_command`, `build_command`, `install_command`,
   `dockerfile_path`, `branch`, `run_folder`, `build_folder`, env-var
   bookkeeping) via `rpc.updateDeploymentWithToken`, broadcast
   `deployment_refresh { action: 'config_updated' }`, return `200`. No Azure
   call — config takes effect on the next `deploy` dispatch.
7. `case 'status'` already routes through `pollWorkflowStatus` when
   `workflow_run_id` is set — no change.

## Phase 2 — Backend: background status poller
*(Depends on Phase 1.)*

8. Create
   [`deploymentPoller.ts`](../../app/backend/src/utils/deploymentPoller.ts)
   exporting `startDeploymentPoller(intervalMs = 15000)`:
   - Each tick:
     ```sql
     SELECT id, project_id, workflow_run_id,
            azure_container_app_name, azure_resource_group,
            status, url
     FROM project_deployments
     WHERE workflow_run_id IS NOT NULL
       AND status IN ('pending', 'building', 'deploying');
     ```
   - For each row, call
     `pollWorkflowStatus(runId, { containerAppName, resourceGroup }, githubToken)`.
   - When `status` changes:
     ```sql
     UPDATE project_deployments
        SET status = $1, url = COALESCE($2, url), updated_at = NOW()
      WHERE id = $3;
     ```
     and broadcast
     `deployments-{projectId} → deployment_refresh { action: 'status_updated', deploymentId, status }`.
   - Guard against overlapping ticks with an `isRunning` flag, log errors, never
     throw out of the interval.
9. GitHub token for the poller: resolve from `process.env.GITHUB_TOKEN` (already
   a `resolveGitHubToken` fallback). If unset, log a warning and skip the tick.
   No new env var introduced.
10. Start the poller in
   [`app/backend/src/index.ts`](../../app/backend/src/index.ts) after
   `app.listen`, gated on `process.env.NODE_ENV !== 'test'` so Jest doesn't
   keep the loop alive.

## Phase 3 — Frontend
*(Can run in parallel with Phase 2.)*

11. In
    [`DeploymentCard.tsx`](../../app/frontend/src/components/deploy/DeploymentCard.tsx),
    extend `isTransitionalStatus` to include `'pending'` so freshly-dispatched
    workflows (queued in GitHub) are auto-polled by the existing 10s
    `syncStatus` interval. No other UI changes — `statusConfig` already renders
    Pending / Building / Running / Failed.
12. No changes needed to
    [`DeploymentDialog.tsx`](../../app/frontend/src/components/deploy/DeploymentDialog.tsx)
    for the dispatch flow — existing **Save & Deploy** already invokes
    `cloud-deployment` with `action: 'deploy'`. The dialog's existing
    `action: 'updateServiceConfig'` call now succeeds (handler added in
    Phase 1 step 6) instead of silently 400-ing.

## Relevant files
- [`app/backend/src/routes/functions.ts`](../../app/backend/src/routes/functions.ts)
  — rewrite `case 'create' | 'deploy' | 'delete'` in
  `handleDeploymentService`; remove the flag.
- [`app/backend/src/utils/genappDeploy.ts`](../../app/backend/src/utils/genappDeploy.ts)
  — already contains `dispatchGenappWorkflow`, `pollWorkflowStatus`; add
  `computeGenappResourceNames`.
- [`app/backend/src/utils/deploymentPoller.ts`](../../app/backend/src/utils/deploymentPoller.ts)
  — **new** background poller.
- [`app/backend/src/index.ts`](../../app/backend/src/index.ts) — call
  `startDeploymentPoller()` after server listen.
- [`.github/workflows/genapp-deploy.yml`](../../.github/workflows/genapp-deploy.yml)
  — naming source of truth (no edits planned).
- [`app/frontend/src/components/deploy/DeploymentCard.tsx`](../../app/frontend/src/components/deploy/DeploymentCard.tsx)
  — extend `isTransitionalStatus` to include `'pending'`.
- [`app/backend/src/__tests__/routes/deployment.test.ts`](../../app/backend/src/__tests__/routes/deployment.test.ts)
  — update / add tests asserting `dispatchGenappWorkflow` is the call for
  `create` / `deploy`.

## Verification
1. `cd app/backend && npm run build` — TypeScript compiles after legacy removal.
2. `cd app/backend && npm run test -- deployment` — Jest passes; update mocks
   so `dispatchGenappWorkflow` is the asserted call for `create` / `deploy`.
3. `cd app/frontend && npm run lint && npm run build`.
4. Manual end-to-end against a dev API + frontend
   (skills [`04.setup-local-api`](../../.github/skills/04.setup-local-api/SKILL.md)
   and [`05.setup-local-front-end`](../../.github/skills/05.setup-local-front-end/SKILL.md)):
   - Create a deployment with a connected GitHub repo, click **Save & Deploy**.
   - Verify in DB: `status='building'`, `workflow_run_id` populated,
     `azure_container_app_name` and `azure_resource_group` match the workflow
     naming.
   - Verify in GitHub Actions: a `Deploy Generated App` run starts within
     seconds with the correct inputs.
   - Verify the badge transitions Pending → Building → Running (or Failed)
     without the user clicking refresh — driven by the server poller via
     WebSocket plus the frontend 10s safety poll.
5. Delete the deployment: confirm a `destroy` workflow run is dispatched and
   the DB row transitions to `deleted`.

## Further considerations
1. **Pre-existing deployments after cutover.** Rows created via the legacy
   `create` carry ARM-style `azure_container_app_name` (`${env}-${name}`,
   max 32 chars) and `azure_resource_group` (`gov-{projectname}`), which do
   **not** match the workflow's `${env}-${name_safe}-${id8}` /
   `rg-genapp-{name_safe}-{id8}-{env}` scheme. Three options:
   - Option A (recommended): one-shot backfill script that recomputes both
     columns via `computeGenappResourceNames` and `UPDATE`s in place. Run
     once during deploy.
   - Option B: at request time in `case 'deploy'`, detect a mismatch, log a
     warning, and recompute / persist before dispatch. Self-healing but adds
     a branch.
   - Option C: accept that pre-existing rows keep their legacy resources
     until they're deleted and recreated. Simplest, but the next deploy on
     a legacy row will create a *new* RG and Container App, orphaning the
     old one.
2. **Poller token authority.** `dispatchGenappWorkflow` currently uses the
   *invoking user's* GitHub token; the poller will use `process.env.GITHUB_TOKEN`
   (org PAT / app token). If that token is absent in lower environments,
   polling silently no-ops.
   - Option A: add a deployment-scoped service token.
   - Option B: persist the dispatching `user_id` on `project_deployments` and
     re-resolve their token per tick (privacy concern: token reuse beyond the
     user session).
   - Option C: accept the no-op in dev.

   Recommended follow-up: **A**.
3. **Workflow checkout token.**
   [`genapp-deploy.yml`](../../.github/workflows/genapp-deploy.yml) uses
   `secrets.GITHUB_TOKEN` for `actions/checkout` of the user repo — fine for
   repos owned by the pronghorn org, fails for repos owned by external users.
   Mitigated in practice by the pre-deploy auto-push (Phase 1 step 3), which
   makes sure source lands on the org-owned repo first. Real fix is to pass
   the user's token in as a secret-from-input or use a GitHub App
   installation.
4. **`start` / `stop` / `restart` still hit ARM directly.** Acceptable initial
   state; revisit when we add equivalent workflow jobs.
5. **Single-instance assumption for the poller.** Fine while the API runs as
   one Container App replica; if we scale out, two pollers will race. Add an
   advisory DB lock (`pg_try_advisory_lock`) at that point.

# Quickstart — Manual Smoke for Spec 006

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

This procedure is the **mandatory pre-merge smoke test** required by CR-005.
Run it against a non-production environment (`dev` or staging) before the PR
that lands this feature merges to `dev-internal`.

## Pre-requisites

- Local API + frontend stack running per skills
  [04.setup-local-api](../../.github/skills/04.setup-local-api/SKILL.md) and
  [05.setup-local-front-end](../../.github/skills/05.setup-local-front-end/SKILL.md).
- Local PostgreSQL running per skill
  [02.setup-local-postgresql](../../.github/skills/02.setup-local-postgresql/SKILL.md).
- Migration [008_deployment_dispatch_columns.sql](../../infra/migrations/008_deployment_dispatch_columns.sql)
  applied per skill [03.run-local-schema-migration](../../.github/skills/03.run-local-schema-migration/SKILL.md).
- A GitHub repository connected to the test project, with at least one
  committed file.
- Environment variables present in the API process:
  - `AZURE_SUBSCRIPTION_ID`, `GENAPP_ACR_*`, `GENAPP_PG_*` (existing — required by the workflow's Terraform inputs).
  - Either the dispatching user's OAuth token in `github_user_tokens`, or
    `GITHUB_PAT` / `GITHUB_TOKEN` in the API process env.

## Phase A — Pre-merge bench checks

```bash
# API: build + tests for the new service module
cd app/backend
npm run build
npm test -- --testPathPattern="services/deployment/docker"

# Verify functions.ts no longer carries the legacy switch bodies
# (Spec SC-006: at least 1,400 lines shorter than baseline)
wc -l src/routes/functions.ts
git diff main -- src/routes/functions.ts | grep -c '^-' # should be >= 1400

# Verify the flag is gone (Spec SC-005)
grep -r USE_GENAPP_WORKFLOW src/ && echo 'FAIL — flag still present' || echo 'OK — flag removed'

# Frontend: lint + build + Vitest
cd ../frontend
npm run lint
npm run build
npm test -- DeploymentCard
```

All commands must succeed. If `grep` finds any `USE_GENAPP_WORKFLOW`
reference, **do not merge**.

## Phase B — End-to-end deploy (US1)

1. In the UI, open the test project and create a Docker container
   deployment configured against the connected GitHub repo.
2. Click **Save & Deploy**.
3. **Within 5 seconds** verify in PostgreSQL:
   ```sql
   SELECT id, status, workflow_run_id, azure_container_app_name,
          azure_resource_group, dispatched_by_user_id, dispatched_at,
          last_failure_cause
   FROM project_deployments
   WHERE project_id = '<test-project-id>'
   ORDER BY updated_at DESC LIMIT 1;
   ```
   Expected:
   - `status` ∈ `{pending, building}`
   - `workflow_run_id` ≠ NULL (may take one poller tick if GitHub didn't
     return the id at dispatch)
   - `azure_container_app_name` matches the workflow naming scheme:
     `^<env>-<sanitized-name>-<8charid>$`
   - `azure_resource_group` matches: `^rg-genapp-<sanitized-name>-<8charid>-<env>$`
   - `dispatched_by_user_id` = your user id
   - `dispatched_at` ≈ NOW()
   - `last_failure_cause` IS NULL
4. **Without clicking refresh in the UI**, observe the deployment card
   status badge cycle Pending → Building → Running over the workflow's
   natural duration. The UI must converge **only** via WebSocket +
   safety poll; do **not** click refresh.
5. Open the **DevTools Network tab** and confirm the running URL link in
   the badge is reachable.

**Pass criteria**: SC-002 (5-second persistence) + SC-003 (one
poller-interval convergence) both hold.

## Phase C — Edit service config without dispatching (US3)

1. Open the deployment dialog.
2. Change the **Run Command** field. Click **Save** (not Save & Deploy).
3. Verify in PostgreSQL that `run_command` is updated and `updated_at`
   advanced.
4. Verify in GitHub Actions that **no new workflow run** was triggered.
5. Now click **Save & Deploy**. Verify a new run was triggered and the
   workflow `inputs` payload reflects the edited `run_command`.

**Pass criteria**: FR-010 + FR-011 hold; no env-vars were written by the
`updateServiceConfig` action (check `envVars` payload in the workflow inputs
matches the previously persisted env-vars).

## Phase D — Concurrent deploy is rejected (US5 AS1)

In two browser tabs (or two `curl` calls), trigger Save & Deploy against the
**same** deployment row within 1 second.

```bash
# Second call should return 409
curl -X POST .../api/v1/cloud-deployment \
  -H 'Authorization: …' -H 'Content-Type: application/json' \
  -d '{"action":"deploy","deploymentId":"<id>"}'
```

**Pass criteria**: exactly one workflow run started in GitHub Actions; the
second call returned `409`.

## Phase E — Retry from failed (US5 AS2)

1. Set `status='failed'`, `last_failure_cause='workflow-conclusion-failure'`,
   `workflow_run_url='https://…'` on a test row via `psql`.
2. From the UI, click **Save & Deploy** on that row.
3. Verify the API responds `202` (not `409`).
4. Verify in DB:
   - `status` is `pending`/`building`.
   - `last_failure_cause` IS NULL.
   - `workflow_run_url` IS NULL.
   - `workflow_run_id` is a fresh new id (different from the previous one
     after the first poller tick).

**Pass criteria**: FR-009 second sentence + SC-007 hold.

## Phase F — Destroy + destroy-failure recovery (US2, US6)

1. Trigger **Delete** on the deployment from Phase B.
2. Verify in GitHub Actions a `destroy` workflow run starts.
3. Watch the deployment row transition `building → deleted` on successful
   conclusion.
4. To test US6, repeat with a row whose underlying Azure resource group has
   been pre-deleted (simulate a partial-state failure). Verify:
   - Row reaches `failed` with `last_failure_cause =
     'workflow-conclusion-failure-destroy'`, `workflow_run_url` populated.
   - Re-clicking Delete dispatches a fresh destroy run.
   - Row reaches `deleted` on the retry.

**Pass criteria**: FR-018 + US6 acceptance scenarios hold.

## Phase G — Stall window (US4 AS3)

This phase is **optional in dev** (a 30-minute wait per test is impractical).
For the merge, validate in code by running the targeted Jest test:

```bash
cd app/backend
npm test -- --testPathPattern="services/deployment/docker/poller.test.ts" \
  -t "stall window"
```

The Jest test injects `dispatched_at` in the past and asserts the poller
transitions the row to `failed` with
`last_failure_cause='stall-window-exceeded'` on the next tick.

**Pass criteria**: targeted Jest test passes.

## Phase H — Multi-replica advisory lock (US, SC-008)

Run two API processes concurrently against the same Postgres:

```bash
cd app/backend
PORT=4000 npm run dev &
PORT=4001 npm run dev &
```

Trigger a deploy. Tail both API logs and assert that for any single
deployment row, exactly one of the two processes logs
`[deployment-poller] updated row=<id>` per tick; the other logs
`[deployment-poller] skipped (lock not acquired) row=<id>`.

**Pass criteria**: SC-008 holds; no duplicate `UPDATE` and no duplicate
broadcast.

## Phase I — Legacy router deletion (CR-004)

```bash
# These should all return 404 after merge:
curl -i .../api/v1/deployment/<projectId>
curl -i .../api/v1/deployment/<projectId>/<deploymentId>

# Verify the file is gone:
test ! -f app/backend/src/routes/deployment.ts && echo OK || echo FAIL
test ! -f app/backend/src/__tests__/routes/deployment.test.ts && echo OK || echo FAIL
```

**Pass criteria**: all three checks return `OK` / `404`.

## Sign-off

A merge to `dev-internal` requires:

- ✅ Phase A (bench)
- ✅ Phase B (E2E happy path)
- ✅ Phase C (config edit)
- ✅ Phase D (concurrency)
- ✅ Phase E (retry from failed)
- ✅ Phase F (destroy + destroy-failure recovery)
- ✅ Phase G (stall-window Jest test)
- ✅ Phase H (multi-replica advisory lock)
- ✅ Phase I (legacy router deleted)

Record the sign-off in the PR description with the operator's name and the
timestamp of completion.

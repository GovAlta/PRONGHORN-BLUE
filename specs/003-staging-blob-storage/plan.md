# Implementation Plan: Staging Storage Optimization & Blob Migration

**Branch**: `003-staging-blob-storage` | **Date**: 2026-05-19 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/003-staging-blob-storage/spec.md`

## Summary

Reduce database contention in the code editing workflow by eliminating redundant `old_content` storage, replacing the SELECT-DELETE-INSERT save pattern with a single UPSERT, adding batch staging for AI operations, and establishing observability. Phase 2 (blob storage migration) is deferred pending Phase 1 results and subsequent review.

## Technical Context

**Language/Version**: TypeScript (Node 18+, React 18)
**Primary Dependencies**: Express, PostgreSQL (`pg`), Monaco Editor, React Query, `ws` (WebSocket)
**Storage**: PostgreSQL (Azure Flexible Server) — `repo_staging` and `repo_files` tables
**Testing**: Jest (backend), Vitest (frontend) — **zero existing test coverage for staging operations**
**Target Platform**: Azure Container Apps (API), Azure Static Web App / Nginx (Frontend)
**Project Type**: Web application (monorepo: `app/frontend/`, `app/backend/`)
**Performance Goals**: Stage save <500ms p95, commit <3s for 50 files, diff load <1s
**Constraints**: 300 concurrent users, 3,000 projects, zero data loss
**Scale/Scope**: `repo_staging` table currently stores ~2x file content per row (`old_content` + `new_content`)

## Constitution Check

- **Contract Preservation**: The `stage_file_change_with_token` RPC signature changes (stops sending `old_content`). The backend UPSERT already accepts `null` for `old_content` — backward compatible. The `get_staged_changes_with_token` response still includes `old_content` (will be `null` for new writes) — backward compatible. StagingPanel diff viewer contract changes: instead of using `old_content` from the staging record, it fetches baseline from `repo_files`. This is an internal implementation change, not a user-facing contract break. WebSocket broadcasts unchanged. GitHub push flow unchanged.
- **Traceability**: Each task maps to a spec FR/CR requirement. Test coverage is added for every changed path.
- **Verification**: Backend — Jest tests for modified RPC helpers + build. Frontend — Vitest tests for useFileBuffer + StagingPanel diff + build + lint. Stress test validates SC-001 through SC-007.
- **Security and Compliance**: No new auth, secrets, or external connectivity. Staging data access patterns unchanged. No compliance-sensitive data handling changes.
- **Operability**: Application Insights instrumentation added (OR-001 through OR-003). No infrastructure changes in Phase 1. Rollback = revert code, re-enable `old_content` writes via feature flag.
- **UI/UX Layout Immutability**: No layout changes. StagingPanel, CodeEditor, and Build page layouts are untouched. Only internal data flow changes.

## Affected Layers

| Layer                         | Touched? | Validation Required                               |
| ----------------------------- | -------- | ------------------------------------------------- |
| Web App (`app/frontend/src/`) | Yes      | `npm run lint` + `npm run build` in app/frontend/ |
| API (`app/backend/`)          | Yes      | `npm run build` in app/backend/                   |
| Infrastructure (`infra/`)     | No       | N/A — Phase 1 is DB optimization only             |
| CI/CD (`.github/workflows/`)  | No       | N/A                                               |

## Project Structure

### Documentation (this feature)

```text
specs/003-staging-blob-storage/
├── spec.md              # Feature specification (complete)
├── plan.md              # This file
├── research.md          # Phase 0 research findings
├── data-model.md        # Schema change documentation
├── checklists/
│   └── requirements.md  # Requirements quality checklist
└── tasks.md             # Task breakdown (generated via /speckit.tasks)
```

### Source Code (files modified in Phase 1)

```text
app/backend/src/
├── utils/rpcHelpers.ts              # stageFileChangeWithToken — stop writing old_content
├── routes/rpc.ts                    # stage_file_change_with_token RPC + new batch RPC
├── routes/functions.ts              # AI agent staging calls — batch at end of task
└── __tests__/
    ├── utils/staging.test.ts            # New tests for staging UPSERT, batch, null old_content
    ├── utils/stagingObservability.test.ts # New tests for observability instrumentation
    ├── utils/rpcHelpers.test.ts          # Existing tests (unchanged)
    └── routes/aiBatchStaging.test.ts     # New tests for AI batch staging

app/frontend/src/
├── hooks/useFileBuffer.ts           # Remove SELECT-before-UPSERT; use in-memory baseline
├── hooks/__tests__/useFileBuffer.test.ts  # New: buffer save, dirty detection, baseline preservation
├── components/repository/CodeEditor.tsx  # Remove SELECT-before-UPSERT (legacy path)
├── components/__tests__/CodeEditor.save.test.tsx  # New: legacy save path verification
├── components/build/StagingPanel.tsx     # Fetch committed baseline for diffs on-demand
├── components/__tests__/StagingPanel.diff.test.tsx  # New: diff loading with on-demand baseline
└── lib/stagingOperations.ts         # Update stageFile to not send old_content

infra/migrations/
└── 005_drop_old_content.sql         # Phase 1b: ALTER TABLE after validation period
```

---

## TDD Methodology

Every optimisation in Phase 1 follows a **RED → GREEN → REFACTOR → MEASURE** cycle:

1. **RED** — Write characterisation tests against the **current** implementation. These tests document the existing behaviour and serve as a regression safety net. They assert on outcomes (data correctness, RPC calls made, DB operations executed) **and** capture baseline performance numbers.
2. **GREEN** — Run those tests on `main` (or pre-change commit). All must pass — this proves the tests are valid against the existing code.
3. **REFACTOR** — Make the optimisation change.
4. **MEASURE** — Re-run the *same* tests. Functional assertions still pass (no regressions). Performance assertions now show improvement (fewer DB ops, lower latency, reduced storage).

Each task below is structured in this order: characterisation tests first, then the change, then re-verification.

### Test Infrastructure

**Backend (Jest + ts-jest)**
- Config: [app/backend/jest.config.ts](../../app/backend/jest.config.ts) — `preset: 'ts-jest'`, `testEnvironment: 'node'`
- DB mocking: `jest.mock('../../utils/database')` with `mockQuery = jest.fn()` — no real DB needed for unit tests
- HTTP testing: `supertest` for route-level integration tests
- Run: `cd app/backend && npm test` (all suites), `npm test -- --testPathPattern staging` (staging suites only)
- Coverage: `npm run test:coverage`
- Existing pattern: [app/backend/src/__tests__/utils/rpcHelpers.test.ts](../../app/backend/src/__tests__/utils/rpcHelpers.test.ts) — `describe/it`, `mockQuery.mockResolvedValue()`, `beforeEach(() => mockQuery.mockReset())`

**Frontend (Vitest + @testing-library/react)**
- Config: [app/frontend/vitest.config.ts](../../app/frontend/vitest.config.ts) — `environment: 'jsdom'`, `setupFiles: ['./src/test/setup.ts']`
- Hook testing: `renderHook` + `act()` from `@testing-library/react` — established pattern in [useAnonymousProjects.test.ts](../../app/frontend/src/hooks/__tests__/useAnonymousProjects.test.ts)
- Run: `cd app/frontend && npm test` (all suites), `npm test -- --reporter verbose src/hooks/__tests__/useFileBuffer.test.ts` (single file)
- Coverage: `npm run test:coverage`
- Watch mode: `npm run test:watch`

**Infrastructure Validation**
- Run against a local or deployed API + PostgreSQL stack
- Requires Docker Compose (`docker-compose up db api`) or a deployed dev environment
- Capture DB and API metrics via existing test suites and platform telemetry

---

## Phase 1: Optimize Database Usage

### Task 1.1 — Stage Save: Eliminate Redundant `old_content`
**Spec**: FR-001, FR-003 | **Risk**: Low | **Layer**: Backend

#### Step 1 — RED: Characterise Current Behaviour

Write `app/backend/src/__tests__/utils/staging.test.ts`:

```typescript
// Mocking pattern — follows existing rpcHelpers.test.ts
const mockQuery = jest.fn();
jest.mock('../../utils/database', () => ({
  __esModule: true,
  default: { query: mockQuery },
}));
```

| Test (describe: `stageFileChangeWithToken — characterisation`) | Asserts                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `stores old_content when provided`                             | `mockQuery` called with SQL containing `$5` = `"original file content"` (non-null) |
| `stores new_content`                                           | `$6` = `"modified file content"`                                                   |
| `UPSERT handles re-stage of same file`                         | `ON CONFLICT` clause present in SQL; mock returns `RETURNING *` row                |
| `accepts null old_content for new files`                       | `$5` = `null` — already valid path for AI-created files                            |
| `returns the staged row`                                       | result from `mockQuery.mockResolvedValue({ rows: [stagedRow] })`                   |

```bash
# Run on current code — all tests MUST pass
cd app/backend && npm test -- --testPathPattern staging
```

**Baseline metric**: Count the number of `mockQuery` calls per `stageFileChangeWithToken` invocation → **expect 1** (the UPSERT). This confirms the backend is already efficient; the problem is the frontend calling extra RPCs before reaching this function.

#### Step 2 — REFACTOR: Apply Change

- [rpcHelpers.ts#L626](../../app/backend/src/utils/rpcHelpers.ts#L626): `stageFileChangeWithToken` — force `old_content` to `null` regardless of caller input
- [rpc.ts#L1348](../../app/backend/src/routes/rpc.ts#L1348): `stage_file_change_with_token` RPC handler — pass `null` for `p_old_content` to the helper
- [functions.ts#L3100](../../app/backend/src/routes/functions.ts#L3100): AI agent operations — stop passing `old_content` in `edit_lines`, `create_file`, `delete_file`, `move_file`
- Feature flag: `STAGING_WRITE_OLD_CONTENT=true` env var to re-enable old behaviour if needed

**What does NOT change:**
- The `old_content` column stays in the table (backward compat per CR-006)
- The UPSERT SQL is unchanged — it receives `null` for `$5`
- `get_staged_changes_with_token` response still includes `old_content` (will be `null`)

#### Step 3 — MEASURE: Re-run Tests

```bash
cd app/backend && npm test -- --testPathPattern staging
```

| Test                               | Expected result                                                         |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `stores old_content when provided` | **NOW FAILS** — update test to assert `$5` = `null` regardless of input |
| All other characterisation tests   | Pass unchanged                                                          |

Update the failing test to assert the new behaviour (`old_content` is always `null`). This is the intentional "red → green" pivot — the test now documents the optimised contract.

Add new assertion tests:

| Test (describe: `stageFileChangeWithToken — optimised`) | Asserts                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `old_content is null even when caller provides content` | `$5` = `null` even when `oldContent: "some content"` passed    |
| `feature flag re-enables old_content writes`            | With `STAGING_WRITE_OLD_CONTENT=true`, `$5` = provided content |

```bash
cd app/backend && npm test -- --testPathPattern staging
# All tests pass
cd app/backend && npm run build
# Build succeeds
```

---

### Task 1.2 — Save Path: Replace SELECT-DELETE-INSERT with Single UPSERT
**Spec**: FR-001, FR-002, FR-007 | **Risk**: Low | **Layer**: Frontend

#### Step 1 — RED: Characterise Current Save Path

Write `app/frontend/src/hooks/__tests__/useFileBuffer.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
// Mock supabase.rpc and stageFile
```

| Test (describe: `useFileBuffer.saveFileAsync — current behaviour`) | Asserts                                                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `calls get_staged_changes_with_token before staging`               | `supabase.rpc` called with `"get_staged_changes_with_token"` — **spy confirms SELECT happens** |
| `calls unstage_file_with_token when existing staged row found`     | `supabase.rpc` called with `"unstage_file_with_token"` — **spy confirms DELETE happens**       |
| `calls stageFile after unstage`                                    | `stageFile` called with `oldContent` from the SELECT result                                    |
| `total RPC calls per save = 3`                                     | spy call count = 3 (SELECT + DELETE + INSERT)                                                  |
| `preserves old_content from existing staged row`                   | `stageFile` receives `oldContent` matching the mocked SELECT result                            |
| `smart-unstage: reverted content triggers unstage`                 | When `content === originalContent`, `unstageFile` is called instead of `stageFile`             |
| `dirty detection based on lastSavedContent`                        | `file.isDirty` is `true` when `content !== lastSavedContent`                                   |

Write `app/frontend/src/components/__tests__/CodeEditor.save.test.tsx` (same pattern for the legacy `handleSave` path).

```bash
# Run on current code — all tests MUST pass
cd app/frontend && npm test -- src/hooks/__tests__/useFileBuffer.test.ts
cd app/frontend && npm test -- src/components/__tests__/CodeEditor.save.test.tsx
```

**Baseline metric**: Total mocked RPC calls per `saveFileAsync` → **expect 3** (SELECT, DELETE, INSERT).

#### Step 2 — REFACTOR: Apply Change

**`useFileBuffer.saveFileAsync`** ([useFileBuffer.ts#L101](../../app/frontend/src/hooks/useFileBuffer.ts#L101)):

Before (3 DB operations):
```
1. supabase.rpc("get_staged_changes_with_token") — SELECT all staged rows
2. supabase.rpc("unstage_file_with_token")        — DELETE existing
3. stageFile(...)                                  — INSERT new
```

After (1 DB operation):
```
1. stageFile({ oldContent: null, newContent: file.content, ... })  — single UPSERT
```

Operation type determination changes:
- Before: derived from `existing.operation_type` (required SELECT)
- After: derived from in-memory buffer state (`file.isStaged`, `file.id`):
  - `file.isStaged && !file.id` → `"add"` (new file, previously staged)
  - `file.isStaged && file.id` → `"modify"` (existing file, re-staged)
  - `!file.isStaged && file.id` → `"modify"` (committed file, first edit)
  - `!file.isStaged && !file.id` → `"add"` (brand new file)

**`CodeEditor.handleSave`** ([CodeEditor.tsx#L217](../../app/frontend/src/components/repository/CodeEditor.tsx#L217)): Same transformation.

`originalContent` for dirty detection stays in memory — no DB dependency. Smart-unstage stays — only needs in-memory `originalContent` comparison.

#### Step 3 — MEASURE: Re-run Tests

```bash
cd app/frontend && npm test -- src/hooks/__tests__/useFileBuffer.test.ts
```

| Test                                                           | Expected result                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| `calls get_staged_changes_with_token before staging`           | **NOW FAILS** — update to assert this call does NOT happen |
| `calls unstage_file_with_token when existing staged row found` | **NOW FAILS** — update to assert this call does NOT happen |
| `total RPC calls per save = 3`                                 | **NOW FAILS** — update to assert **total = 1**             |
| `preserves old_content from existing staged row`               | **NOW FAILS** — update to assert `oldContent: null`        |
| `smart-unstage: reverted content triggers unstage`             | Passes (uses in-memory comparison, unchanged)              |
| `dirty detection based on lastSavedContent`                    | Passes (in-memory, unchanged)                              |

Update failing tests to assert the new contract. Add:

| Test (describe: `useFileBuffer.saveFileAsync — optimised`) | Asserts                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `single RPC call per save`                                 | `stageFile` called exactly once; no `get_staged_changes_with_token` or `unstage_file_with_token` calls |
| `operation type derived from buffer state`                 | `file.isStaged && file.id` → `"modify"`; `!file.id` → `"add"`                                          |
| `oldContent is always null`                                | `stageFile` receives `oldContent: null`                                                                |

```bash
cd app/frontend && npm test -- src/hooks/__tests__/useFileBuffer.test.ts
cd app/frontend && npm test -- src/components/__tests__/CodeEditor.save.test.tsx
# All tests pass
cd app/frontend && npm run lint && npm run build
# Lint and build succeed
```

**Measurable improvement**: RPC calls per save dropped from **3 → 1** (verified by spy call count).

---

### Task 1.3 — Diff Viewer: On-Demand Baseline from `repo_files`
**Spec**: FR-003, FR-004, FR-005 | **Risk**: Medium | **Layer**: Frontend + Backend

#### Step 1 — RED: Characterise Current Diff Flow

**Backend** — add to `app/backend/src/__tests__/utils/staging.test.ts`:

| Test (describe: `getStagedChangesWithToken — characterisation`) | Asserts                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `returns old_content and new_content for staged rows`           | Mock returns rows with both content fields; assert both are in result |
| `old_content is used by callers for diff baseline`              | Document that callers (StagingPanel) depend on `old_content` field    |

**Frontend** — write `app/frontend/src/components/__tests__/StagingPanel.diff.test.tsx`:

| Test (describe: `StagingPanel diff — current behaviour`) | Asserts                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `passes old_content from staged record to diff viewer`   | `viewingDiff.old_content` passed as `diffOldContent` prop                             |
| `passes new_content from staged record to diff viewer`   | `viewingDiff.new_content` passed as `initialContent` prop                             |
| `new file diff uses empty old_content`                   | When `operation_type === 'add'` and `old_content` is `null`, diff shows all-additions |

```bash
cd app/backend && npm test -- --testPathPattern staging
cd app/frontend && npm test -- src/components/__tests__/StagingPanel.diff.test.tsx
# All pass on current code
```

#### Step 2 — REFACTOR: Apply Change

**Backend** — new RPC `get_file_content_by_path_with_token`:

```sql
SELECT content, is_binary, content_length
FROM repo_files WHERE repo_id = $1 AND path = $2
```

Add to [rpc.ts](../../app/backend/src/routes/rpc.ts) alongside existing RPC handlers.

**Frontend** — [StagingPanel.tsx#L449](../../app/frontend/src/components/build/StagingPanel.tsx#L449):

When user clicks to view diff:
1. `operation_type === 'add'` → baseline = `""` (no RPC needed)
2. `operation_type === 'delete'` → fetch committed content from `repo_files`; `new_content = ""`
3. `operation_type === 'modify'` → fetch committed content from `repo_files`; `new_content` from staging record

Fetch is **on-demand** (click to view), not on panel load.

#### Step 3 — MEASURE: Re-run Tests

```bash
cd app/frontend && npm test -- src/components/__tests__/StagingPanel.diff.test.tsx
```

| Test                                                   | Expected result                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `passes old_content from staged record to diff viewer` | **NOW FAILS** — update to assert baseline fetched from `repo_files` RPC |
| `passes new_content from staged record to diff viewer` | Passes (unchanged)                                                      |
| `new file diff uses empty old_content`                 | Passes (still uses empty string for `add` ops)                          |

Update failing test and add:

| Test (describe: `StagingPanel diff — optimised`)                    | Asserts                                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `modify: fetches baseline from get_file_content_by_path_with_token` | RPC called with correct `repo_id` + `file_path`; response used as `diffOldContent` |
| `delete: fetches full content as baseline`                          | Baseline is committed content; `new_content` is empty                              |
| `add: uses empty baseline without RPC call`                         | No `get_file_content_by_path_with_token` call                                      |
| `baseline fetch is on-demand (not on panel load)`                   | RPC only called after user clicks to view diff                                     |

**Backend** — add to `staging.test.ts`:

| Test (describe: `get_file_content_by_path_with_token`) | Asserts                                             |
| ------------------------------------------------------ | --------------------------------------------------- |
| `returns content for existing committed file`          | Mock returns `{ content: "...", is_binary: false }` |
| `returns null for non-existent path (new file)`        | Mock returns `{ rows: [] }`; result is `null`       |

```bash
cd app/backend && npm test -- --testPathPattern staging
cd app/frontend && npm test -- src/components/__tests__/StagingPanel.diff.test.tsx
cd app/frontend && npm run lint && npm run build
# All pass
```

---

### Task 1.4 — AI Agent: Batch Staging
**Spec**: FR-006, OQ-001 | **Risk**: Medium | **Layer**: Backend

**Note**: Approach below is a proposal; final design requires team review per stakeholder direction.

#### Step 1 — RED: Characterise Current AI Staging

Write `app/backend/src/__tests__/routes/aiBatchStaging.test.ts`:

| Test (describe: `AI file operations — current behaviour`) | Asserts                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `edit_lines calls stageFileChangeWithToken individually`  | After mock AI task with 5 edits → `stageFileChangeWithToken` called 5 times |
| `create_file calls stageFileChangeWithToken individually` | After 3 creates → called 3 times                                            |
| `each staging triggers WebSocket broadcast`               | `ws.broadcast` called N times (once per operation)                          |
| `total DB operations = N for N file changes`              | mockQuery call count = N                                                    |

```bash
cd app/backend && npm test -- --testPathPattern aiBatch
# All pass on current code
```

**Baseline metric**: DB operations per AI task = N (one per file operation).

#### Step 2 — REFACTOR: Apply Change

Formalize `sessionFileRegistry` flush:
1. During AI task execution, file operations update `sessionFileRegistry` only — no DB writes
2. At task end, `batchStageFiles` writes all changes in one transaction:

```sql
BEGIN;
  INSERT INTO repo_staging (...) VALUES ($1, ...) ON CONFLICT (...) DO UPDATE SET ...;
  -- repeated for each file
COMMIT;
```

3. Single `staging_refresh` WebSocket broadcast after batch

**Fallback**: If batch fails, fall back to individual staging and log the failure.

#### Step 3 — MEASURE: Re-run Tests

| Test                                                     | Expected result                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `edit_lines calls stageFileChangeWithToken individually` | **NOW FAILS** — update: individual calls no longer happen during task     |
| `each staging triggers WebSocket broadcast`              | **NOW FAILS** — update: single broadcast after batch                      |
| `total DB operations = N`                                | **NOW FAILS** — update to assert **total = 1 transaction** with N UPSERTs |

Update tests and add:

| Test (describe: `batchStageFiles — optimised`)    | Asserts                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `writes N files in single transaction`            | `mockQuery` called with `BEGIN`, then N UPSERTs, then `COMMIT`         |
| `partial failure rolls back all files`            | On error after 3rd UPSERT, `ROLLBACK` called; no partial rows          |
| `single WebSocket broadcast after batch`          | `ws.broadcast` called exactly 1 time with `staging_refresh`            |
| `fallback to individual staging on batch failure` | After `ROLLBACK`, individual `stageFileChangeWithToken` called N times |

**Measurable improvement**: DB operations dropped from **N → 1 transaction**. WebSocket broadcasts from **N → 1**.

```bash
cd app/backend && npm test -- --testPathPattern aiBatch
cd app/backend && npm run build
# All pass
```

---

### Task 1.5 — Observability Instrumentation
**Spec**: OR-001 through OR-003, SC-008 | **Risk**: Low | **Layer**: Backend

#### Step 1 — RED: Prove No Telemetry Exists

Write `app/backend/src/__tests__/utils/stagingObservability.test.ts`:

| Test (describe: `staging observability — baseline`) | Asserts                                            |
| --------------------------------------------------- | -------------------------------------------------- |
| `stageFileChangeWithToken does not log timing`      | `logger.info` NOT called with `stage_duration_ms`  |
| `commitStagedWithToken does not log timing`         | `logger.info` NOT called with `commit_duration_ms` |

```bash
cd app/backend && npm test -- --testPathPattern stagingObservability
# Tests pass — confirming zero instrumentation
```

#### Step 2 — REFACTOR: Apply Change

1. **Stage timing** (OR-001): Wrap `stageFileChangeWithToken` and `batchStageFiles` — log `{ event: "stage_complete", stage_duration_ms, file_path, operation_type }` via `logger.info`
2. **Staging row count** (OR-002): Log `staging_row_count` on staging operations
3. **Commit timing** (OR-003): Wrap `commit_staged_with_token` — log `{ event: "commit_complete", commit_duration_ms, commit_files_count, success: boolean }`

Implementation: Structured JSON via existing `logger` utility. Container runtime log pipeline ingests into Application Insights.

#### Step 3 — MEASURE: Re-run Tests

| Test                                           | Expected result                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `stageFileChangeWithToken does not log timing` | **NOW FAILS** — update to assert `logger.info` IS called with `stage_duration_ms`  |
| `commitStagedWithToken does not log timing`    | **NOW FAILS** — update to assert `logger.info` IS called with `commit_duration_ms` |

Add:

| Test (describe: `staging observability — instrumented`) | Asserts                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `stage logs include duration_ms and file_path`          | `logger.info` called with object matching `{ stage_duration_ms: expect.any(Number), file_path: "..." }` |
| `commit logs include duration_ms and file_count`        | `logger.info` called with `{ commit_duration_ms: expect.any(Number), commit_files_count: 5 }`           |
| `batch stage logs include file_count`                   | `logger.info` called with `{ staged_count: N }`                                                         |

```bash
cd app/backend && npm test -- --testPathPattern stagingObservability
cd app/backend && npm run build
# All pass
```

---

### Task 1.6 — Database Migration for `old_content` Deprecation
**Spec**: CR-006, CR-007 | **Risk**: Low | **Layer**: Database

**Phase 1a (deploy with code changes)**: No schema change. The `old_content` column stays. New code writes `null`. Old rows with populated `old_content` continue to function.

**Phase 1b (after validation period)**: Once Phase 1 is validated in production:

```sql
-- infra/migrations/005_drop_old_content.sql
-- Prerequisites: All existing staging rows with old_content have been committed or discarded
-- Rollback: ALTER TABLE repo_staging ADD COLUMN old_content text;

-- Step 1: Verify no rows still depend on old_content
-- SELECT count(*) FROM repo_staging WHERE old_content IS NOT NULL;
-- Must return 0 before proceeding

ALTER TABLE repo_staging DROP COLUMN IF EXISTS old_content;
```

**Validation:**
- Migration runs without error on dev database (via local Docker Compose)
- Application functions correctly with column removed
- Rollback migration (re-add column) tested

---

## Phase 2: Blob Storage Migration (Deferred)

Phase 2 technical planning is **deferred** until Phase 1 is implemented, stress tested, and results reviewed. The spec captures the requirements (FR-008 through FR-013) and decisions (hierarchical blob paths, no TTL, orphan cleanup) for when planning resumes.

**Pre-planning artifacts captured in spec:**
- Blob path convention: `staging/{project_id}/{repo_id}/{file_path}`
- No TTL — orphan cleanup job only
- Two-phase commit pattern (blob read + DB write with rollback)
- Local filesystem fallback for development
- Open questions: OQ-002 (SKU/pricing), OQ-004 (two-phase reliability)

**Phase 2 planning trigger**: Completion of Phase 1 validation and stakeholder Go/No-Go review.

---

## Rollback Strategy

### Phase 1 Rollback

- **Code rollback**: Revert the branch. `old_content` writes resume. SELECT-DELETE-INSERT pattern restored.
- **Feature flag**: Set `STAGING_WRITE_OLD_CONTENT=true` to re-enable `old_content` writes without full code revert.
- **Data compatibility**: Rows with `old_content = null` (written during Phase 1) will show empty diffs in the old code path. These rows can be committed or discarded. New staging operations will populate `old_content` again.
- **Database**: No schema change in Phase 1a, so no migration rollback needed. Phase 1b (column drop) has explicit rollback SQL.

### Phase 1 Rollback Validation

- Deploy rollback to dev environment
- Stage, diff, commit, push a file — full cycle completes
- Verify `old_content` is populated in new staging rows

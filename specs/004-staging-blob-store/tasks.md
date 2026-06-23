---
description: "Task list for feature 004-staging-blob-store"
---

# Tasks: Staging Content Blob Storage

**Input**: Design documents from `/specs/004-staging-blob-store/`
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/api-contracts.md](contracts/api-contracts.md)

## Testing Policy (NON-NEGOTIABLE: Test-Driven Development)

This feature changes a safety-critical data path (staged file content). All backend work follows TDD:

1. **Red**: Write the failing unit test first. Run it and capture the failure (compile error, assertion failure, or thrown error).
2. **Green**: Write the minimum production code to make the test pass.
3. **Refactor**: Clean up while keeping tests green.

Required rules for every implementation task:

- Each implementation task in this file is preceded by one or more `[TEST]` tasks. Those tests MUST be authored and MUST be failing before the implementation task starts.
- Each implementation task header lists the test task IDs that gate it (`gates: T0xx, T0xx`). Do not begin the implementation task until those tests fail for the right reason.
- When a phase is divided into cycles, finish the full `[TEST]` -> `[IMPL]` -> `[REFACTOR]` loop for the current cycle before writing tests for the next cycle.
- Production code that is not covered by an authored test in this file MUST NOT be merged.
- All blob storage I/O is unit-tested with a mocked `@azure/storage-blob` client (no live Azure or Azurite calls in unit tests).
- Tests live under [app/backend/src/__tests__/](app/backend/src/__tests__/) and run via Jest (`npm test` in [app/backend/](app/backend/)).
- Frontend has no test tasks because the frontend contract is unchanged; if any frontend code is touched, add Vitest tasks before merging.

## Format: `[ID] [P?] [Story] [Kind?] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Maps task to a user story (US1, US2, US3, US4, US5). Setup, Foundational, and Polish tasks have no story label.
- **[Kind]**: `[TEST]` for failing-test-first tasks, `[IMPL]` for production code that turns red tests green, `[REFACTOR]` for cleanup. Setup/docs tasks have no kind.
- Each task includes the exact target file path.

## Path Conventions

- API source: `app/backend/src/`
- API tests: `app/backend/src/__tests__/`
- Infrastructure / local dev: `docker-compose.yml`, `infra/`
- Docs: `docs/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project-level prerequisites needed before foundational code. No production logic yet, so no test gates required.

- [X] T001 Add `@azure/storage-blob` runtime dependency in [app/backend/package.json](app/backend/package.json)
- [X] T002 [P] Document `AZURE_STORAGE_CONNECTION_STRING` env variable in [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md)
- [X] T003 [P] Add `AZURE_STORAGE_CONNECTION_STRING` and `STAGING_BLOB_CONTAINER` placeholders to [app/backend/.env.example](app/backend/.env.example)

**Checkpoint**: Dependencies and configuration entry points exist; foundational work can begin.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the `BlobStagingStore` abstraction and wire it into API startup. **All user stories depend on this.** Each method is implemented as its own red/green/refactor micro-cycle before the next method begins.

### Cycle 2.1: `BlobStagingStore.writeContent`

- [X] T004 [TEST] Failing unit tests for `BlobStagingStore.writeContent` (uploads to `staging/{repoId}/{filePath}`, overwrites existing blob, throws on transport error) in [app/backend/src/__tests__/utils/blobStagingStore.test.ts](app/backend/src/__tests__/utils/blobStagingStore.test.ts)
- [X] T005 [IMPL] Implement only `BlobStagingStore.writeContent` using a mocked-friendly `@azure/storage-blob` client in [app/backend/src/utils/blobStagingStore.ts](app/backend/src/utils/blobStagingStore.ts) — gates: T004
- [X] T006 [REFACTOR] Refactor `writeContent` naming/error handling and rerun only the `writeContent` tests in [app/backend/src/__tests__/utils/blobStagingStore.test.ts](app/backend/src/__tests__/utils/blobStagingStore.test.ts) — gates: T005

### Cycle 2.2: `BlobStagingStore.readContent`

- [X] T007 [TEST] Failing unit tests for `BlobStagingStore.readContent` (returns content for existing blob, returns `null` for missing blob, surfaces non-404 storage errors) in [app/backend/src/__tests__/utils/blobStagingStore.test.ts](app/backend/src/__tests__/utils/blobStagingStore.test.ts)
- [X] T008 [IMPL] Implement only `BlobStagingStore.readContent` in [app/backend/src/utils/blobStagingStore.ts](app/backend/src/utils/blobStagingStore.ts) — gates: T007
- [X] T009 [REFACTOR] Refactor `readContent` streaming/null-handling and rerun only the `readContent` tests in [app/backend/src/__tests__/utils/blobStagingStore.test.ts](app/backend/src/__tests__/utils/blobStagingStore.test.ts) — gates: T008

### Cycle 2.3: `BlobStagingStore.deleteContent`

- [X] T010 [TEST] Failing unit tests for `BlobStagingStore.deleteContent` (idempotent on missing blob, surfaces non-404 errors) in [app/backend/src/__tests__/utils/blobStagingStore.test.ts](app/backend/src/__tests__/utils/blobStagingStore.test.ts)
- [X] T011 [IMPL] Implement only `BlobStagingStore.deleteContent` in [app/backend/src/utils/blobStagingStore.ts](app/backend/src/utils/blobStagingStore.ts) — gates: T010
- [X] T012 [REFACTOR] Refactor `deleteContent` error classification and rerun only the `deleteContent` tests in [app/backend/src/__tests__/utils/blobStagingStore.test.ts](app/backend/src/__tests__/utils/blobStagingStore.test.ts) — gates: T011

### Cycle 2.4: `BlobStagingStore.writeBatch`

- [X] T013 [TEST] Failing unit tests for `BlobStagingStore.writeBatch` (parallel writes, skips delete operations passed without content, single failure rejects the batch promise) in [app/backend/src/__tests__/utils/blobStagingStore.test.ts](app/backend/src/__tests__/utils/blobStagingStore.test.ts)
- [X] T014 [IMPL] Implement only `BlobStagingStore.writeBatch` by composing `writeContent` without changing existing passing method tests in [app/backend/src/utils/blobStagingStore.ts](app/backend/src/utils/blobStagingStore.ts) — gates: T013
- [X] T015 [REFACTOR] Refactor `writeBatch` batching helpers and rerun the full `BlobStagingStore` method test file in [app/backend/src/__tests__/utils/blobStagingStore.test.ts](app/backend/src/__tests__/utils/blobStagingStore.test.ts) — gates: T014

### Cycle 2.5: `BlobStagingStore.deleteAllContent`

- [X] T016 [TEST] Failing unit tests for `BlobStagingStore.deleteAllContent` (lists and deletes by `staging/{repoId}/` prefix, handles pagination, tolerates empty prefixes) in [app/backend/src/__tests__/utils/blobStagingStore.test.ts](app/backend/src/__tests__/utils/blobStagingStore.test.ts)
- [X] T017 [IMPL] Implement only `BlobStagingStore.deleteAllContent` in [app/backend/src/utils/blobStagingStore.ts](app/backend/src/utils/blobStagingStore.ts) — gates: T016
- [X] T018 [REFACTOR] Refactor prefix construction/pagination helpers and rerun the full `BlobStagingStore` method test file in [app/backend/src/__tests__/utils/blobStagingStore.test.ts](app/backend/src/__tests__/utils/blobStagingStore.test.ts) — gates: T017

### Cycle 2.6: Blob store singleton initialization

- [X] T019 [TEST] Failing unit tests for `initBlobStagingStore()` and `getBlobStagingStore()` (missing env var fails fast, invalid connection string throws, second init is idempotent) in [app/backend/src/__tests__/utils/blobStagingStore.init.test.ts](app/backend/src/__tests__/utils/blobStagingStore.init.test.ts)
- [X] T020 [IMPL] Implement only `initBlobStagingStore()` singleton and `getBlobStagingStore()` accessor that read `AZURE_STORAGE_CONNECTION_STRING` and `STAGING_BLOB_CONTAINER` in [app/backend/src/utils/blobStagingStore.ts](app/backend/src/utils/blobStagingStore.ts) — gates: T019
- [X] T021 [REFACTOR] Refactor singleton reset/test seams and rerun only the initialization tests in [app/backend/src/__tests__/utils/blobStagingStore.init.test.ts](app/backend/src/__tests__/utils/blobStagingStore.init.test.ts) — gates: T020

### Cycle 2.7: Blob operation logging

- [X] T022 [TEST] Failing unit tests asserting structured log fields `blob_op`, `repo_id`, `file_path`, `duration_ms`, `bytes` are emitted for each blob operation in [app/backend/src/__tests__/utils/blobStagingStore.logging.test.ts](app/backend/src/__tests__/utils/blobStagingStore.logging.test.ts)
- [X] T023 [IMPL] Add blob operation logging to existing `BlobStagingStore` methods without changing their public behavior in [app/backend/src/utils/blobStagingStore.ts](app/backend/src/utils/blobStagingStore.ts) — gates: T022
- [X] T024 [REFACTOR] Refactor logging helper code and rerun blob store method plus logging tests in [app/backend/src/__tests__/utils/blobStagingStore.logging.test.ts](app/backend/src/__tests__/utils/blobStagingStore.logging.test.ts) — gates: T023

### Cycle 2.8: API startup wiring

- [X] T025 [TEST] Failing startup test that Express API initialization invokes `initBlobStagingStore()` and fails fast on storage configuration errors in [app/backend/src/__tests__/index.startup.test.ts](app/backend/src/__tests__/index.startup.test.ts)
- [X] T026 [IMPL] Invoke `initBlobStagingStore()` during server startup with fail-fast on missing/invalid connection string in [app/backend/src/index.ts](app/backend/src/index.ts) — gates: T025
- [X] T027 [REFACTOR] Refactor startup initialization ordering and rerun startup plus blob-store initialization tests in [app/backend/src/__tests__/index.startup.test.ts](app/backend/src/__tests__/index.startup.test.ts) — gates: T026

**Checkpoint**: All foundational micro-cycles are green. Blob store singleton is available to all RPC handlers. User stories can proceed in parallel.

---

## Phase 3: User Story 1 - User Saves a File (Stage Write via Blob) (Priority: P1) 🎯 MVP

**Goal**: Single-file save writes content to blob storage at `staging/{repoId}/{filePath}` and stores a metadata-only `repo_staging` row with `new_content = NULL`.

**Independent Test**: Save a file in the editor; verify the blob exists at the deterministic path, `repo_staging.new_content` is `NULL`, and the staging panel renders the file unchanged.

### Red — US1 tests (write first, ensure failing)

- [X] T028 [P] [US1] [TEST] Failing unit test: `stageFileChangeWithToken` writes blob via `BlobStagingStore.writeContent` BEFORE the DB UPSERT in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T029 [P] [US1] [TEST] Failing unit test: UPSERT stores `new_content = NULL` regardless of `shouldWriteStagingOldContent()` value in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T030 [P] [US1] [TEST] Failing unit test: re-staging the same path overwrites the blob and UPSERTs the same row idempotently in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T031 [P] [US1] [TEST] Failing unit test: `operation_type = 'delete'` skips blob write but still UPSERTs the metadata row in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T032 [P] [US1] [TEST] Failing unit test: blob write failure aborts the operation without writing a DB row and surfaces the error in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T033 [P] [US1] [TEST] Failing unit test: DB UPSERT failure after a successful blob write surfaces the error (orphan blob accepted, logged) in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T034 [P] [US1] [TEST] Failing unit test: `staging_refresh` WebSocket broadcast fires exactly once post-UPSERT in [app/backend/src/__tests__/utils/stagingObservability.test.ts](app/backend/src/__tests__/utils/stagingObservability.test.ts)
- [X] T035 [P] [US1] [TEST] Failing unit test: staged-content read path returns blob-backed content when `repo_staging.new_content` is `NULL` so the staging panel/diff viewer still renders saved edits in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T036 [P] [US1] [TEST] Failing unit test: single-file staging preserves existing `old_content` behavior while forcing only `new_content = NULL` in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)

### Green — US1 implementation (gates: T028-T036)

- [X] T037 [US1] [IMPL] Refactor `stageFileChangeWithToken` to write content to `BlobStagingStore` (non-delete ops) before UPSERT, force `new_content = NULL`, and preserve existing `old_content` behavior in [app/backend/src/utils/rpcHelpers.ts](app/backend/src/utils/rpcHelpers.ts) — gates: T028, T029, T030, T031, T032, T033, T036
- [X] T038 [US1] [IMPL] Update staged-content read helper/RPC path to return blob-backed staged content when `repo_staging.new_content` is `NULL`, preserving staging panel and diff viewer behavior in [app/backend/src/utils/rpcHelpers.ts](app/backend/src/utils/rpcHelpers.ts) — gates: T035
- [X] T039 [US1] [IMPL] Update `stage_file_change_with_token` RPC handler to pass through to the blob-backed helper without changing request/response shape in [app/backend/src/routes/rpc.ts](app/backend/src/routes/rpc.ts) — gates: T028, T034
- [X] T040 [US1] [IMPL] Ensure `staging_refresh` WebSocket broadcast continues to fire post-UPSERT in [app/backend/src/routes/rpc.ts](app/backend/src/routes/rpc.ts) — gates: T034

**Checkpoint**: All US1 tests are green. Single-file save persists content in blob storage with metadata-only DB rows. MVP slice deliverable.

---

## Phase 4: User Story 2 - AI Agent Batch-Stages Files (Priority: P1)

**Goal**: AI agent batch staging writes all non-delete file contents to blob storage in parallel, then performs a single DB transaction of metadata-only UPSERTs.

**Independent Test**: Trigger an AI task that edits 20 files; verify 20 blobs exist, 20 staging rows have `new_content = NULL`, and exactly one `staging_refresh` broadcast fires.

### Red — US2 tests (write first, ensure failing)

- [X] T041 [P] [US2] [TEST] Failing unit test: `batchStageFiles` writes all non-delete blobs in parallel via `writeBatch` BEFORE opening the DB transaction in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T042 [P] [US2] [TEST] Failing unit test: mixed create/modify/delete batch only writes blobs for non-delete entries in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T043 [P] [US2] [TEST] Failing unit test: a single blob write failure aborts the entire batch and prevents the DB transaction from executing in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T044 [P] [US2] [TEST] Failing unit test: all `repo_staging` rows for the batch have `new_content = NULL` and one transaction commits all rows in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T045 [P] [US2] [TEST] Failing unit test: batch staging preserves existing `old_content` behavior while forcing only `new_content = NULL` for blob-backed rows in [app/backend/src/__tests__/utils/staging.test.ts](app/backend/src/__tests__/utils/staging.test.ts)
- [X] T046 [P] [US2] [TEST] Failing unit test: the AI agent path in `functions.ts` continues to call `batchStageFiles` and emits a single staging broadcast in [app/backend/src/__tests__/routes/aiBatchStaging.test.ts](app/backend/src/__tests__/routes/aiBatchStaging.test.ts)

### Green — US2 implementation (gates: T041-T046)

- [X] T047 [US2] [IMPL] Refactor `batchStageFiles` to write blobs via `BlobStagingStore.writeBatch()` before the DB transaction, store `new_content = NULL`, and preserve existing `old_content` behavior in [app/backend/src/utils/rpcHelpers.ts](app/backend/src/utils/rpcHelpers.ts) — gates: T041, T042, T043, T044, T045
- [X] T048 [US2] [IMPL] Update `batch_stage_files_with_token` RPC handler to use the blob-backed batch helper without changing the request/response contract in [app/backend/src/routes/rpc.ts](app/backend/src/routes/rpc.ts) — gates: T046
- [X] T049 [US2] [IMPL] Verify and adjust the AI agent batch call site to continue using `rpc.batchStageFiles` with the same payload shape in [app/backend/src/routes/functions.ts](app/backend/src/routes/functions.ts) — gates: T046

**Checkpoint**: All US2 tests are green. AI batch staging stores content in blob storage with one DB transaction and one broadcast.

---

## Phase 5: User Story 3 - User Commits Staged Changes (Priority: P1)

**Goal**: Commit reads staged content from blob storage for non-delete files, writes to `repo_files`, clears staged rows, and performs selective blob cleanup for committed paths only.

**Independent Test**: Stage 5 files (3 modify, 1 create, 1 delete), commit 3 of them; verify those files land in `repo_files`, their blobs are deleted, and the uncommitted files' blobs and staging rows remain intact.

### Red — US3 tests (write first, ensure failing)

- [X] T050 [P] [US3] [TEST] Failing unit test: `commit_staged_with_token` reads blob content via `BlobStagingStore.readContent()` for non-delete staged rows during commit in [app/backend/src/__tests__/routes/commitStaged.test.ts](app/backend/src/__tests__/routes/commitStaged.test.ts)
- [X] T051 [P] [US3] [TEST] Failing unit test: `readContent()` returning `null` for a non-delete staged row causes commit to throw and roll back the DB transaction, preserving staging in [app/backend/src/__tests__/routes/commitStaged.test.ts](app/backend/src/__tests__/routes/commitStaged.test.ts)
- [X] T052 [P] [US3] [TEST] Failing unit test: delete-operation staged rows are committed without any blob read in [app/backend/src/__tests__/routes/commitStaged.test.ts](app/backend/src/__tests__/routes/commitStaged.test.ts)
- [X] T053 [P] [US3] [TEST] Failing unit test: a partial commit only invokes `deleteContent` for committed file paths and leaves other blobs intact in [app/backend/src/__tests__/routes/commitStaged.test.ts](app/backend/src/__tests__/routes/commitStaged.test.ts)
- [X] T054 [P] [US3] [TEST] Failing unit test: post-commit blob cleanup failure does not roll back successful commit and is logged in [app/backend/src/__tests__/routes/commitStaged.test.ts](app/backend/src/__tests__/routes/commitStaged.test.ts)
- [X] T055 [P] [US3] [TEST] Failing unit test: `repo_files` rows are written with the blob-derived content (byte-for-byte) in [app/backend/src/__tests__/routes/commitStaged.test.ts](app/backend/src/__tests__/routes/commitStaged.test.ts)

### Green — US3 implementation (gates: T050-T055)

- [X] T056 [US3] [IMPL] Update `commit_staged_with_token` handler to read non-delete staged content via `BlobStagingStore.readContent()` inside the commit transaction in [app/backend/src/routes/rpc.ts](app/backend/src/routes/rpc.ts) — gates: T050, T052, T055
- [X] T057 [US3] [IMPL] Throw and roll back commit when `readContent()` returns `null` for any non-delete staged row, with an actionable error message in [app/backend/src/routes/rpc.ts](app/backend/src/routes/rpc.ts) — gates: T051
- [X] T058 [US3] [IMPL] After successful commit, call `BlobStagingStore.deleteContent()` for the committed file path set only in [app/backend/src/routes/rpc.ts](app/backend/src/routes/rpc.ts) — gates: T053
- [X] T059 [US3] [IMPL] Ensure cleanup errors after a successful commit are caught and logged without rolling back DB state in [app/backend/src/routes/rpc.ts](app/backend/src/routes/rpc.ts) — gates: T054

**Checkpoint**: All US3 tests are green. Commit moves blob content into `repo_files`, cleans up only committed-path blobs, and never silently loses data.

---

## Phase 6: User Story 4 - User Discards Staged Changes (Priority: P2)

**Goal**: Single-file unstage and full clear-staging operations remove both the `repo_staging` rows and the corresponding blob(s).

**Independent Test**: Stage 3 files, discard one and verify only its blob is removed; discard all and verify the `staging/{repoId}/` prefix is fully cleared.

### Red — US4 tests (write first, ensure failing)

- [X] T060 [P] [US4] [TEST] Failing unit test: `unstage_file_with_token` deletes the matching blob via `BlobStagingStore.deleteContent` in addition to removing the staging row in [app/backend/src/__tests__/routes/unstage.test.ts](app/backend/src/__tests__/routes/unstage.test.ts)
- [X] T061 [P] [US4] [TEST] Failing unit test: clear-staging calls `BlobStagingStore.deleteAllContent()` and removes all matching staging rows in [app/backend/src/__tests__/routes/unstage.test.ts](app/backend/src/__tests__/routes/unstage.test.ts)
- [X] T062 [P] [US4] [TEST] Failing unit test: blob delete failure during discard still removes the DB row and leaves the orphan blob (logged, error not surfaced to user) in [app/backend/src/__tests__/routes/unstage.test.ts](app/backend/src/__tests__/routes/unstage.test.ts)
- [X] T063 [P] [US4] [TEST] Failing unit test: discarding a single file does not affect other staged blobs in the same repo in [app/backend/src/__tests__/routes/unstage.test.ts](app/backend/src/__tests__/routes/unstage.test.ts)

### Green — US4 implementation (gates: T060-T063)

- [X] T064 [US4] [IMPL] Update `unstage_file_with_token` handler to call `BlobStagingStore.deleteContent()` for the file path in [app/backend/src/routes/rpc.ts](app/backend/src/routes/rpc.ts) — gates: T060, T063
- [X] T065 [US4] [IMPL] Update clear-staging path to call `BlobStagingStore.deleteAllContent()` for the repo prefix in [app/backend/src/routes/rpc.ts](app/backend/src/routes/rpc.ts) — gates: T061
- [X] T066 [US4] [IMPL] Wrap discard-path blob cleanup in try/catch and log orphan retention without aborting DB removal in [app/backend/src/routes/rpc.ts](app/backend/src/routes/rpc.ts) — gates: T062

**Checkpoint**: All US4 tests are green. Discard flows keep blob storage in sync with metadata and tolerate cleanup errors.

---

## Phase 7: User Story 5 - Local Development with Azurite (Priority: P2)

**Goal**: Local stack runs Azurite via Docker Compose so developers can exercise the blob-backed staging path without Azure access.

**Independent Test**: Run `docker-compose up`, save/commit/discard via the local API, and verify all blob operations against Azurite.

### Tests for User Story 5

US5 is environment configuration (docker-compose + docs), not production TypeScript code. There is no new application logic to unit-test, so no Jest tasks are added. Validation is performed via the existing quickstart scenarios (T077) against a running Azurite container. If any Azurite wiring is later extracted into application code, add Jest `[TEST]` tasks before that change per the TDD policy above.

### Implementation for User Story 5

- [X] T067 [US5] Add `azurite` service (image `mcr.microsoft.com/azure-storage/azurite`, ports `10000-10002`, persistent volume) to [docker-compose.yml](docker-compose.yml)
- [X] T068 [US5] Add Azurite healthcheck and named volume for blob data persistence in [docker-compose.yml](docker-compose.yml)
- [X] T069 [US5] Document the local Azurite connection string and `STAGING_BLOB_CONTAINER` default in [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md)
- [X] T070 [US5] Document manual verification steps for save/commit/discard against Azurite in [specs/004-staging-blob-store/quickstart.md](specs/004-staging-blob-store/quickstart.md)

**Checkpoint**: Developers can run the full blob-backed flow locally with no cloud dependency.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final hardening, documentation, TDD compliance, and measurable success-criteria validation across all user stories.

- [X] T071 [P] Update [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) to describe staging content storage as blob-backed (metadata-only DB rows)
- [X] T072 [P] Add an Operations note for orphan blob acceptance and future cleanup follow-up in [docs/analysis/008-STAGING_CONTENT_STORE_ABSTRACTION.md](docs/analysis/008-STAGING_CONTENT_STORE_ABSTRACTION.md)
- [X] T073 [REFACTOR] Run backend build and full Jest suite with coverage: `npm run build && npm test -- --coverage --testPathPatterns "staging|blobStagingStore|commitStaged|unstage|aiBatchStaging"` from [app/backend/](app/backend/) — fail if any new file under [app/backend/src/utils/blobStagingStore.ts](app/backend/src/utils/blobStagingStore.ts) or touched lines in [app/backend/src/utils/rpcHelpers.ts](app/backend/src/utils/rpcHelpers.ts) and [app/backend/src/routes/rpc.ts](app/backend/src/routes/rpc.ts) has < 90% branch coverage
- [X] T074 [REFACTOR] Compare changed lines in T011-T066 against the coverage report from T073 and add tests for any uncovered branch in the corresponding `[TEST]` files under [app/backend/src/__tests__/](app/backend/src/__tests__/)
- [X] T075 Validate single-file save p95 latency remains under 500ms by running at least 30 local save/stage operations against Azurite and recording p95 in [specs/004-staging-blob-store/quickstart.md](specs/004-staging-blob-store/quickstart.md)
- [X] T076 Validate AI batch staging of 20 files completes under 2 seconds against Azurite and record elapsed time in [specs/004-staging-blob-store/quickstart.md](specs/004-staging-blob-store/quickstart.md)
- [X] T077 Run the quickstart manual validation scenarios end-to-end against the local Azurite stack per [specs/004-staging-blob-store/quickstart.md](specs/004-staging-blob-store/quickstart.md)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup; BLOCKS all user stories. Execute one micro-cycle at a time: T004-T006 (`writeContent`), then T007-T009 (`readContent`), then T010-T012 (`deleteContent`), then T013-T015 (`writeBatch`), then T016-T018 (`deleteAllContent`), then T019-T021 (singleton init), then T022-T024 (logging), then T025-T027 (startup wiring).
- **User Story 1 (Phase 3)**: Depends on Foundational. All US1 `[TEST]` tasks (T028-T036) precede US1 `[IMPL]` tasks (T037-T040).
- **User Story 2 (Phase 4)**: Depends on Foundational. All US2 `[TEST]` tasks (T041-T046) precede US2 `[IMPL]` tasks (T047-T049).
- **User Story 3 (Phase 5)**: Depends on Foundational; logically depends on US1/US2 producing blob-backed staging rows for end-to-end validation. All US3 `[TEST]` tasks (T050-T055) precede US3 `[IMPL]` tasks (T056-T059).
- **User Story 4 (Phase 6)**: Depends on Foundational. All US4 `[TEST]` tasks (T060-T063) precede US4 `[IMPL]` tasks (T064-T066).
- **User Story 5 (Phase 7)**: Configuration only; depends on Foundational at runtime.
- **Polish (Phase 8)**: Depends on all desired user stories being complete. T073 and T074 are the TDD compliance gates; T075 and T076 validate measurable latency success criteria.

### TDD Gate Order (within every cycle containing production code)

1. Write the single `[TEST]` task for the current cycle in its target file.
2. Run the narrow Jest command for that cycle and confirm the test fails for the expected assertion or missing implementation.
3. Author the gated `[IMPL]` task with the smallest production change that makes that test pass.
4. Run the same narrow Jest command until green, complete the `[REFACTOR]` task, then rerun the same test before starting the next cycle.

### Parallel Opportunities

- Setup tasks T002 and T003 can run in parallel.
- Phase 2 foundational tasks are intentionally not parallelized; they are ordered micro-cycles to keep each blob-store sub-feature independently green before the next starts.
- Story-phase `[TEST]` tasks marked `[P]` can be authored in parallel only after Phase 2 is complete, because they live in disjoint files or disjoint test cases within the same file.
- Phase 6 (US4) and Phase 7 (US5) are file-disjoint and can run in parallel post-Foundational.
- Documentation tasks T071, T072 are `[P]`.

---

## Micro-Cycle Example: `BlobStagingStore.writeContent`

```bash
# Red: write T004 only, then verify it fails.
cd app/backend && npm test -- --testPathPattern blobStagingStore --runTestsByPath src/__tests__/utils/blobStagingStore.test.ts

# Green: complete T005 only, then rerun the same command until green.

# Refactor: complete T006, then rerun the same command before starting T007.
```

---

## Parallel Example: User Story 1 (Red phase)

```bash
# Author all US1 failing tests in parallel before any production code change:
Task: "T028 Blob-write-before-DB test in app/backend/src/__tests__/utils/staging.test.ts"
Task: "T029 new_content = NULL UPSERT test in app/backend/src/__tests__/utils/staging.test.ts"
Task: "T030 Idempotent re-stage test in app/backend/src/__tests__/utils/staging.test.ts"
Task: "T031 Delete-op skips blob write test in app/backend/src/__tests__/utils/staging.test.ts"
Task: "T032 Blob write failure aborts UPSERT test in app/backend/src/__tests__/utils/staging.test.ts"
Task: "T033 DB failure after blob success surfaces error test in app/backend/src/__tests__/utils/staging.test.ts"
Task: "T034 staging_refresh broadcast fires once test in app/backend/src/__tests__/utils/stagingObservability.test.ts"
Task: "T035 staged-content read path returns blob-backed content test in app/backend/src/__tests__/utils/staging.test.ts"
Task: "T036 old_content preservation test in app/backend/src/__tests__/utils/staging.test.ts"

# Verify they fail:
cd app/backend && npm test -- --testPathPattern "staging|stagingObservability"

# Only after confirming red, start T037-T040 implementation.
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T003).
2. Complete Phase 2 micro-cycles in order (T004-T027), proving each blob-store sub-feature works before starting the next.
3. Complete Phase 3: US1 red tests (T028-T036) → confirm failing → green tasks (T037-T040).
4. Validate: save a file and confirm `repo_staging.new_content` is `NULL`, the blob exists, and staged-content reads still return the saved edit.

### Incremental Delivery

1. Foundation (Phase 1 + Phase 2) → blob store available, fully unit-tested.
2. US1 → single-file save uses blob storage and read path still works (MVP).
3. US2 → batch AI staging uses blob storage.
4. US3 → commit reads blob and selectively cleans up.
5. US4 → discard cleans up blob storage.
6. US5 → Azurite local parity.
7. Polish → docs, coverage gate, performance validation, final validation.

### Parallel Team Strategy

Once Foundational is complete:
- Developer A: US1 red tests + impl (T028-T040)
- Developer B: US4 red tests + impl (T060-T066) and US5 (T067-T070)
- Developer C: US2 red tests + impl (T041-T049), then US3 red tests + impl (T050-T059)

---

## Notes

- `[P]` tasks target distinct files (or distinct, well-named test cases within a file) and have no in-phase dependencies on incomplete tasks.
- `[Story]` labels trace tasks back to user stories in [spec.md](spec.md).
- `[TEST]` tasks MUST be failing before their gated `[IMPL]` tasks begin. Capture failure output in commit messages or PR description.
- All staged-content state transitions are documented in [data-model.md](data-model.md); align test fixtures with that lifecycle.
- Contracts in [contracts/api-contracts.md](contracts/api-contracts.md) MUST remain unchanged; any deviation requires a contract amendment.
- No frontend tests are added because the frontend contract is unchanged for this feature.
- Commit after each task or logical group; stop at any checkpoint to validate the story independently.

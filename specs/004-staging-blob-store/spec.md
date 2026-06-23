# Feature Specification: Staging Content Blob Storage

**Feature Branch**: `feature/004-staging-blob-store`
**Created**: 2026-05-21
**Status**: Draft
**Input**: Move staged file content to Azure Blob Storage using convention-based paths
**Architecture Reference**: `docs/analysis/008-STAGING_CONTENT_STORE_ABSTRACTION.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 — User Saves a File (Stage Write via Blob) (Priority: P1)

A user edits a file in the code editor and saves. The system writes the file content to Azure Blob Storage at a deterministic path (`staging/{repoId}/{filePath}`) and records metadata-only in the `repo_staging` database table (`new_content = NULL`). The user experiences no change in behavior — save latency remains under 500ms and the file appears in the staging panel.

**Why this priority**: This is the core write path — every save operation flows through it. Moving content out of PostgreSQL is the primary goal of this feature. All downstream operations (commit, diff, discard) depend on content being in blob storage.

**Independent Test**: Save a file in the editor, verify content exists in blob storage at the expected path, verify `repo_staging.new_content` is NULL, verify the staging panel shows the file.

**Acceptance Scenarios**:

1. **Given** a user edits a file, **When** they save, **Then** the file content is written to blob storage at `staging/{repoId}/{filePath}` and a metadata-only row is UPSERTed into `repo_staging` with `new_content = NULL`
2. **Given** a user re-saves the same file with different content, **When** the save completes, **Then** the blob at the same path is overwritten and the `repo_staging` row is UPSERTed (idempotent)
3. **Given** a user saves a new file (no committed version), **When** the save completes, **Then** the blob is created and the staging row has `operation_type = 'create'`
4. **Given** the blob write succeeds but the DB UPSERT fails, **When** the error occurs, **Then** the user receives an error and the orphan blob remains in storage (acceptable — documented for future cleanup)
5. **Given** the blob write fails, **When** the error occurs, **Then** the error propagates to the user and no DB row is written

---

### User Story 2 — AI Agent Batch-Stages Files (Priority: P1)

An AI agent completes a task that modifies 10–30 files. The system writes all file contents to blob storage in parallel via `writeBatch()`, then executes a single DB transaction with N metadata-only UPSERTs. The user sees all changes appear in the staging panel after a single WebSocket broadcast.

**Why this priority**: AI agent operations produce the highest burst write load. Parallel blob writes eliminate the sequential bottleneck, and metadata-only DB rows reduce transaction size.

**Independent Test**: Trigger an AI task that edits 20 files, verify all 20 blobs exist in storage, verify all 20 `repo_staging` rows have `new_content = NULL`, verify a single WebSocket broadcast fires.

**Acceptance Scenarios**:

1. **Given** an AI agent modifies 20 files, **When** the batch stage completes, **Then** 20 blobs are written in parallel to `staging/{repoId}/{filePath}` and 20 metadata-only rows exist in `repo_staging`
2. **Given** an AI agent creates, modifies, and deletes files in one task, **When** the batch stage runs, **Then** create/modify files are written to blob storage and delete operations skip the blob write (no content)
3. **Given** a blob write fails for one file in a batch of 20, **When** the error occurs, **Then** the entire batch fails, the DB transaction does not execute, and successfully-written blobs become orphans (acceptable)

---

### User Story 3 — User Commits Staged Changes (Priority: P1)

A user selects staged files and commits them. The system reads each non-delete file's content from blob storage using the deterministic path, writes it to `repo_files`, clears the staging rows, and deletes the corresponding blobs. Delete operations skip the blob read. Partial commits (committing a subset of staged files) are supported — only committed files' blobs are deleted.

**Why this priority**: Commit is the operation that moves content from staging to committed state. If this fails, the entire staging workflow breaks. This must handle the blob→DB content transfer reliably.

**Independent Test**: Stage 5 files (3 modify, 1 create, 1 delete), commit only 3 of them, verify committed files appear in `repo_files`, verify blobs for committed files are deleted, verify blobs for uncommitted files survive.

**Acceptance Scenarios**:

1. **Given** a user commits 5 staged files (4 non-delete, 1 delete), **When** the commit completes, **Then** content for the 4 non-delete files is read from blob and written to `repo_files`, the delete file is removed from `repo_files`, staging rows are cleared, and blobs for committed files are deleted
2. **Given** a blob is missing for a non-delete staged file at commit time, **When** the commit runs, **Then** the commit throws an error, the DB transaction rolls back, staging is preserved, and the user is told to re-stage the file
3. **Given** a user commits a subset of staged files (partial commit), **When** the commit succeeds, **Then** only the committed files' blobs are deleted via `deleteContent()`; uncommitted files' blobs and staging rows remain intact
4. **Given** blob cleanup fails after a successful commit, **When** the cleanup error occurs, **Then** the commit is not rolled back (data is safe in `repo_files`), orphan blobs remain, and the error is logged

---

### User Story 4 — User Discards Staged Changes (Priority: P2)

A user discards individual staged files or clears all staging. The system deletes the corresponding blobs in addition to removing the `repo_staging` rows.

**Why this priority**: Without cleanup on discard, orphan blobs accumulate. This is a secondary flow — users discard less frequently than they save or commit — but it's required to prevent unbounded blob growth.

**Independent Test**: Stage 3 files, discard 1, verify its blob is deleted, verify the other 2 blobs remain. Then discard all remaining, verify all blobs are deleted.

**Acceptance Scenarios**:

1. **Given** a user discards a single staged file, **When** the discard completes, **Then** the blob at `staging/{repoId}/{filePath}` is deleted and the `repo_staging` row is removed
2. **Given** a user clears all staging for a repo, **When** the discard completes, **Then** all blobs under `staging/{repoId}/` are deleted (prefix-based) and all `repo_staging` rows for the repo are removed
3. **Given** blob deletion fails during discard, **When** the error occurs, **Then** the staging row is still removed and the orphan blob remains (acceptable)

---

### User Story 5 — Local Development with Azurite (Priority: P2)

A developer runs the local stack with `docker-compose up`. Azurite provides blob storage locally. The developer can save, commit, and discard files with the same blob-based flow as production, without needing an Azure subscription.

**Why this priority**: Developer experience — the blob path must work locally for all developers to test changes. Without this, the feature can't be developed or tested.

**Independent Test**: Start local stack with `docker-compose up`, save a file, verify blob exists in Azurite, commit, verify blob is cleaned up.

**Acceptance Scenarios**:

1. **Given** a developer starts the local stack, **When** `docker-compose up` completes, **Then** Azurite is running and the staging blob container is available
2. **Given** the developer's `.env` has the Azurite connection string, **When** the API starts, **Then** `BlobStagingStore` initializes successfully against Azurite
3. **Given** the developer saves, commits, and discards files, **When** each operation runs, **Then** it behaves identically to the production blob storage path

---

### Edge Cases

- **Concurrent edits to the same file**: Two users (or user + AI agent) stage the same file. Last-write-wins — the blob at `staging/{repoId}/{filePath}` is overwritten and the DB row is UPSERTed. No conflict detection (same as current behavior).
- **Large files (>1MB)**: Blob storage handles large files naturally. The `writeContent()` upload uses `Buffer.byteLength` for accurate content-length. No timeout or memory issues expected for typical source files.
- **Delete operations have no blob**: `operation_type = 'delete'` skips blob write and blob read. The staging row records the deletion intent; the commit handler issues `DELETE FROM repo_files`.
- **Rename operations**: Content is written to blob at the *new* path (`staging/{repoId}/{newPath}`). The staging row stores `old_path` for the commit handler to update `repo_files.path`.
- **Azurite not running**: `initBlobStagingStore()` validates the connection string at startup. If Azurite is down, the API fails to start with a clear error message.
- **Blob storage latency**: Azurite is local (sub-millisecond). Production Azure Blob Storage in-region adds ~10–50ms per operation. Parallel `writeBatch()` mitigates batch latency.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Single-file staging (`stageFileChangeWithToken`) MUST write content to Azure Blob Storage at `staging/{repoId}/{filePath}` before the DB UPSERT, and set `repo_staging.new_content` to NULL
- **FR-002**: Batch staging (`batchStageFiles`) MUST write all file contents to blob storage in parallel via `writeBatch()` before the DB transaction, and set `new_content` to NULL for each row
- **FR-003**: The commit handler (`commit_staged_with_token`) MUST read content from blob storage for non-delete operations using the deterministic path `staging/{repoId}/{filePath}`
- **FR-004**: The commit handler MUST throw an error and abort the DB transaction if a blob is missing for a non-delete staged file (content loss scenario)
- **FR-005**: The commit handler MUST call `deleteContent()` with the list of committed file paths after a successful commit (selective cleanup for partial commits)
- **FR-006**: The discard handler for single files (`unstage_file_with_token`) MUST call `deleteContent()` to remove the blob before or after removing the staging row
- **FR-007**: The discard handler for all staging (clear staging) MUST call `deleteAllContent()` to remove all blobs under the `staging/{repoId}/` prefix
- **FR-008**: Delete operations (`operation_type = 'delete'`) MUST skip blob write during staging and blob read during commit
- **FR-009**: `BlobStagingStore` MUST be initialized as a singleton during Express app startup via `initBlobStagingStore()`, reading `AZURE_STORAGE_CONNECTION_STRING` from environment
- **FR-010**: `BlobStagingStore.readContent()` MUST return null (not throw) when a blob does not exist, allowing callers to distinguish between "no content" and "storage error"

### Compatibility & Operational Requirements

- **CR-001**: The frontend RPC contract (`stage_file_change_with_token`, `batch_stage_files_with_token`, `commit_staged_with_token`) MUST remain unchanged — content is sent as a string parameter, the backend decides where to store it
- **CR-002**: The `repo_staging` table schema MUST NOT change — `new_content` column remains but is set to NULL; no new columns
- **CR-003**: WebSocket broadcast patterns (`staging_refresh`, `repo_files_refresh`, `repos_refresh`) MUST remain unchanged
- **CR-004**: The GitHub push flow MUST remain unchanged — it reads from `repo_files` which is unaffected
- **CR-005**: The diff viewer MUST continue to work — it fetches baselines from `repo_files.content` (unchanged) and staged content is available via blob read at commit time
- **CR-006**: Existing Phase 1 optimizations (single UPSERT, null `old_content`, batch staging, observability logging) MUST remain intact
- **CR-007**: Docker Compose MUST include an Azurite service for local development blob storage

### Key Entities

- **Staged File Content (Blob)**: The actual text content of a staged file, stored in Azure Blob Storage at a deterministic path. Lifecycle: created on stage, read on commit, deleted on commit or discard.
- **Staging Metadata (DB Row)**: The `repo_staging` row containing file path, operation type, repo/project IDs, timestamps. Content column (`new_content`) is NULL when content is in blob storage.
- **BlobStagingStore**: Singleton class that manages blob content lifecycle — write, batch write, read, selective delete, prefix delete. Initialized at API startup.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: File save operations write content to blob storage and record metadata-only DB rows, with `repo_staging.new_content` consistently NULL for all new staging writes
- **SC-002**: Save latency remains under 500ms at the 95th percentile (blob write + DB UPSERT combined)
- **SC-003**: AI batch staging of 20 files completes in under 2 seconds, with parallel blob writes and a single DB transaction
- **SC-004**: Commit operations correctly read content from blob storage and transfer it to `repo_files` for all non-delete files
- **SC-005**: Partial commits delete only the committed files' blobs, leaving uncommitted files' blobs intact
- **SC-006**: Discarding files removes both the staging row and the corresponding blob
- **SC-007**: Local development stack starts successfully with Azurite and all staging operations work against it
- **SC-008**: Zero data loss during save, commit, and discard workflows — missing blob for non-delete operations is detected and reported as an error

## Assumptions

- Azure Blob Storage (or Azurite locally) is available at the connection string specified in `AZURE_STORAGE_CONNECTION_STRING`
- The `@azure/storage-blob` npm package will be added as a production dependency to `app/backend/package.json`
- The `staging` blob container will be created automatically or pre-provisioned (Azurite auto-creates containers on first write)
- Orphan blobs from failed DB writes or failed cleanup are acceptable and will not be addressed in this feature — a background cleanup job is deferred to future work
- The `repo_files` table continues to store committed content inline in PostgreSQL — migrating committed content to blob storage is out of scope
- Binary file handling (`is_binary` flag) is out of scope — this feature covers text content only
- No CI integration tests with Azurite — testing is manual against local Docker Compose stack
- The existing observability instrumentation (stage/commit timing, staging row count) continues to emit metrics; no new observability requirements beyond what 003 Phase 1 added

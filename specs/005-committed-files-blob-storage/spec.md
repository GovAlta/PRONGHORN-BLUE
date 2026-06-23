# Feature Specification: Migrate Committed Repository Files to Blob Storage

**Feature Branch**: `feature/004-staging-blob-store`  
**Created**: 2026-05-25  
**Status**: Draft  
**Input**: User description: "We moved staging files to use blob storage but the commit still uses the PostgreSQL db. Review the full lifecycle of files within the Build tab and features: Stage, Commit, Push to repo, AI Agent and Human interaction with files. We need to remove all PostgreSQL for file management and migrate to Blob Storage."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Commit Reads and Writes File Content via Blob Storage (Priority: P1)

A developer stages changes to one or more files in the Build tab, then commits them. After the commit, the committed file content lives in blob storage — not in the PostgreSQL `repo_files.content` column. The commit record in `repo_commits` tracks file metadata (paths, operations, SHA) but contains no file bytes.

**Why this priority**: Commit is the primary persistence boundary in the file lifecycle. Every downstream operation (push to GitHub, AI agent reads, human file view) reads from the committed store. Eliminating `repo_files.content` writes is the foundation all other stories depend on.

**Independent Test**: Can be fully tested by staging a file, committing it, then asserting content exists at `{repoId}/committed/{filePath}` in blob storage and that `repo_files.content` is NULL (or removed).

**Acceptance Scenarios**:

1. **Given** a staged file with content in `{repoId}/staged/{path}`, **When** the user commits it, **Then** the content is written to `{repoId}/committed/{path}` in blob storage, the `repo_staging` row is deleted, the staging blob is deleted, and a `repo_commits` record exists with the file path and operation type.
2. **Given** a committed file, **When** the user opens it in the Repository viewer, **Then** the content is served from `{repoId}/committed/{path}` blob — no `SELECT content FROM repo_files` query is executed.
3. **Given** a delete operation in staging, **When** committed, **Then** the `{repoId}/committed/{path}` blob is deleted and no new blob is written.
4. **Given** a rename operation in staging, **When** committed, **Then** the old-path blob is deleted and a new blob is written at the new path.
5. **Given** a commit that fails mid-way (e.g., blob write error for the third of five files), **When** the error occurs, **Then** all DB changes are rolled back, any partially written committed blobs are cleaned up, and staging is fully preserved.

---

### User Story 2 - Push to GitHub Reads from Committed Blob Storage (Priority: P2)

When a user or the deployment pipeline triggers "Push to GitHub" from the Build tab, the push reads all file content from committed blob storage. No `repo_files.content` column is read.

**Why this priority**: Push directly depends on committed file content. Once the commit path writes to blob, the push path must follow or it will silently push stale or empty content.

**Independent Test**: Can be tested by committing a file (via US1), triggering a push, and verifying the GitHub API receives content that byte-for-byte matches the committed blob.

**Acceptance Scenarios**:

1. **Given** committed files in `{repoId}/committed/`, **When** the user pushes to GitHub, **Then** all committed blob contents are read and pushed via the GitHub blob-tree-commit-ref API pattern.
2. **Given** a deployment auto-push, **When** triggered, **Then** the auto-push reads from `{repoId}/committed/` blobs, not from `repo_files.content`.
3. **Given** a repo with no committed files in blob storage, **When** a push is attempted, **Then** the operation reports "nothing to push" rather than silently creating an empty commit.

---

### User Story 3 - AI Agent File Reads Use Committed Blob Storage (Priority: P2)

When the AI coding agent reads committed file content (to understand existing code before making changes), it reads from committed blob storage. The agent never reads `repo_files.content` from PostgreSQL. The agent applies a priority chain for resolving file content: in-session edits first, staged blob second, committed blob third. The agent never surfaces empty content when a file is expected to exist.

**Why this priority**: AI agents read many files per session and reading large text blobs from PostgreSQL is a scalability bottleneck. This must be eliminated alongside the commit migration.

**Independent Test**: Can be tested by committing files (US1), triggering an AI agent task that reads those files, and verifying correct content is received with no `SELECT content FROM repo_files` queries executed.

**Acceptance Scenarios**:

1. **Given** committed files in blob storage, **When** the AI agent issues a `read_file` call for a committed (non-staged) file, **Then** the content is served from `{repoId}/committed/{filePath}`.
2. **Given** a file that has both a committed blob and a staged modification, **When** the AI agent reads it, **Then** the staged blob content takes priority over the committed blob (staged-first semantics).
3. **Given** a file that the AI agent has modified in-session (not yet staged), **When** the agent reads it again in the same session, **Then** the in-session registry version takes priority over both the staged and committed blob.
4. **Given** an AI agent `list_files` call, **When** executed, **Then** the file list merges `repo_files` path metadata rows with any new files added to the in-session registry; files marked as deleted in-session are excluded.
5. **Given** an AI agent `search_files` or `wildcard_search` call, **When** executed, **Then** the search covers content from committed blobs and in-session registry entries (staged content that hasn't been committed yet is also searched).
6. **Given** a committed blob that is missing for a path listed in `repo_files` (corrupted or not yet written), **When** the AI agent tries to read it, **Then** the agent receives a clear error identifying the file path rather than empty content or a silent 404.

---

### User Story 4 - Pull from GitHub Writes to Committed Blob Storage (Priority: P3)

When a user links an existing GitHub repository or re-pulls the latest code, the fetched file contents are written to committed blob storage. The `repo_files` table receives only metadata rows (path, is_binary, content_length, last_commit_sha) with no content stored.

**Why this priority**: The initial pull is the inverse of the push. It must be consistent with the new storage model, but only affects new repo onboarding, not daily commit/push workflows.

**Independent Test**: Can be tested by linking a new GitHub repo, then asserting file content exists in `{repoId}/committed/` blobs and that `repo_files.content` is NULL.

**Acceptance Scenarios**:

1. **Given** a GitHub repo with source files, **When** the user links it, **Then** all files are written as blobs to `{repoId}/committed/{filePath}` and `repo_files` rows are created with metadata but no content.
2. **Given** a re-pull of a repo already in blob storage, **When** executed, **Then** existing committed blobs are overwritten and `repo_files` metadata rows are updated (upsert semantics).
3. **Given** a pull that includes a binary file, **When** it completes, **Then** the file is stored correctly in blob storage with `is_binary=true` and accurate `content_length` in `repo_files`.

---

### User Story 5 - Co-editing Session Content Uses Blob Storage (Priority: P2)

When a user or AI agent starts a co-editing session on an artifact, the working document content and the merge baseline are stored in blob storage. The `artifact_collaborations` DB row retains only session metadata (IDs, status, timestamps). On every edit, only the blob is updated — not a TEXT column in PostgreSQL.

**Why this priority**: Co-editing sessions can involve large documents edited hundreds of times in a single sitting. Writing the full document text to a PostgreSQL TEXT column on every keystroke-level update is the highest-volume write pattern in the application. Moving it to blob storage eliminates this pressure on the database.

**Independent Test**: Can be tested by starting a co-editing session, making several edits, and verifying that `artifact_collaborations.current_content` is NULL and the current document content is readable from blob storage at the correct path.

**Acceptance Scenarios**:

1. **Given** a new co-editing session is created, **When** it is initialised, **Then** the initial document content is written to blob storage and `artifact_collaborations.current_content` and `base_content` are NULL.
2. **Given** an active co-editing session, **When** an edit is applied, **Then** the updated full document is written to the blob and the DB row is not updated with content.
3. **Given** a version restore operation, **When** the user restores to a previous version, **Then** the history snapshot blob is read and written back as the current-content blob; no DB content column is touched.
4. **Given** a session where the blob write fails on an edit, **When** the error occurs, **Then** the edit is rejected and the previous blob is preserved intact; no partial content is stored.

---

### User Story 6 - Collaboration Version History Full Snapshots Use Blob Storage (Priority: P3)

When an edit is recorded in `artifact_collaboration_history`, the full-document snapshot (`full_content_snapshot`) is stored in blob storage rather than in the DB row. The delta fields (`old_content`, `new_content`) which contain only the changed line range, remain in the DB row.

The version timeline slider in the editor currently navigates versions synchronously by reading `full_content_snapshot` from the `history[]` array that is already loaded in React state. If snapshots move to blob, the slider must still feel instant. The solution is to **pre-fetch the most recent N snapshot blobs on session load** (in parallel with loading history metadata, configurable via `COLLABORATION_SNAPSHOT_PREFETCH_LIMIT`, default 50) so that by the time the user moves the slider, recent versions are already in client memory. Versions outside the pre-fetched window are fetched on-demand when the slider reaches them. This bounds session-open latency while covering the common case of navigating recent history.

**Why this priority**: The `full_content_snapshot` column stores the entire document at every version. For a 500-line document edited 100 times in a session, this produces ~2MB of text in a single history table query. Moving just this column to blob is the highest-leverage change in the history subsystem. It is P3 (not P2) because the slider pre-fetch adds implementation complexity and the session-load latency trade-off must be acceptable.

**Independent Test**: Can be tested by recording several edits, reloading the session, moving the version slider through all versions, and verifying: (a) `full_content_snapshot` is NULL in all DB rows, (b) slider navigation is instant (content already in memory), (c) each snapshot is readable from blob at the correct path.

**Acceptance Scenarios**:

1. **Given** a collaboration edit is recorded, **When** the insert completes, **Then** the full document snapshot is written to blob at `{collaborationId}/history/{versionNumber}` and `full_content_snapshot` in the DB row is NULL.
2. **Given** a session is opened, **When** the history metadata loads, **Then** the most recent N snapshot blobs (up to `COLLABORATION_SNAPSHOT_PREFETCH_LIMIT`, default 50) are fetched in parallel and held in client memory; versions outside this window are fetched on-demand when selected.
3. **Given** a user moves the version slider, **When** any version is selected, **Then** the editor updates immediately with no loading state (content is already in memory from step 2).
4. **Given** a version restore, **When** the target version's snapshot is read from client memory, **Then** the content is written back as the new `{collaborationId}/current` blob.
5. **Given** a snapshot blob that is missing for a history record (e.g., storage error at write time), **When** the session loads and pre-fetches fail for one version, **Then** that version is marked as unavailable in the slider UI with a clear indicator, and all other versions remain accessible.

---

### Edge Cases

- **Orphan committed blobs after failed commit**: If a commit DB transaction rolls back after some blobs were already written to `committed/`, those blobs will remain as orphans. Cleanup of orphan committed blobs is explicitly out of scope for this feature and deferred to a future dedicated cleanup feature.
- **Concurrent commits to the same file**: Two users committing overlapping file paths simultaneously will result in last-write-wins semantics for both the blob and the `repo_files` metadata row. This matches existing `UPSERT` behaviour and requires no change.
- **Missing committed blob on read**: If a `repo_files` metadata row exists but the corresponding committed blob is missing (e.g., deleted externally or migration failure), the system must return a clear, recoverable error rather than returning empty content or silently serving a 404 body.
- **Blob container access control**: Committed blobs must not be publicly readable. The `committed` container must have `Private` access level, identical to the staging container. Auth is enforced at the API layer via share-token or JWT, not at the blob URL level.
- **Blob path encoding**: File paths with spaces, Unicode characters, or special characters MUST be encoded using `encodeURIComponent` applied to each path segment independently (i.e., `/` separators are kept literal; only the individual segment between separators is encoded). This encoding MUST be applied consistently across all write paths (commit, pull, co-edit init) and all read paths (file viewer, AI agent, push, version restore) within `RepoBlobStore` path-building functions.
- **Large repository listing**: Repos with thousands of committed files must not require loading all blob paths into memory. File listing uses `repo_files` path metadata (SQL query), not a blob prefix scan.
- **Blob storage unavailable**: If the blob container is unreachable, the system must surface a clear operational error. There is no fallback to any DB content column because those columns do not exist in the new application schema.
- **Co-editing concurrent writes**: Two participants editing the same collaboration session simultaneously may produce interleaved blob writes. The blob store uses last-write-wins semantics; the collaboration protocol must ensure edits are serialised at the application layer (e.g., via WebSocket turn-taking) before writing the full snapshot blob.
- **`STAGING_WRITE_OLD_CONTENT` feature flag**: The existing flag `STAGING_WRITE_OLD_CONTENT=true` allows writing old file content to `repo_staging.old_content`. This flag and the code path it guards MUST be permanently removed. The `old_content` column in `repo_staging` must always be NULL and is removed from the schema. The committed blob at `{repoId}/committed/{filePath}` serves as the authoritative "before" baseline for all diff operations.

## Storage Architecture Design

### Why two content namespaces are required

A single file path can have two different content versions in existence simultaneously:

- **Committed version** — the last accepted state of the file, used as the baseline for diffs and as the source of truth for push-to-GitHub.
- **Staged version** — the pending modification, shown on the right side of a diff, read by the AI agent when making further changes.

If both versions shared a single blob path, staging a file would overwrite the committed baseline, making diff views impossible without a separate snapshot mechanism. The two namespaces (`staged/` and `committed/`) ARE the snapshot mechanism.

A metadata-tag approach (one blob path, metadata indicating state) cannot work because Azure Blob Storage allows only one blob at a given path within a container. Tags are properties of a single blob — they do not allow two distinct content versions to coexist at the same path.

### Single container with dual-prefix paths

The current staging implementation stores blobs at path `staging/{repoId}/{filePath}` inside a container also named `staging` — the word "staging" appears twice, which is redundant. The new design removes this ambiguity by using a **single container** (configurable via `REPO_FILES_BLOB_CONTAINER`, default: `generated-apps-files`) with clearly distinct path prefixes:

| Content | Blob path within container |
|---------|----------------------------|
| Staged file | `{repoId}/staged/{filePath}` |
| Committed file | `{repoId}/committed/{filePath}` |
| Co-edit current content | `{collaborationId}/current` |
| Co-edit base content | `{collaborationId}/base` |
| Collaboration version snapshot | `{collaborationId}/history/{versionNumber}` |

**Why one container instead of two separate containers:**

- **Simpler provisioning** — one resource to create, configure, and manage instead of two.
- **Consistent lifecycle policies** — both staged and committed blobs share the same storage account settings (access tier, encryption, retention).
- **Operational clarity** — `deleteAllContent` for a repo can be scoped to a prefix (`{repoId}/staged/` or `{repoId}/committed/`) without risk of hitting the wrong container.
- **Same auth model** — a single private container with Managed Identity authentication covers both namespaces.

**Why two containers would be needed if policies differ:** If in future committed files require a longer retention tier (cool/archive) while staged files remain on hot tier, the single-container approach can be split at that point. The `REPO_FILES_BLOB_CONTAINER` env var is the abstraction boundary.

### Content resolution priority chain

All file reads — whether from the human viewer, GitHub push, or AI agent — follow the same priority order:

```
1. In-session registry (AI agent memory, current session only)
2. Staged blob:     {repoId}/staged/{filePath}
3. Committed blob:  {repoId}/committed/{filePath}
4. Error           (file does not exist)
```

No PostgreSQL `repo_files.content` column exists or is consulted at any point.

## Requirements *(mandatory)*

### Functional Requirements

**Commit**
- **FR-001**: The system MUST write committed file content to `{repoId}/committed/{filePath}` in blob storage when a commit operation completes successfully.
- **FR-002**: The system MUST delete the staged blob at `{repoId}/staged/{filePath}` and the `repo_staging` metadata row as part of the same commit operation.
- **FR-003**: The system MUST NOT write file bytes to `repo_files.content`; the `content` column MUST NOT exist in the schema for this application.
- **FR-004**: The system MUST retain `repo_files` rows for path-based metadata (path, is_binary, content_length, last_commit_sha, created_at, updated_at) to support file listing without scanning blob storage.
- **FR-005**: The system MUST roll back all database changes and clean up any partially written committed blobs if a commit operation fails.

**Push to GitHub**
- **FR-006**: The push-to-GitHub operation MUST read file content from `{repoId}/committed/{filePath}` blobs, using `repo_files` path metadata to enumerate the files.
- **FR-007**: The deployment auto-push MUST read from `{repoId}/committed/` blobs; it MUST NOT read from any `repo_files.content` column.

**AI Agent file operations**
- **FR-008**: The AI agent `read_file` tool MUST resolve file content using the following priority order: (1) in-session registry, (2) staged blob at `{repoId}/staged/{filePath}`, (3) committed blob at `{repoId}/committed/{filePath}`. If none exist, it MUST return an explicit error identifying the file path.
- **FR-009**: The AI agent MUST NOT return empty or null content when a file is expected to exist; missing blobs MUST surface as a named error, not silent empty strings.
- **FR-010**: The AI agent `list_files` tool MUST merge `repo_files` path metadata with the in-session registry; files marked as deleted in-session MUST be excluded from the result.
- **FR-011**: The AI agent `search_files` and `wildcard_search` tools MUST search content from committed blobs and in-session registry entries (not from `repo_files.content`).
- **FR-012**: The AI agent in-session registry MUST take priority over both staged and committed blob content for files modified during the current session.

**Pull from GitHub**
- **FR-013**: The pull-from-GitHub operation MUST write fetched file content to `{repoId}/committed/{filePath}` blobs and upsert `repo_files` metadata rows without populating any content column.

**File viewer**
- **FR-014**: The human file viewer (Repository tab and Build tab diff) MUST fetch committed file content from `{repoId}/committed/{filePath}` blobs.
- **FR-015**: The diff view MUST fetch the committed baseline from `{repoId}/committed/{filePath}` and the staged version from `{repoId}/staged/{filePath}` independently.

**Co-editing content**
- **FR-020**: When a co-editing session is created, the system MUST write the initial document content to blob storage at `{collaborationId}/current` and `{collaborationId}/base`; `artifact_collaborations.current_content` and `base_content` MUST be NULL.
- **FR-021**: When an edit is applied to a co-editing session, the system MUST update the `{collaborationId}/current` blob; it MUST NOT write to `artifact_collaborations.current_content` in PostgreSQL.
- **FR-022**: When a version restore is requested, the system MUST read from `{collaborationId}/history/{versionNumber}` and write the result back to `{collaborationId}/current`; it MUST NOT read or write `full_content_snapshot` from the DB.

**Collaboration version history**
- **FR-023**: When a collaboration edit is recorded in `artifact_collaboration_history`, the full document snapshot MUST be written to blob storage at `{collaborationId}/history/{versionNumber}`; `artifact_collaboration_history.full_content_snapshot` MUST be NULL.
- **FR-023a**: When a collaboration session loads its history, the system MUST pre-fetch the most recent N snapshot blobs in parallel (configurable via `COLLABORATION_SNAPSHOT_PREFETCH_LIMIT`, default 50) and make them available in client memory before the version slider is interactive. Versions outside the pre-fetch window MUST be fetched on-demand when selected. Individual blob fetch failures (pre-fetched or on-demand) MUST mark that version as unavailable in the slider UI rather than failing the entire session load.
- **FR-024**: The `old_content` and `new_content` columns in `artifact_collaboration_history` MAY remain in the DB as they store only the changed line range (bounded delta), not the full document.

**Staging old content removal**
- **FR-025**: The `STAGING_WRITE_OLD_CONTENT` feature flag and its associated code path MUST be permanently removed. The `old_content` column in `repo_staging` MUST always be NULL and MUST be removed from the schema.

**Storage and auth**
- **FR-016**: All blobs for repo files and collaboration content MUST reside in a single blob container (configurable via `REPO_FILES_BLOB_CONTAINER`, default: `generated-apps-files`) with `Private` access level.
- **FR-017**: The blob store MUST use Azure Managed Identity for authentication. No connection strings or SAS tokens with public read access are permitted.
- **FR-018**: The `getFileContentByPathWithToken` function MUST resolve content by checking staged blob first, then committed blob; it MUST return an error if neither exists (no DB fallback).
- **FR-019**: The `getRepoFilesWithToken` function MUST return path metadata from `repo_files` without a content field; callers needing content MUST fetch it from blob storage.

### Compatibility & Operational Requirements *(mandatory for brownfield changes)*

- **CR-001**: Affected contracts: `repo_files` schema (no `content` column), `repo_staging` schema (no `old_content` column, `STAGING_WRITE_OLD_CONTENT` flag removed), `artifact_collaborations` schema (`current_content` and `base_content` columns always NULL then dropped), `artifact_collaboration_history` schema (`full_content_snapshot` column always NULL then dropped), `getRepoFilesWithToken` return shape (no content field), `commitStagedWithToken` write target (blob, not DB), `pullRepoFilesToDatabase` write target (blob, not DB), deployment auto-push read source (committed blob), AI agent `read_file` / `list_files` / `search_files` tool implementations, `getFileContentByPathWithToken` / `getCommittedFileContentByPathWithToken` resolution chains, `handleStagingOperations` dispatcher, `update_artifact_collaboration_with_token` RPC handler, `insert_collaboration_edit_with_token` RPC handler, `restore_collaboration_version_with_token` RPC handler, staging blob path prefix (renamed from `staging/{repoId}/` to `{repoId}/staged/`).
- **CR-002**: The schema migration strategy is two-pronged: (1) `001_full_schema.sql` is edited to omit all content columns from the start — `repo_files` has no `content` column, `repo_staging` has no `old_content` column, `artifact_collaborations` has no `current_content` or `base_content` columns, `artifact_collaboration_history` has no `full_content_snapshot` column — so fresh environment setup never creates them; (2) a new migration file (e.g., `006_remove_content_columns.sql`) is added to `infra/migrations/` to `ALTER TABLE … DROP COLUMN IF EXISTS` for each column, covering any existing dev environments where these columns were previously added. The blob path prefix for staging is changing from the current `staging/{repoId}/` (old format) to `{repoId}/staged/` for clarity; this rename must be applied consistently across `blobStagingStore.ts`, `stagedContentStore.ts`, and all tests.
- **CR-003**: All blobs (staged and committed) use Azure Managed Identity in Azure environments and `DefaultAzureCredential` (`az login`) in local development. The single `generated-apps-files` container must be provisioned with `Private` access level. This is the same auth pattern already used by the existing staged files implementation.
- **CR-004**: Post-deployment validation must: (a) verify no `content` column on `repo_files`, no `old_content` on `repo_staging`, no `current_content`/`base_content` on `artifact_collaborations`, no `full_content_snapshot` on `artifact_collaboration_history`; (b) run a full stage → commit → push cycle and confirm committed blobs exist at the correct paths; (c) run a co-editing session and confirm `{collaborationId}/current` and `{collaborationId}/history/{n}` blobs are created; (d) verify the AI agent reads correct content from committed blobs with no DB content queries.

### Key Entities

- **RepoBlobStore** (unified): Single blob storage abstraction for all file and collaboration content. Uses one container (`generated-apps-files`). Key path-building functions: `stagedBlobPath(repoId, filePath)` → `{repoId}/staged/{filePath}`, `committedBlobPath(repoId, filePath)` → `{repoId}/committed/{filePath}`, `collabCurrentPath(collaborationId)` → `{collaborationId}/current`, `collabBasePath(collaborationId)` → `{collaborationId}/base`, `collabSnapshotPath(collaborationId, versionNumber)` → `{collaborationId}/history/{versionNumber}`. Supports `readContent`, `writeContent`, `deleteContent`, `writeBatch`, `deleteAllContent`, `listPaths`.
- **repo_files (metadata-only)**: PostgreSQL table. Columns: `id`, `repo_id`, `project_id`, `path`, `is_binary`, `content_length`, `last_commit_sha`, `created_at`, `updated_at`. No `content` column.
- **repo_commits**: Unchanged. Records commit history with `files_metadata` JSONB. Stores no file bytes.
- **repo_staging (metadata-only)**: PostgreSQL table. No `old_content` column. `new_content` column remains NULL (already the case). `STAGING_WRITE_OLD_CONTENT` feature flag removed.
- **artifact_collaborations (metadata-only)**: PostgreSQL table. `current_content` and `base_content` columns removed. Retains `id`, `project_id`, `artifact_id`, `title`, `status`, timestamps.
- **artifact_collaboration_history (delta-only)**: PostgreSQL table. `full_content_snapshot` column removed. Retains `old_content` and `new_content` (line-range deltas only), `operation_type`, `start_line`, `end_line`, `narrative`, `actor_type`, `version_number`. On session open, the most recent N snapshot blobs (`{collaborationId}/history/*`, up to `COLLABORATION_SNAPSHOT_PREFETCH_LIMIT` default 50) are fetched in parallel and held in the client's React state; older versions are fetched on-demand when reached via the slider. Note: the current implementation stores the full document in both `old_content` and `new_content` (not true line-range deltas); when the diff implementation is corrected, these columns will shrink to actual delta size.
- **StagedContentStore**: Updated to use `RepoBlobStore` with the `{repoId}/staged/` path convention. The `new_content` and `old_content` DB columns are removed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The following columns do not exist in the database schema from the initial migration: `repo_files.content`, `repo_staging.old_content`, `artifact_collaborations.current_content`, `artifact_collaborations.base_content`, `artifact_collaboration_history.full_content_snapshot`. Zero document or file bytes are stored in PostgreSQL.
- **SC-002**: A complete stage → commit → push cycle for a 50-file repository completes in under 10 seconds end-to-end.
- **SC-003**: All unit and integration tests validate file content by reading from blob storage paths; no test asserts against a `repo_files.content` DB column.
- **SC-004**: The AI agent correctly reads committed and staged file content from blob storage in 100% of test cases, with the correct priority order (in-session → staged → committed) verified by dedicated priority-chain tests.
- **SC-005**: Peak PostgreSQL row size for `repo_files` is bounded to metadata-only fields (no content column), confirmed by schema inspection in CI.

## Clarifications

### Session 2026-05-26

- Q: Should `BlobStagingStore` be replaced by a new `RepoBlobStore` module, or extended in-place? → A: Rename `BlobStagingStore.ts` to `RepoBlobStore.ts` in-place and extend it with committed-path methods (Option B).
- Q: How should orphan committed blobs (written before a failed commit transaction rolls back) be cleaned up? → A: Deferred — out of scope for this feature.
- Q: Should all collaboration version snapshot blobs be pre-fetched on session load, or only a bounded recent set? → A: Pre-fetch only the most recent N snapshots (configurable, default 50); fetch older versions on-demand when the slider reaches them.
- Q: Which encoding scheme should path-building functions use for file paths containing spaces, Unicode, or special characters? → A: `encodeURIComponent` applied to the `filePath` segment only; `/` kept as literal path separators.
- Q: Should content column removals be handled by editing `001_full_schema.sql` directly, or by a new migration file? → A: Both — edit `001_full_schema.sql` to never include the content columns (for new environments) and add a new migration file to drop the columns for existing dev environments that already have them.

## Assumptions

- This is a greenfield application. None of the content columns (`repo_files.content`, `repo_staging.old_content`, `artifact_collaborations.current_content`/`base_content`, `artifact_collaboration_history.full_content_snapshot`) are ever added to the schema.
- Azure Blob Storage is provisioned and accessible in all environments. A single container named `generated-apps-files` (configurable via `REPO_FILES_BLOB_CONTAINER`) is used for both staged and committed file content.
- `BlobStagingStore.ts` is renamed to `RepoBlobStore.ts` in-place and extended with committed-path methods (`committedBlobPath`, `writeCommitted`, `readCommitted`, `deleteCommitted`). No separate module is created and `BlobStagingStore` is not deleted as a distinct step — the rename IS the migration. The staging path prefix is renamed from `staging/` to `staged/` as part of this feature for consistency with the new `committed/` prefix.
- Local development authenticates via `DefaultAzureCredential` picking up the active `az login` session — the same approach as the existing staged files implementation. No local emulator is required.
- The `repo_files` table is retained for path metadata (listing, binary flags, commit SHAs) because scanning a blob container's prefix list at query time is slower and less reliable than a SQL query, especially for large repositories.
- No public-facing or third-party API consumers read file content directly from PostgreSQL; all content access is internal to the application backend and mediated by the API layer auth checks.

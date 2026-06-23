---
description: "Task list for feature: Migrate Committed Repository Files to Blob Storage"
---

# Tasks: Migrate Committed Repository Files to Blob Storage

**Feature**: 005-committed-files-blob-storage  
**Branch**: `feature/004-staging-blob-store`  
**Input**: plan.md, spec.md, data-model.md, contracts/api-contracts.md, research.md

---

## Phase 1: Setup

**Purpose**: Rename blob store module; update all imports and env config so subsequent phases have the correct foundation.

- [x] T001 Rename `app/backend/src/utils/blobStagingStore.ts` to `repoBlobStore.ts` and update class/singleton names (`BlobStagingStore` → `RepoBlobStore`, `getBlobStagingStore` → `getRepoBlobStore`, `initBlobStagingStore` → `initRepoBlobStore`, `resetBlobStagingStoreForTests` → `resetRepoBlobStoreForTests`)
- [x] T002 Update container env var inside `repoBlobStore.ts`: read `REPO_FILES_BLOB_CONTAINER` (default `generated-apps-files`) instead of `STAGING_BLOB_CONTAINER`
- [x] T003 Rename staging path builder from `buildStagingBlobName` to internal `stagedBlobPath`; update staged paths from `staging/{repoId}/{filePath}` to `{repoId}/staged/{encodedFilePath}`; add `encodeBlobPath(filePath)` helper (`filePath.split('/').map(encodeURIComponent).join('/')`)
- [x] T004 Rename public staging methods: `writeContent` → `writeStaged`, `readContent` → `readStaged`, `deleteContent` → `deleteStaged`, `writeBatch` → `writeStagedBatch`, `deleteAllContent` → `deleteAllStaged` in `app/backend/src/utils/repoBlobStore.ts`
- [x] T005 [P] Update all import sites of `getBlobStagingStore` / `initBlobStagingStore` / `resetBlobStagingStoreForTests` to use the new names across the codebase (`stagedContentStore.ts`, `rpcHelpers.ts`, `index.ts`, test files)
- [x] T006 [P] Update `app/backend/.env.example`: add `REPO_FILES_BLOB_CONTAINER=generated-apps-files`; remove `STAGING_BLOB_CONTAINER`; add `COLLABORATION_SNAPSHOT_PREFETCH_LIMIT=50` to both `app/backend/.env.example` and `app/frontend/.env.example`

**Checkpoint**: All existing tests pass (staging behaviour unchanged; only names and path prefix updated).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add committed-path and collaboration-path methods to `RepoBlobStore`; remove `STAGING_WRITE_OLD_CONTENT` flag; update schema — these must be complete before any user story implementation.

- [x] T007 Add committed blob path builder `committedBlobPath(repoId, filePath)` → `{repoId}/committed/{encodedFilePath}` and committed methods `writeCommitted`, `readCommitted`, `deleteCommitted`, `deleteAllCommitted` to `app/backend/src/utils/repoBlobStore.ts`
- [x] T008 [P] Add collaboration blob path builders and methods to `app/backend/src/utils/repoBlobStore.ts`: `collabCurrentPath`, `collabBasePath`, `collabSnapshotPath`; methods `writeCollabCurrent`, `readCollabCurrent`, `writeCollabBase`, `readCollabBase`, `writeCollabSnapshot`, `readCollabSnapshot`
- [x] T009 [P] Remove `shouldWriteStagingOldContent()` helper, `writeOldContent`/`oldContent` fields from `PutStagedFileOptions`, and the `old_content` SQL column reference from `putStagedFile` in `app/backend/src/staging/stagedContentStore.ts`
- [x] T010 Edit `infra/migrations/001_full_schema.sql`: remove `content text NOT NULL` from `repo_files` CREATE TABLE; remove `old_content text` and `new_content text` from `repo_staging`; remove `current_content text` and `base_content text` from `artifact_collaborations`; remove `full_content_snapshot text` from `artifact_collaboration_history`
- [x] T011 [P] Create `infra/migrations/006_remove_content_columns.sql` with `ALTER TABLE repo_files DROP COLUMN IF EXISTS content`, `ALTER TABLE repo_staging DROP COLUMN IF EXISTS old_content`, `ALTER TABLE repo_staging DROP COLUMN IF EXISTS new_content`, `ALTER TABLE artifact_collaborations DROP COLUMN IF EXISTS current_content`, `ALTER TABLE artifact_collaborations DROP COLUMN IF EXISTS base_content`, `ALTER TABLE artifact_collaboration_history DROP COLUMN IF EXISTS full_content_snapshot`
- [x] T012 Update unit tests in `app/backend/src/__tests__/utils/repoBlobStore.test.ts` (renamed from `blobStagingStore.test.ts`): assert staged path = `{repoId}/staged/{encoded}`, committed path = `{repoId}/committed/{encoded}`, write/read round-trips for both, `readCommitted` returns null on missing blob, `deleteAllStaged` scopes to `{repoId}/staged/*`, `deleteAllCommitted` scopes to `{repoId}/committed/*`

**Checkpoint**: `repoBlobStore.ts` compiles with no errors; `001_full_schema.sql` has no content columns; migration 006 file exists.

---

## Phase 3: User Story 1 — Commit Writes to Blob Storage (Priority: P1) 🎯 MVP

**Story goal**: `commitStagedWithToken` writes file content to committed blobs; `repo_files` rows contain metadata only; staging blob is deleted after commit.

**Independent test**: Stage a file → commit → assert `{repoId}/committed/{path}` blob exists → assert `repo_files.content` column is absent → assert staged blob is deleted.

- [x] T013 [US1] Update `commitStagedWithToken` in `app/backend/src/utils/rpcHelpers.ts` for `add`/`create`/`modify`/`edit` ops: read staged blob with `getRepoBlobStore().readStaged(repoId, change.file_path)`; write committed blob with `writeCommitted`; change `repo_files` UPSERT to metadata-only (no `content` column); delete staged blob with `deleteStaged` after transaction commits; **on any error**, delete any committed blobs already written in this batch before re-throwing (blob rollback to prevent orphaned blobs); staging blobs must remain intact after failure
- [x] T014 [US1] Update `commitStagedWithToken` `delete` op: add `getRepoBlobStore().deleteCommitted(repoId, change.file_path)` after deleting from `repo_files`
- [x] T015 [US1] Update `commitStagedWithToken` `rename` op: copy committed blob from old path to new path (`readCommitted` → `writeCommitted` new path → `deleteCommitted` old path)
- [x] T016 [P] [US1] Update `getRepoFilesWithToken` in `app/backend/src/utils/rpcHelpers.ts`: replace `SELECT *` with explicit column list (`id, repo_id, project_id, path, is_binary, content_length, last_commit_sha, created_at, updated_at`) — no `content` column
- [x] T017 [P] [US1] Update `getFileContentByPathWithToken` in `app/backend/src/utils/rpcHelpers.ts`: replace `SELECT content FROM repo_files` fallback with `getRepoBlobStore().readCommitted(repoId, filePath)` fallback; return `{ content, is_binary: false, content_length: content.length }` or `null`
- [x] T018 [US1] Update tests in `app/backend/src/__tests__/utils/staging.test.ts` and `rpcHelpers.test.ts`: `commitStagedWithToken` writes committed blob for modify op; staging blob deleted post-commit; delete op removes committed blob; rename op copies blob; `getRepoFilesWithToken` result has no `content` field; `getFileContentByPathWithToken` priority chain staged → committed → null

---

## Phase 4: User Story 2 — Push to GitHub Reads Committed Blobs (Priority: P2)

**Story goal**: Deployment auto-push and manual push read file content from committed blob storage — `file.content` from DB is never accessed.

**Independent test**: Commit a file (US1 complete) → trigger auto-push → verify GitHub API receives byte-for-byte content from committed blob.

**Depends on**: Phase 3 (US1) complete.

- [x] T019 [US2] Update deployment auto-push in `app/backend/src/routes/functions.ts` (`handleDeploymentService`, `case 'deploy'`): for each file in `allFiles` (metadata only), read `getRepoBlobStore().readCommitted(pushRepoId, file.path)` and pass that content to GitHub blob creation API; use `Promise.all` for parallel reads; if `allFiles` is empty or all `readCommitted` calls return null, skip the GitHub commit API call and return a "nothing to push" response rather than creating an empty commit
- [x] T020 [P] [US2] Audit `handleDeploymentService case 'create'` for any `file.content` DB references; if found, apply the same committed blob read pattern as T019 (`readCommitted` per file via `Promise.all`); document the outcome in a code comment regardless of whether changes were needed

---

## Phase 5: User Story 3 — AI Agent File Reads Use Committed Blobs (Priority: P2)

**Story goal**: The AI agent's `resolveFile`, `search`, and `wildcard_search` operations never read `repo_files.content`; committed blobs serve as the source of truth for all committed file content.

**Independent test**: Commit files (US1 complete) → start AI agent session → issue `read_file` call → verify correct content served from committed blob with no DB content query.

**Depends on**: Phase 3 (US1) complete.

- [x] T021 [US3] Update `resolveFile` inside `handleCodingAgentOrchestrator` in `app/backend/src/routes/functions.ts`: after the staging fallback, add `getRepoBlobStore().readCommitted(repoId, filePath)` as the committed blob fallback; use `repo_files` row only for metadata (`id`, `path`); return clear error if blob also absent
- [x] T022 [P] [US3] Update `case 'search'` inside `handleCodingAgentOrchestrator` in `app/backend/src/routes/functions.ts`: for each file in `getRepoFilesWithToken` result, read `getRepoBlobStore().readCommitted(repoId, f.path)` to get content for keyword matching; also search in-session registry entries (new/modified files not yet staged) for the same keyword
- [x] T023 [P] [US3] Update `case 'wildcard_search'` inside `handleCodingAgentOrchestrator` in `app/backend/src/routes/functions.ts`: same committed blob read pattern as `search`; also include in-session registry entries in the wildcard match
- [x] T037 [P] [US3] Verify `list_files` result merges `repo_files` path metadata with new files added to the in-session registry; verify files marked as deleted in the in-session registry are excluded from the result; add/update unit tests in the AI agent test suite to confirm this merge behaviour

---

## Phase 6: User Story 4 — Pull from GitHub Writes to Committed Blobs (Priority: P3)

**Story goal**: `pullRepoFilesToDatabase` writes fetched file content to committed blobs; `repo_files` rows are metadata-only.

**Independent test**: Link a new GitHub repo → assert committed blobs exist at `{repoId}/committed/{path}` → assert `repo_files` rows have no `content` column.

- [x] T024 [US4] Update `pullRepoFilesToDatabase` in `app/backend/src/routes/functions.ts`: for each decoded file, call `getRepoBlobStore().writeCommitted(repoId, filePath, content)`; change `repo_files` UPSERT SQL to metadata-only (no `content` column): `INSERT INTO repo_files (repo_id, project_id, path, is_binary, content_length, last_commit_sha, ...) ON CONFLICT DO UPDATE SET is_binary=..., content_length=..., last_commit_sha=..., updated_at=NOW()`; for binary files, decode Base64 before calling `writeCommitted`; set `is_binary=true` and `content_length` from the decoded byte length

---

## Phase 7: User Story 5 — Co-editing Session Content Uses Blob Storage (Priority: P2)

**Story goal**: Collaboration current content and base content are stored as blobs; `artifact_collaborations.current_content` and `base_content` columns are absent from the schema and never written.

**Independent test**: Start a co-editing session → make edits → assert `artifact_collaborations.current_content` is NULL → assert current content readable from `{collaborationId}/current` blob.

**Depends on**: Phase 2 (T008) complete.

- [x] T025 [US5] Update `update_artifact_collaboration_with_token` in `app/backend/src/routes/rpc.ts`: if `p_current_content` is provided, call `getRepoBlobStore().writeCollabCurrent(p_collaboration_id, p_current_content)`; remove `current_content = $n` from the UPDATE SET clause; if `writeCollabCurrent` throws, return an error response to the client and do not proceed with the DB UPDATE — the prior blob content must remain intact
- [x] T026 [P] [US5] Update `restore_collaboration_version_with_token` in `app/backend/src/routes/rpc.ts`: replace `SELECT full_content_snapshot FROM artifact_collaboration_history` with `getRepoBlobStore().readCollabSnapshot(p_collaboration_id, p_version_number)`; replace `UPDATE artifact_collaborations SET current_content = $2` with `getRepoBlobStore().writeCollabCurrent(p_collaboration_id, content)`; return 404 if snapshot blob is null
- [x] T036 [US5] Update the collaboration session *creation* handler in `app/backend/src/routes/rpc.ts` (the RPC or route that inserts a new `artifact_collaborations` row): write initial document content to `{collaborationId}/current` blob via `getRepoBlobStore().writeCollabCurrent(collaborationId, initialContent)` and the merge baseline to `{collaborationId}/base` via `writeCollabBase`; do not write `current_content` or `base_content` DB columns

---

## Phase 8: User Story 6 — Collaboration Version Snapshots Use Blob Storage (Priority: P3)

**Story goal**: `full_content_snapshot` is written to blob on every edit; the column is absent from `artifact_collaboration_history`; the frontend pre-fetches the most recent 50 snapshots on session load for instant slider navigation.

**Independent test**: Record several edits → reload session → move version slider → verify `full_content_snapshot` is NULL in all DB rows → verify content in each snapshot blob → verify slider navigation has no loading states for the last 50 versions.

**Depends on**: Phase 7 (US5) complete.

- [x] T027 [US6] Update `insert_collaboration_edit_with_token` in `app/backend/src/routes/rpc.ts`: if `p_new_full_content` provided, call `getRepoBlobStore().writeCollabSnapshot(p_collaboration_id, nextVersion, p_new_full_content)`; insert DB row with `full_content_snapshot = NULL` (column will be dropped by migration 006)
- [x] T028 [US6] Create `app/backend/src/routes/v1/collaboration.ts`: implement `GET /api/v1/collaboration/:collaborationId/snapshot/:versionNumber`; validate UUID and integer params; call `getRepoBlobStore().readCollabSnapshot`; return `{ content, versionNumber, collaborationId }` or 404; register route in the existing v1 router
- [x] T029 [P] [US6] Search `app/frontend/src/components/` for the collaboration viewer/panel component and record its exact file path before starting; then update that component: on session load after history metadata fetch, identify last `min(50, history.length)` versions; dispatch parallel `GET /api/v1/collaboration/{id}/snapshot/{n}` calls; store results in a `Map<number, string>` in component state; pass snapshot content to version slider from map; fall back to on-demand fetch for versions outside the pre-fetched window; mark unavailable (not failed) if a pre-fetch 404s

---

## Phase K: Data Backfill (Pre-Migration Safety)

**Purpose**: Before migration 006 is applied to any environment that already has data in `repo_files.content`, `artifact_collaborations.current_content`, or `artifact_collaboration_history.full_content_snapshot`, all non-null values must be written to blob storage. This phase **MUST run before T033** (executing migration 006) to prevent permanent data loss.

- [x] T035 Write and run a one-time backfill script `app/backend/src/scripts/backfillContentToBlob.ts` that: (1) queries `repo_files WHERE content IS NOT NULL` → `getRepoBlobStore().writeCommitted(repo_id, path, content)` for each row; (2) queries `artifact_collaborations WHERE current_content IS NOT NULL` → `getRepoBlobStore().writeCollabCurrent(id, current_content)` for each row; (3) queries `artifact_collaboration_history WHERE full_content_snapshot IS NOT NULL` → `getRepoBlobStore().writeCollabSnapshot(collaboration_id, version_number, full_content_snapshot)` for each row; (4) verifies blob-written count matches non-null row count per table before exiting with success code; **abort and do NOT proceed to migration 006 if any write fails**

**Checkpoint**: Script exits 0 and reports matching counts for all three tables. Only then proceed to Final Phase.

---

## Final Phase: Polish & Cross-Cutting Concerns

- [x] T030 [P] Run `npm run build` in `app/backend/` and fix any TypeScript compile errors caused by removed `content` field references across `functions.ts`, `rpcHelpers.ts`, `rpc.ts`
- [x] T031 [P] Run `npm run lint` in `app/frontend/` and `app/backend/`; resolve lint errors
- [x] T032 Run full test suite (`npm test` from repo root); fix any test failures caused by schema or return-shape changes
- [x] T033 [P] Run migration 006 on local dev DB (`psql ... -f infra/migrations/006_remove_content_columns.sql`) and verify columns are dropped; start API and confirm no startup errors; also confirm `generated-apps-files` blob container has Private access level in `infra/modules/storage/` Terraform module
- [x] T034 [P] Update `specs/005-committed-files-blob-storage/quickstart.md` if any local dev steps changed during implementation

---

## Dependencies

```
Phase 1 (Setup)
  └── Phase 2 (Foundational)
        ├── Phase 3 (US1 — Commit) 🎯 MVP
        │     ├── Phase 4 (US2 — Push to GitHub)
        │     └── Phase 5 (US3 — AI Agent)
        ├── Phase 6 (US4 — Pull from GitHub)  [independent of US2/US3]
        ├── Phase 7 (US5 — Co-editing current content)
        │     └── Phase 8 (US6 — Collaboration snapshots)
        └── Phase K (Data Backfill — MUST precede migration 006)
              └── Final Phase (Polish)
```

## Parallel Execution

**Within Phase 2** (after T007 starts): T008 (collaboration paths), T009 (flag removal), T010/T011 (schema), T012 (tests) can all run in parallel.

**Within Phase 3**: T013–T015 are sequential (commit op variants). T016 and T017 are independent of each other and of T013.

**Phases 4, 5, 6, 7** can all start in parallel once Phase 3 is complete (they depend on Phase 2 foundation, not on each other).

## Implementation Strategy

**MVP scope (suggested)**: Complete Phases 1–3 and Final Phase. This delivers the highest-value change (commit writes to blob; `repo_files.content` absent) and validates the end-to-end blob write/read round-trip before tackling push, AI agent, and collaboration.

**Incremental delivery order**: Phase 3 → Phase 4 → Phase 5 → Phases 6 & 7 in parallel → Phase 8 → Final Phase.

## Format Validation

All tasks follow `- [ ] T### [P?] [Story?] Description with file path` format.  
Tasks with `[P]` can be parallelised. Tasks with `[US#]` map to user stories in spec.md.  
Setup/Foundational/Polish tasks have no story label.

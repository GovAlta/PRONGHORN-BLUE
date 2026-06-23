# Implementation Plan: Migrate Committed Repository Files to Blob Storage

**Feature**: 005-committed-files-blob-storage  
**Branch**: `feature/004-staging-blob-store`  
**Spec**: `specs/005-committed-files-blob-storage/spec.md`  
**Constitution**: `.specify/memory/constitution.md` (v1.1.0)  
**Status**: Draft — Phase 2 Planning Complete

---

## Summary

Migrate all file content that is currently stored in PostgreSQL (`repo_files.content`, `artifact_collaborations.current_content`, `artifact_collaborations.base_content`, `artifact_collaboration_history.full_content_snapshot`) to Azure Blob Storage using a unified `RepoBlobStore` module. The PostgreSQL tables retain only metadata. This eliminates the PostgreSQL row-size bottleneck, enables large-file support, and reduces DB load for file-intensive operations.

---

## Technical Context

| Category | Detail |
|--|--|
| Runtime | Node 18+ |
| Language | TypeScript (strict) |
| API Framework | Express 4 |
| Database | PostgreSQL 15 via `pg` |
| Blob Storage | Azure Blob Storage (`@azure/storage-blob`) |
| Auth (Blob) | DefaultAzureCredential (Managed Identity in Azure; `az login` + DefaultAzureCredential for local dev) |
| Frontend | React 18, TypeScript, Vite, shadcn/ui, React Query |
| Test frameworks | Jest (API), Vitest (frontend) |
| Local blob auth | `az login` + `DefaultAzureCredential` (same as staged files) |
| Container name | `generated-apps-files` (`REPO_FILES_BLOB_CONTAINER` env var) |

---

## Constitution Check

| Principle | Status | Notes |
|--|--|--|
| I. Security First | ✅ PASS | Blob access uses Managed Identity (Azure) or `az login` + DefaultAzureCredential (local). No credentials in code. No new attack surface. |
| II. UI/UX Layout Immutability | ✅ PASS | Only frontend change is the collaboration version slider pre-fetch — no layout alteration; existing component wired to a new data source. |
| III. Versioned API | ✅ PASS | New collaboration snapshot endpoint added under `/api/v1/`. Existing RPC endpoints retain same request shape. |
| IV. Spec-Driven Development | ✅ PASS | Full spec + clarifications + research + data-model + contracts + plan present. |
| V. Infrastructure as Code | ✅ PASS | Container creation handled via Terraform (`infra/modules/storage/`); migration SQL in `infra/migrations/`. |
| VI. Test Coverage | ⚠️ REQUIRED | Affected tests must be updated; new tests required for committed blob write path (see Testing section). |

**Gate decision**: No violations. Safe to proceed.

---

## Affected Layers

| Layer | Affected | Key Changes |
|--|--|--|
| API (`app/backend/`) | ✅ Yes | `blobStagingStore.ts` renamed + extended; `rpcHelpers.ts` commit + read paths; `functions.ts` pullRepoFiles + AI agent + deploy auto-push; `routes/rpc.ts` collaboration RPCs; new collaboration snapshot route |
| Frontend (`app/frontend/`) | ✅ Yes (minimal) | Collaboration version slider: parallel blob fetches for snapshot content on session load; no layout change |
| Infrastructure (`infra/`) | ✅ Yes | `001_full_schema.sql` — remove content columns; new `006_remove_content_columns.sql` |
| CI/CD (`.github/workflows/`) | ❌ No | No workflow changes required |

---

## Project Structure

```text
app/backend/src/
  utils/
    repoBlobStore.ts            ← rename from blobStagingStore.ts
    rpcHelpers.ts               ← commit, read, and metadata-only paths updated
  staging/
    stagedContentStore.ts       ← remove STAGING_WRITE_OLD_CONTENT; update import to repoBlobStore
  routes/
    functions.ts                ← pullRepoFilesToDatabase; AI agent resolveFile/search; deploy auto-push
    rpc.ts                      ← collaboration content RPCs
    v1/
      collaboration.ts          ← NEW: GET /api/v1/collaboration/:id/snapshot/:version
  __tests__/
    utils/
      repoBlobStore.test.ts     ← rename from blobStagingStore.test.ts; update paths; add committed tests
      rpcHelpers.test.ts        ← update shape tests; fallback chain tests
    routes/
      staging.test.ts           ← update commitStagedWithToken tests

infra/
  migrations/
    001_full_schema.sql         ← remove content columns from table definitions
    006_remove_content_columns.sql  ← NEW: DROP COLUMN IF EXISTS for existing envs

app/frontend/src/
  (collaboration viewer component)  ← parallel snapshot fetch on session load
```

---

## Implementation Phases

### Phase A — Storage Abstraction (RepoBlobStore)

**Goal**: Extend and rename the blob storage module. All blob I/O goes through this singleton.

**Files modified**:
- `app/backend/src/utils/blobStagingStore.ts` → `repoBlobStore.ts`

**Changes**:
1. Rename file and class: `BlobStagingStore` → `RepoBlobStore`.
2. Rename singleton functions: `initBlobStagingStore` → `initRepoBlobStore`, `getBlobStagingStore` → `getRepoBlobStore`, `resetBlobStagingStoreForTests` → `resetRepoBlobStoreForTests`.
3. Update container env var: `STAGING_BLOB_CONTAINER` → `REPO_FILES_BLOB_CONTAINER` (default `generated-apps-files`).
4. Rename staging path builders: `buildStagingBlobName(repoId, filePath)` → internal `stagedBlobPath(repoId, filePath)` returning `{repoId}/staged/{encoded(filePath)}`.
5. Rename existing public methods: `writeContent` → `writeStaged`, `readContent` → `readStaged`, `deleteContent` → `deleteStaged`, `writeBatch` → `writeStagedBatch`, `deleteAllContent` → `deleteAllStaged`.
6. Add path encoding helper: `encodeBlobPath(filePath: string): string` — `filePath.split('/').map(encodeURIComponent).join('/')`.
7. Add committed-path methods: `committedBlobPath`, `writeCommitted`, `readCommitted`, `deleteCommitted`, `deleteAllCommitted`.
8. Add collaboration-path methods: `collabCurrentPath`, `collabBasePath`, `collabSnapshotPath`, `writeCollabCurrent`, `readCollabCurrent`, `writeCollabBase`, `readCollabBase`, `writeCollabSnapshot`, `readCollabSnapshot`.

**Invariants**:
- `readStaged` / `readCommitted` return `null` if blob does not exist (404 → null, not throw).
- `writeStaged` / `writeCommitted` create/overwrite without error if container exists.
- Encoding applied per-segment to both staged and committed paths.

**Tests** (`repoBlobStore.test.ts`):
- Staged path = `{repoId}/staged/{encoded}`
- Committed path = `{repoId}/committed/{encoded}`
- Write/read round-trip for staged and committed
- `readCommitted` returns null when blob absent
- `deleteAllStaged` deletes only `{repoId}/staged/*`
- `deleteAllCommitted` deletes only `{repoId}/committed/*`

---

### Phase B — StagedContentStore Cleanup

**Goal**: Remove `STAGING_WRITE_OLD_CONTENT` feature flag; update import from RepoBlobStore.

**Files modified**:
- `app/backend/src/staging/stagedContentStore.ts`

**Changes**:
1. Update import: `getBlobStagingStore` → `getRepoBlobStore`.
2. Update all call sites: `.writeContent` → `.writeStaged`, `.readContent` → `.readStaged`, `.deleteContent` → `.deleteStaged`, `.writeBatch` → `.writeStagedBatch`, `.deleteAllContent` → `.deleteAllStaged`.
3. Remove `shouldWriteStagingOldContent()` helper function.
4. Remove `writeOldContent` and `oldContent` fields from `PutStagedFileOptions`.
5. Remove the `old_content` column reference in `putStagedFile` SQL.

---

### Phase C — Commit Staged → Committed Blob

**Goal**: `commitStagedWithToken` writes file content to committed blob; `repo_files` receives metadata only.

**Files modified**:
- `app/backend/src/utils/rpcHelpers.ts`

**Changes to `commitStagedWithToken`**:

For `add`, `create`, `modify`, `edit` operations:
1. Read staged blob: `const content = await getRepoBlobStore().readStaged(repoId, change.file_path)`.
2. If null → throw `Missing staged blob content for ${change.file_path}`.
3. Write committed blob: `await getRepoBlobStore().writeCommitted(repoId, change.file_path, content)`.
4. UPSERT `repo_files` metadata only (no `content` column):
   ```sql
   INSERT INTO repo_files (repo_id, project_id, path, is_binary, content_length, last_commit_sha, created_at, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
   ON CONFLICT (repo_id, path) DO UPDATE SET
     is_binary = $4, content_length = $5, last_commit_sha = $6, updated_at = NOW()
   ```
5. After successful transaction: `await getRepoBlobStore().deleteStaged(repoId, change.file_path)`.

For `delete` operations:
- Delete from `repo_files` (unchanged).
- Add: `await getRepoBlobStore().deleteCommitted(repoId, change.file_path)`.

For `rename` operations:
- After DB rename: `await getRepoBlobStore().writeCommitted(repoId, newPath, await getRepoBlobStore().readCommitted(repoId, oldPath))` then `await getRepoBlobStore().deleteCommitted(repoId, oldPath)`.

**Changes to `getFileContentByPathWithToken`**:
- Remove the `SELECT content ... FROM repo_files` fallback.
- Add committed blob fallback:
  ```ts
  const committed = await getRepoBlobStore().readCommitted(repoId, filePath);
  if (committed !== null) {
    return { content: committed, is_binary: false, content_length: committed.length };
  }
  return null;
  ```
- The staged blob check (via `getStagedContent`) remains first in chain.

**Changes to `getRepoFilesWithToken`**:
- Replace `SELECT *` with explicit column list excluding `content`:
  ```sql
  SELECT id, repo_id, project_id, path, is_binary, content_length, last_commit_sha, created_at, updated_at
  FROM repo_files WHERE ...
  ```

**Tests** (`rpcHelpers.test.ts`, `staging.test.ts`):
- `commitStagedWithToken` writes committed blob for `modify` op.
- `commitStagedWithToken` deletes staged blob after commit.
- `commitStagedWithToken` deletes committed blob for `delete` op.
- `commitStagedWithToken` renames committed blob for `rename` op.
- `getFileContentByPathWithToken` priority: staged > committed > null.
- `getRepoFilesWithToken` result rows have no `content` field.

---

### Phase D — pullRepoFilesToDatabase → Committed Blob

**Goal**: When pulling files from GitHub, write content to committed blob instead of DB.

**Files modified**:
- `app/backend/src/routes/functions.ts`

**Changes to `pullRepoFilesToDatabase`** (declared near line 4497):
1. For each decoded file content: `await getRepoBlobStore().writeCommitted(repoId, filePath, content)`.
2. UPSERT `repo_files` with metadata only (same as Phase C SQL template, no `content` column).
3. Remove `content: decodedContent` from the UPSERT values.

---

### Phase E — AI Agent File Operations

**Goal**: Update `resolveFile`, `search`, `wildcard_search` to work without `file.content`.

**Files modified**:
- `app/backend/src/routes/functions.ts` (inside `handleCodingAgentOrchestrator`)

**Changes to `resolveFile`**:
```ts
// After staging fallback, before returning null:
const committedContent = await getRepoBlobStore().readCommitted(repoId, filePath);
if (committedContent !== null) {
  return { id: row.id, path: filePath, content: committedContent, source: 'committed', isNew: false, operationType: 'modify' };
}
return null;
```
Where `row` is from `getRepoFileByPathWithToken` (metadata only, no content).

**Changes to `case 'search'`**:
```ts
// For each matching file (no f.content available), read committed blob:
const content = await getRepoBlobStore().readCommitted(repoId, f.path) ?? '';
const lines = content.split('\n').map((l, i) => ({ line: i+1, content: l.trim().slice(0,200) }))
  .filter(l => l.content.toLowerCase().includes(keyword));
```

**Changes to `case 'wildcard_search'`**: Same pattern as search.

---

### Phase F — GitHub Push Auto-Push (Deploy)

**Goal**: Deployment service auto-push reads committed blobs instead of `file.content`.

**Files modified**:
- `app/backend/src/routes/functions.ts` (inside `handleDeploymentService`, `case 'deploy'`)

**Changes**:
```ts
const allFiles = await rpc.getRepoFilesWithToken(pushRepoId, shareToken || null);
if (allFiles && allFiles.length > 0) {
  const blobs = await Promise.all(allFiles.map(async (file: any) => {
    const content = await getRepoBlobStore().readCommitted(pushRepoId, file.path) ?? '';
    const blobResp = await fetch(`...`, {
      method: 'POST', headers: ghHeaders,
      body: JSON.stringify({ content: content, encoding: 'utf-8' }),
    });
    // ...
  }));
}
```
The same pattern applies in `case 'create'` auto-push if present.

---

### Phase G — Collaboration Content RPCs

**Goal**: Collaboration current content and snapshots move to blob; `rpc.ts` updated.

**Files modified**:
- `app/backend/src/routes/rpc.ts`

**Changes to `update_artifact_collaboration_with_token`**:
- If `p_current_content` provided: `await getRepoBlobStore().writeCollabCurrent(p_collaboration_id, p_current_content)`.
- Remove `current_content = $n` from the UPDATE SET clause.

**Changes to `insert_collaboration_edit_with_token`**:
- If `p_new_full_content` provided: `await getRepoBlobStore().writeCollabSnapshot(p_collaboration_id, nextVersion, p_new_full_content)`.
- Keep `full_content_snapshot = NULL` in the INSERT (column will be dropped in migration 006).

**Changes to `restore_collaboration_version_with_token`**:
- Replace `SELECT full_content_snapshot ...` with `getRepoBlobStore().readCollabSnapshot(p_collaboration_id, p_version_number)`.
- Replace `UPDATE artifact_collaborations SET current_content = ...` with `getRepoBlobStore().writeCollabCurrent(...)`.

**New endpoint: `GET /api/v1/collaboration/:collaborationId/snapshot/:versionNumber`**:
- New file: `app/backend/src/routes/v1/collaboration.ts`
- Validate `collaborationId` (UUID) and `versionNumber` (integer ≥ 1) as path params.
- Read blob: `getRepoBlobStore().readCollabSnapshot(collaborationId, versionNumber)`.
- Return `{ content, versionNumber, collaborationId }` or 404.
- Register in existing v1 router.

---

### Phase H — Schema Migration

**Goal**: Remove content columns from `001_full_schema.sql` and add drop migration.

**Files modified**:
- `infra/migrations/001_full_schema.sql`
- _(new)_ `infra/migrations/006_remove_content_columns.sql`

**Changes to `001_full_schema.sql`**:
- `repo_files`: Remove `content text NOT NULL` column definition.
- `repo_staging`: Remove `old_content text` and `new_content text` column definitions.
- `artifact_collaborations`: Remove `current_content text` and `base_content text` columns.
- `artifact_collaboration_history`: Remove `full_content_snapshot text` column.
- `STAGING_WRITE_OLD_CONTENT` env var references: none in SQL, remove from API code only.

**New file `006_remove_content_columns.sql`**:
```sql
-- Migration 006: Move inline content to Azure Blob Storage (RepoBlobStore)
ALTER TABLE repo_files DROP COLUMN IF EXISTS content;
ALTER TABLE repo_staging DROP COLUMN IF EXISTS old_content;
ALTER TABLE repo_staging DROP COLUMN IF EXISTS new_content;
ALTER TABLE artifact_collaborations DROP COLUMN IF EXISTS current_content;
ALTER TABLE artifact_collaborations DROP COLUMN IF EXISTS base_content;
ALTER TABLE artifact_collaboration_history DROP COLUMN IF EXISTS full_content_snapshot;
```

---

### Phase I — Frontend: Collaboration Snapshot Pre-fetch

**Goal**: Replace inline `full_content_snapshot` reads with parallel blob fetches for the latest 50 versions.

**Files modified**:
- Collaboration viewer component under `app/frontend/src/` (exact path TBD by exploring `app/frontend/src/components/` for the collaboration panel)

**Changes** (per FR-014, FR-015):
1. On collaboration session load, after fetching history list from `get_collaboration_history_with_token`, identify the latest `min(50, history.length)` versions.
2. Dispatch parallel `GET /api/v1/collaboration/{id}/snapshot/{n}` calls.
3. Store snapshot content in a `Map<number, string>` in component state.
4. Pass snapshot content to the version slider from this map.
5. On cache miss (version older than 50 or not yet fetched), issue on-demand fetch.
6. Do not alter component layout or visual structure.

---

### Phase J — Environment Config Update

**Goal**: Update env var name for the blob container; no emulator changes needed — local dev uses the real Azure Blob Storage resource via `az login` + `DefaultAzureCredential`, the same as the existing staged files implementation.

**Files modified**:
- `app/backend/src/index.ts` (or wherever `initBlobStagingStore` is currently called)

**Changes**:
- Update `initRepoBlobStore` call to pass `containerName: process.env.REPO_FILES_BLOB_CONTAINER ?? 'generated-apps-files'`.
- Update `app/backend/.env.example`: add `REPO_FILES_BLOB_CONTAINER=generated-apps-files`, remove `STAGING_BLOB_CONTAINER`.
- Ensure the `generated-apps-files` container exists in the shared Azure Storage account (one-time manual step via Azure Portal or `az storage container create`).

---

### Phase K — Data Backfill (Pre-Migration Safety)

**Goal**: Before migration 006 is applied to any environment that already has data in the DB content columns, all non-null values must be written to blob storage to prevent permanent data loss.

**Files created**:
- `app/backend/src/scripts/backfillContentToBlob.ts` (one-time script, not deployed)

**Sequence** (MUST run before `006_remove_content_columns.sql`):
1. Query all `repo_files WHERE content IS NOT NULL`; call `getRepoBlobStore().writeCommitted(repo_id, path, content)` for each row.
2. Query all `artifact_collaborations WHERE current_content IS NOT NULL`; call `getRepoBlobStore().writeCollabCurrent(id, current_content)` for each row.
3. Query all `artifact_collaboration_history WHERE full_content_snapshot IS NOT NULL`; call `getRepoBlobStore().writeCollabSnapshot(collaboration_id, version_number, full_content_snapshot)` for each row.
4. Verify: blob count written equals non-null row count in each table.
5. Only if step 4 passes: run `006_remove_content_columns.sql`.

**Rollback**: If any blob write fails, abort before running migration 006. If migration 006 ran before backfill completed, restore from DB backup.

**Notes**:
- `repo_staging.old_content` was behind `STAGING_WRITE_OLD_CONTENT` (likely null in most envs); `repo_staging.new_content` holds staged diff content (staging blobs are the source of truth post-migration). No backfill required for staging table columns.
- For fresh environments (no prior data), the backfill script is a no-op and safe to run.

**Compatibility** (Principle I): This phase is the compatibility strategy for existing persisted data. Without it, dropping the content columns is a destructive, non-reversible operation on live databases.
- Update `app/backend/.env.example`: add `REPO_FILES_BLOB_CONTAINER=generated-apps-files`, remove `STAGING_BLOB_CONTAINER`.
- Ensure the `generated-apps-files` container exists in the shared Azure Storage account (one-time manual step via Azure Portal or `az storage container create`).

---

## Testing Plan

### API Layer (Jest)

| Test file | Tests to add / update |
|--|--|
| `repoBlobStore.test.ts` (rename) | Staged path, committed path, collaboration paths, write/read round-trips, null on missing, batch write, deleteAll scoping |
| `rpcHelpers.test.ts` | `getRepoFilesWithToken` has no `content` field; `getFileContentByPathWithToken` priority chain; `commitStagedWithToken` writes committed blob; staging blob deleted post-commit |
| `staging.test.ts` | `commitStagedWithToken` all op types; rename copies blob; delete removes committed blob |
| `routes/collaboration.test.ts` (new) | Snapshot endpoint 200 with content; 404 on missing version; invalid UUID returns 400 |

### Frontend Layer (Vitest)

| Test file | Tests to add / update |
|--|--|
| Collaboration viewer component test | Pre-fetch fires N requests; cache hit avoids re-fetch; cache miss triggers on-demand fetch; partial failure does not break slider |

### Integration (manual / local dev)

- Stage → commit → read committed content end-to-end.
- Pull repo from GitHub → files in committed blobs; `repo_files.content` absent from DB.
- Collaboration edit → insert snapshot → restore version → current content equals restored snapshot.
- AI agent: `resolveFile` for committed file; `search` finds content in committed blob.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|--|--|--|--|
| `commitStagedWithToken` partial failure (blob written, DB fails) | Low | Medium | Orphaned blob; cleanup deferred per clarifications. DB transaction rollback preserves consistency; blob can be re-written on retry. |
| AI agent search/wildcard_search N-blob reads causes timeout | Low | Medium | N is bounded by repo size; `Promise.all` parallelises reads. If perf issue, add sequential fallback with 100-file cap. |
| Azure credentials not configured locally | Low | Medium | `az login` + correct subscription set resolves auth. Same requirement as the existing staging blob implementation. |
| `readCommitted` returns null for a committed file (blob missing) | Very low | High | `getFileContentByPathWithToken` returns null → caller shows "content unavailable" to user. Monitor with alerting. |
| Frontend pre-fetch partial failure blocks version slider | Low | Medium | Each snapshot request is independent; partial failure marks that version as unavailable while others remain usable. |

---

## Constitution Check (Post-Design)

| Principle | Status | Notes |
|--|--|--|
| I. Security First | ✅ PASS | Blob paths include encoded `repoId`/`collaborationId` scoping. Collaboration snapshot endpoint validates collaborationId and versionNumber. No content returned without repository access check. |
| II. UI/UX Layout Immutability | ✅ PASS | Collaboration viewer change is data-source-only; no structural layout change. |
| III. Versioned API | ✅ PASS | New endpoint under `/api/v1/`. |
| IV. Spec-Driven Development | ✅ PASS | All design decisions traced to spec and research. |
| V. Infrastructure as Code | ✅ PASS | Container in storage Terraform module. Migration in `infra/migrations/`. |
| VI. Test Coverage | ✅ PASS (planned) | All affected test files updated; new tests added. Coverage for blob paths, commit write, fallback chain, collaboration snapshot. |

---

## Acceptance Criteria Summary

From spec (via user stories):

| Criterion | Acceptance |
|--|--|
| AC-01 | `commitStagedWithToken` writes to committed blob; `repo_files.content` absent post-migration |
| AC-02 | `getFileContentByPathWithToken` reads staged blob → committed blob → null |
| AC-03 | `pullRepoFilesToDatabase` writes committed blobs; `repo_files` metadata-only |
| AC-04 | GitHub deploy auto-push reads committed blobs |
| AC-05 | AI agent resolves committed files from blob |
| AC-06 | AI agent `search`/`wildcard_search` reads committed blobs |
| AC-07 | `artifact_collaborations.current_content` column absent; blob holds content |
| AC-08 | Collaboration snapshots in blob; version restore reads from blob |
| AC-09 | Collaboration session load pre-fetches ≤50 snapshots in parallel |
| AC-10 | Migration 006 drops content columns; no data loss in new deployments (backfill run first) |
| AC-11 | `001_full_schema.sql` has no content columns; new envs start correctly |
| AC-12 | `STAGING_WRITE_OLD_CONTENT` flag removed; `old_content` column absent |

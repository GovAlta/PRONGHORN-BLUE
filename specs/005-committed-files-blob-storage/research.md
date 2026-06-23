# Research: Migrate Committed Repository Files to Blob Storage

**Feature**: 005-committed-files-blob-storage  
**Date**: 2026-05-26  
**Branch**: `feature/004-staging-blob-store`

---

## 1. Current State of `BlobStagingStore`

### Decision
`BlobStagingStore` in `app/backend/src/utils/blobStagingStore.ts` is the singleton blob abstraction.  
Rename it to `RepoBlobStore` in-place (Option B from clarifications session).

### Current path scheme
| | Current | New |
|--|--|--|
| Container env var | `STAGING_BLOB_CONTAINER` (default `staging`) | `REPO_FILES_BLOB_CONTAINER` (default `generated-apps-files`) |
| Staging path | `staging/{repoId}/{filePath}` | `{repoId}/staged/{filePath}` |
| Committed path | _(does not exist)_ | `{repoId}/committed/{filePath}` |
| Collaboration current | _(does not exist)_ | `{collaborationId}/current` |
| Collaboration base | _(does not exist)_ | `{collaborationId}/base` |
| Collaboration snapshot | _(does not exist)_ | `{collaborationId}/history/{versionNumber}` |

### Rationale
- Single container eliminates dual-abstraction confusion.
- The path rename from `staging/` prefix to `{repoId}/staged/` is logically necessary because the `committed/` and `staged/` sub-prefixes now live under the same `{repoId}/` scope, making `deleteAllContent(repoId)` scoped correctly.
- Alternatives considered:
  - Separate `CommittedBlobStore.ts` module — rejected (creates two singletons, path concerns split across files).
  - New `RepoBlobStore.ts` + delete `BlobStagingStore.ts` — rejected (unnecessary intermediate state; rename-in-place is simpler).

---

## 2. `commitStagedWithToken` — Current Behaviour

### Current write path (to eliminate)
```
staged blob read  →  repo_files.content (DB UPSERT)  →  delete repo_staging row
```

### New write path
```
staged blob read  →  committed blob write ({repoId}/committed/{filePath})
                  →  repo_files UPSERT (metadata only, no content)
                  →  staging blob delete
                  →  delete repo_staging row
```

### Rationale
Writing blob-first (before DB UPSERT) follows the existing `putStagedFile` ordering: a crash between write and DB leaves an orphaned blob rather than a DB row pointing to missing content — the safer failure mode. Orphan cleanup is out of scope per clarifications.

### File: `app/backend/src/utils/rpcHelpers.ts` — affected functions
- `commitStagedWithToken` — rewrites `repo_files` UPSERT to omit `content`; adds committed blob write + staging blob delete.
- `getFileContentByPathWithToken` — currently falls back to `repo_files.content`; must fall back to committed blob read instead.
- `getRepoFilesWithToken` — currently `SELECT *`; must be `SELECT id, repo_id, project_id, path, is_binary, content_length, last_commit_sha, created_at, updated_at` (no `content` column).

---

## 3. Push to GitHub — Current Behaviour

### Decision
Push reads `file.content` from `getRepoFilesWithToken` result. After this feature, `content` is absent from that result, so the push must read from committed blobs.

### Current code location
`app/backend/src/routes/functions.ts`, line ~1823:
```ts
const allFiles = await rpc.getRepoFilesWithToken(pushRepoId, shareToken || null);
// ...
const blobs = await Promise.all(allFiles.map(async (file: any) => {
  const blobResp = await fetch(`...`, { body: JSON.stringify({ content: file.content || '', ... }) });
```

### New pattern
For each file in `allFiles` (metadata only), read the committed blob from `RepoBlobStore.readCommitted(repoId, file.path)`, then base64-encode and push to GitHub.

### Rationale
- Sequential per-file reads add latency but parallelising N blob reads is straightforward (`Promise.all`).
- Same pattern as the current `blobs` array construction — one fetch per file.
- Auto-push in deployment (`case 'deploy'`) uses the same `getRepoFilesWithToken` path and must be updated consistently.

---

## 4. AI Agent File Operations — Current Behaviour

### `resolveFile` helper (inside `handleCodingAgentOrchestrator`)
Current priority chain:
```
sessionFileRegistry  →  getStagedFileWithToken (blob-backed)  →  repo_files.content (DB)
```

New priority chain (FR-008, FR-012):
```
sessionFileRegistry  →  staged blob ({repoId}/staged/{filePath})  →  committed blob ({repoId}/committed/{filePath})  →  named error
```

### `search` / `wildcard_search`
Currently reads `f.content` from `getRepoFilesWithToken` rows. After change, those rows have no `content`. Must read committed blob per matching file OR pre-load a content map.

### Decision: On-demand blob read per matching file for search/wildcard
- Reason: search is infrequent; fetching all committed blobs upfront is expensive. On-demand per-match read is simple and consistent with `read_file` pattern.
- Alternative considered: materialised content cache in session registry — rejected (adds complexity, session may not have pre-staged all files).

---

## 5. `pullRepoFilesToDatabase` — Current Behaviour

Located in `app/backend/src/routes/functions.ts` line ~4497. Decodes GitHub blob content and writes to:
```sql
INSERT INTO repo_files (repo_id, project_id, path, content, last_commit_sha, ...) VALUES (...)
ON CONFLICT DO UPDATE SET content = ..., ...
```

### New behaviour
- Write file content to committed blob: `RepoBlobStore.writeCommitted(repoId, filePath, content)`
- UPSERT `repo_files` with metadata only (no `content`).
- Consistent with CR-002: `001_full_schema.sql` has no `content` column, so the `INSERT ... content = ...` SQL must be removed.

---

## 6. Collaboration Content — Current Behaviour

### `update_artifact_collaboration_with_token`
Currently:
```sql
UPDATE artifact_collaborations SET current_content = $2, updated_at = NOW() WHERE id = $1
```
New: write to blob `{collaborationId}/current`; no DB `current_content` update.

### `insert_collaboration_edit_with_token`
Currently inserts `full_content_snapshot` into `artifact_collaboration_history`.  
New: write snapshot to blob `{collaborationId}/history/{versionNumber}`; insert DB row with `full_content_snapshot = NULL`.

### `restore_collaboration_version_with_token`
Currently reads `full_content_snapshot` from history table.  
New: read blob `{collaborationId}/history/{versionNumber}`; write to `{collaborationId}/current` blob.

### Pre-fetch on session load
`get_collaboration_history_with_token` currently returns all rows with `full_content_snapshot` inline. After change, client receives metadata rows and must fire parallel blob fetches for the most recent N versions (up to `COLLABORATION_SNAPSHOT_PREFETCH_LIMIT`, default 50). A new API endpoint or an enriched RPC response is needed to return snapshot blob URLs or the blobs themselves. Decision: return snapshot blob content inline in a new `get_collaboration_history_with_snapshots_with_token` variant, OR fetch blobs client-side from a new `/api/v1/collaboration/{id}/snapshot/{version}` route.

**Decision: Client-side parallel fetch via a new GET endpoint** `GET /api/v1/collaboration/:collaborationId/snapshot/:versionNumber`  
Rationale: Keeps the RPC response lightweight; client controls parallelism and error handling per version.

---

## 7. Schema Migrations

### Decision
Both strategies applied (CR-002, Option C from clarifications):
1. Edit `001_full_schema.sql` to never include the content columns.
2. Add `infra/migrations/006_remove_content_columns.sql` with `DROP COLUMN IF EXISTS` for each column.

### Columns removed
| Table | Column |
|--|--|
| `repo_files` | `content` |
| `repo_staging` | `old_content` |
| `artifact_collaborations` | `current_content`, `base_content` |
| `artifact_collaboration_history` | `full_content_snapshot` |

### `repo_files.content` is currently `NOT NULL`
`001_full_schema.sql` declares `content text NOT NULL`. The migration must use `DROP COLUMN IF EXISTS content` (not conditional on null constraint). After column removal `repo_files` still has `content_length` for size metadata.

---

## 8. `STAGING_WRITE_OLD_CONTENT` Flag

Currently in `stagedContentStore.ts` (via `shouldWriteStagingOldContent()`). Must be fully removed:
- Remove `shouldWriteStagingOldContent()` helper.
- Remove `writeOldContent` / `oldContent` from `PutStagedFileOptions`.
- Remove the `old_content` SQL column reference in `putStagedFile`.
- Remove from `infra/migrations/001_full_schema.sql`.
- Add to `006_remove_content_columns.sql`.

---

## 9. Path Encoding

### Decision (from clarifications)
`encodeURIComponent` applied to each path segment independently (split on `/`, encode each, rejoin with `/`).

### Implementation pattern
```ts
function encodeBlobPath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}
```
Applied inside `stagedBlobPath`, `committedBlobPath`, `collabCurrentPath`, `collabBasePath`, `collabSnapshotPath` before calling `getBlockBlobClient`.

---

## 10. Local Dev Authentication

Local development uses the real Azure Blob Storage resource — no emulator. `DefaultAzureCredential` picks up the active `az login` session, the same mechanism used by the existing staged files implementation. The only setup required is:
1. `az login` with access to the shared storage account.
2. Ensure the `generated-apps-files` container exists (one-time `az storage container create`).
3. Set `AZURE_STORAGE_ACCOUNT_NAME` and `REPO_FILES_BLOB_CONTAINER=generated-apps-files` in `app/backend/.env`.

---

## 11. Frontend Changes

The file viewer and diff view in `app/frontend/src/` currently use the `get_file_content_with_token` RPC (returns `content` inline). After this change, the backend RPC must resolve content from committed/staged blobs. The frontend RPC call shape is **unchanged** — the resolution happens server-side. No frontend code changes are required for the file viewer.

**Exception**: Collaboration version slider pre-fetch. The frontend currently reads `history[i].full_content_snapshot` from the already-loaded history array. This field will be absent. The frontend must issue parallel `GET /api/v1/collaboration/:id/snapshot/:n` calls on session load for the most recent 50 versions, hold them in state, and fall back to on-demand fetches for older versions. This is a **frontend change required** (app/frontend/src/).

---

## 12. Test Strategy

### Existing tests to update
- `blobStagingStore.test.ts` → `repoBlobStore.test.ts`: update path assertions from `staging/` to `{repoId}/staged/`; add committed path tests.
- `staging.test.ts`: `commitStagedWithToken` tests currently assert `repo_files.content` write; replace with committed blob write assertions.
- `rpcHelpers.test.ts`: `getRepoFilesWithToken` shape test (no `content` field); `getFileContentByPathWithToken` fallback chain test.

### New tests required
- Committed blob write on `commitStagedWithToken` (add, edit, rename, delete operations).
- Priority chain: in-session → staged → committed → error (unit tests).
- `pullRepoFilesToDatabase`: committed blob written; `repo_files.content` absent.
- Collaboration blob write/read/restore.
- Snapshot pre-fetch: partial failure marks version unavailable; other versions remain.

# API Contracts: Committed Files Blob Storage

**Feature**: 005-committed-files-blob-storage  
**Branch**: `feature/004-staging-blob-store`

These contracts describe API shapes that change as part of this feature. Callsite code **must not** rely on the removed fields.

---

## 1. Blob Storage Path Contract

**File**: `app/backend/src/utils/repoBlobStore.ts`

All blobs reside in one container (`REPO_FILES_BLOB_CONTAINER`, default `generated-apps-files`).

| Purpose | Blob path pattern |
|--|--|
| Staged file content | `{repoId}/staged/{encodeURIComponent(segment1)}/{encodeURIComponent(segment2)}…` |
| Committed file content | `{repoId}/committed/{encodeURIComponent(segment1)}/{encodeURIComponent(segment2)}…` |
| Collaboration current content | `{collaborationId}/current` |
| Collaboration base snapshot | `{collaborationId}/base` |
| Collaboration version snapshot | `{collaborationId}/history/{versionNumber}` |

### Path encoding rule
```ts
const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
```

---

## 2. `getRepoFilesWithToken` — Return Shape Change

**File**: `app/backend/src/utils/rpcHelpers.ts`

### Before (removed field)
```ts
{
  id: string;
  repo_id: string;
  project_id: string;
  path: string;
  content: string;       // REMOVED
  is_binary: boolean;
  content_length: number | null;
  last_commit_sha: string | null;
  created_at: string;
  updated_at: string;
}
```

### After
```ts
{
  id: string;
  repo_id: string;
  project_id: string;
  path: string;
  // content field is absent — callers must read committed blob separately
  is_binary: boolean;
  content_length: number | null;
  last_commit_sha: string | null;
  created_at: string;
  updated_at: string;
}
```

**Callers that must be updated**:
- `handleDeploymentService` → `case 'deploy'` (push to GitHub auto-push)
- `handleCodingAgentOrchestrator` → `case 'search'`, `case 'wildcard_search'` (reads `f.content`)

---

## 3. `getFileContentByPathWithToken` — Fallback Chain Change

**File**: `app/backend/src/utils/rpcHelpers.ts`

### Before
```
1. Staged blob read → return
2. repo_files.content (SELECT content FROM repo_files) → return
```

### After
```
1. Staged blob read → return
2. RepoBlobStore.readCommitted(repoId, filePath) → return
3. return null
```

**Return shape unchanged**:
```ts
{
  content: string;
  is_binary: boolean;
  content_length: number | null;
} | null
```

---

## 4. `commitStagedWithToken` — Write Targets Change

**File**: `app/backend/src/utils/rpcHelpers.ts`

### Before
```sql
INSERT INTO repo_files (repo_id, project_id, path, content, last_commit_sha, ...)
VALUES ($1, $2, $3, $4, $5, ...)
ON CONFLICT (repo_id, path) DO UPDATE SET content = $4, ...
```
Content read from: `getBlobStagingStore().readContent(repoId, filePath)`

### After
Content is read from `getRepoBlobStore().readStaged(repoId, filePath)` and written to:
1. `getRepoBlobStore().writeCommitted(repoId, filePath, content)` — blob write
2. `INSERT INTO repo_files (repo_id, project_id, path, is_binary, content_length, last_commit_sha, ...)` — metadata only (no `content` column)

After successful commit of a file:
- `getRepoBlobStore().deleteStaged(repoId, filePath)` — clean up staging blob

**Return shape unchanged**.

---

## 5. `pullRepoFilesToDatabase` — Write Target Change

**File**: `app/backend/src/routes/functions.ts`

### Before
```sql
INSERT INTO repo_files (repo_id, project_id, path, content, last_commit_sha, ...)
ON CONFLICT DO UPDATE SET content = ...
```

### After
```ts
await getRepoBlobStore().writeCommitted(repoId, filePath, content);
// then:
INSERT INTO repo_files (repo_id, project_id, path, is_binary, content_length, last_commit_sha, ...)
ON CONFLICT DO UPDATE SET is_binary = ..., content_length = ..., last_commit_sha = ..., updated_at = NOW()
```

---

## 6. New REST Endpoint: Collaboration Snapshot

**File**: `app/backend/src/routes/v1/` (new route)

### `GET /api/v1/collaboration/:collaborationId/snapshot/:versionNumber`

Returns the full content snapshot for a specific version.

**Auth**: Collaboration token in `Authorization: Bearer {token}` header (same as collaboration session).

**Response 200**:
```json
{
  "content": "full text content at this version",
  "versionNumber": 5,
  "collaborationId": "uuid"
}
```

**Response 404**:
```json
{
  "error": "Snapshot not found"
}
```

**Callers**: Frontend collaboration version slider loads the last `COLLABORATION_SNAPSHOT_PREFETCH_LIMIT` (default 50) snapshots in parallel on session open.

---

## 7. `update_artifact_collaboration_with_token` RPC — Content Write Change

**File**: `app/backend/src/routes/rpc.ts`

### Before
```sql
UPDATE artifact_collaborations SET current_content = $2, status = $3, updated_at = NOW() WHERE id = $1
```

### After
If `p_current_content` is provided:
```ts
await getRepoBlobStore().writeCollabCurrent(p_collaboration_id, p_current_content);
```
```sql
UPDATE artifact_collaborations SET status = $2, updated_at = NOW() WHERE id = $1
-- (p_current_content no longer stored in DB)
```

---

## 8. `insert_collaboration_edit_with_token` RPC — Snapshot Write Change

**File**: `app/backend/src/routes/rpc.ts`

### Before
```sql
INSERT INTO artifact_collaboration_history (..., full_content_snapshot, ...) VALUES (...)
```

### After
If `p_new_full_content` is provided:
```ts
await getRepoBlobStore().writeCollabSnapshot(p_collaboration_id, nextVersion, p_new_full_content);
```
```sql
INSERT INTO artifact_collaboration_history (..., full_content_snapshot, ...) VALUES (..., NULL, ...)
-- full_content_snapshot column dropped in migration 006
```

---

## 9. `restore_collaboration_version_with_token` RPC — Content Read/Write Change

**File**: `app/backend/src/routes/rpc.ts`

### Before
```sql
SELECT full_content_snapshot FROM artifact_collaboration_history WHERE ... AND version_number = $2
UPDATE artifact_collaborations SET current_content = $2, ... WHERE id = $1
```

### After
```ts
const content = await getRepoBlobStore().readCollabSnapshot(p_collaboration_id, p_version_number);
if (!content) return res.json({ data: null, error: 'Version not found' });
await getRepoBlobStore().writeCollabCurrent(p_collaboration_id, content);
// UPDATE artifact_collaborations SET updated_at = NOW() WHERE id = $1
```

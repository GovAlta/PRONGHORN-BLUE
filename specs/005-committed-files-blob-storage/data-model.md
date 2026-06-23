# Data Model: Committed Files Blob Storage

**Feature**: 005-committed-files-blob-storage  
**Branch**: `feature/004-staging-blob-store`

---

## 1. RepoBlobStore (renamed from BlobStagingStore)

**File**: `app/backend/src/utils/repoBlobStore.ts`  
_(renamed from `blobStagingStore.ts`)_

### Entity

| Field | Type | Description |
|--|--|--|
| `containerName` | `string` | From `REPO_FILES_BLOB_CONTAINER` env var; default `generated-apps-files` |
| `serviceClient` | `BlobServiceClient` | Azure SDK via `DefaultAzureCredential` (Managed Identity in Azure; `az login` locally) |

### Blob path functions

| Method | Blob path | Container |
|--|--|--|
| `stagedBlobPath(repoId, filePath)` | `{repoId}/staged/{encoded(filePath)}` | `generated-apps-files` |
| `committedBlobPath(repoId, filePath)` | `{repoId}/committed/{encoded(filePath)}` | `generated-apps-files` |
| `collabCurrentPath(collaborationId)` | `{collaborationId}/current` | `generated-apps-files` |
| `collabBasePath(collaborationId)` | `{collaborationId}/base` | `generated-apps-files` |
| `collabSnapshotPath(collaborationId, versionNumber)` | `{collaborationId}/history/{versionNumber}` | `generated-apps-files` |

### Encoding rule
Each path segment split on `/` is individually encoded with `encodeURIComponent`.  
`repoId` and `collaborationId` are UUIDs — they do not require encoding but are included for consistency.

### Methods (staged — existing, path updated)

| Method | Signature | Notes |
|--|--|--|
| `writeStaged(repoId, filePath, content)` | `Promise<void>` | Replaces `writeContent` |
| `readStaged(repoId, filePath)` | `Promise<string \| null>` | Replaces `readContent` |
| `deleteStaged(repoId, filePath)` | `Promise<void>` | Replaces `deleteContent` |
| `writeStagedBatch(repoId, files[])` | `Promise<void>` | Replaces `writeBatch` |
| `deleteAllStaged(repoId)` | `Promise<void>` | Replaces `deleteAllContent` |

### Methods (committed — new)

| Method | Signature | Notes |
|--|--|--|
| `writeCommitted(repoId, filePath, content)` | `Promise<void>` | Create or overwrite committed blob |
| `readCommitted(repoId, filePath)` | `Promise<string \| null>` | Returns null if blob not found |
| `deleteCommitted(repoId, filePath)` | `Promise<void>` | Remove on file delete commit |
| `deleteAllCommitted(repoId)` | `Promise<void>` | All `{repoId}/committed/*` blobs |

### Methods (collaboration — new)

| Method | Signature | Notes |
|--|--|--|
| `writeCollabCurrent(collaborationId, content)` | `Promise<void>` | Replaces `current_content` DB write |
| `readCollabCurrent(collaborationId)` | `Promise<string \| null>` | Replaces `current_content` DB read |
| `writeCollabBase(collaborationId, content)` | `Promise<void>` | Replaces `base_content` DB write |
| `readCollabBase(collaborationId)` | `Promise<string \| null>` | Replaces `base_content` DB read |
| `writeCollabSnapshot(collaborationId, versionNumber, content)` | `Promise<void>` | Replaces `full_content_snapshot` DB write |
| `readCollabSnapshot(collaborationId, versionNumber)` | `Promise<string \| null>` | Replaces `full_content_snapshot` DB read |

### Singleton lifecycle (unchanged)

| Function | Purpose |
|--|--|
| `initRepoBlobStore(config)` | One-time initialisation on startup |
| `getRepoBlobStore()` | Access singleton |
| `resetRepoBlobStoreForTests()` | Test teardown |

---

## 2. Modified Tables

### `repo_files` (metadata only after CR-002)

| Column | Type | Notes |
|--|--|--|
| `id` | uuid PK | Unchanged |
| `project_id` | uuid FK | Unchanged |
| `repo_id` | uuid FK | Unchanged |
| `path` | text | Unchanged |
| ~~`content`~~ | ~~text NOT NULL~~ | **Removed** — content lives in `{repoId}/committed/{path}` |
| `is_binary` | boolean | Unchanged |
| `content_length` | bigint | Unchanged |
| `last_commit_sha` | text | Unchanged |
| `created_at` / `updated_at` | timestamptz | Unchanged |

### `repo_staging` (metadata only)

| Column | Type | Notes |
|--|--|--|
| `id` | uuid PK | Unchanged |
| `repo_id` | uuid FK | Unchanged |
| `project_id` | uuid FK | Unchanged |
| `file_path` | text | Unchanged |
| `operation_type` | text | Unchanged |
| ~~`old_content`~~ | ~~text~~ | **Removed** — never written post-blob-refactor |
| ~~`new_content`~~ | ~~text~~ | **Removed** — content lives in `{repoId}/staged/{path}` |
| `old_path` | text | Unchanged |
| `is_binary` | boolean | Unchanged |
| `content_length` | bigint | Unchanged |
| `created_at` | timestamptz | Unchanged |

### `artifact_collaborations`

| Column | Type | Notes |
|--|--|--|
| `id` | uuid PK | Unchanged |
| ~~`current_content`~~ | ~~text~~ | **Removed** — lives at `{collaborationId}/current` |
| ~~`base_content`~~ | ~~text~~ | **Removed** — lives at `{collaborationId}/base` |
| `status` | text | Unchanged |
| `created_at` / `updated_at` | timestamptz | Unchanged |
| _(all other columns)_ | | Unchanged |

### `artifact_collaboration_history`

| Column | Type | Notes |
|--|--|--|
| `id` | uuid PK | Unchanged |
| `collaboration_id` | uuid FK | Unchanged |
| `version_number` | integer | Unchanged |
| ~~`full_content_snapshot`~~ | ~~text~~ | **Removed** — lives at `{collaborationId}/history/{version_number}` |
| `old_content` | text | Preserved — diff patch, not full snapshot |
| `new_content` | text | Preserved — diff patch, not full snapshot |
| `operation_type`, `start_line`, `end_line` | text / int | Unchanged |
| `narrative` | text | Unchanged |
| `actor_type`, `actor_identifier` | text | Unchanged |
| `created_at` | timestamptz | Unchanged |

---

## 3. Migration File

**File**: `infra/migrations/006_remove_content_columns.sql`

```sql
-- Migration 006: Remove inline content columns from tables where content
-- has been migrated to Azure Blob Storage (RepoBlobStore).
-- Safe to run on existing dev/staging environments.

ALTER TABLE repo_files DROP COLUMN IF EXISTS content;

ALTER TABLE repo_staging DROP COLUMN IF EXISTS old_content;
ALTER TABLE repo_staging DROP COLUMN IF EXISTS new_content;

ALTER TABLE artifact_collaborations DROP COLUMN IF EXISTS current_content;
ALTER TABLE artifact_collaborations DROP COLUMN IF EXISTS base_content;

ALTER TABLE artifact_collaboration_history DROP COLUMN IF EXISTS full_content_snapshot;
```

---

## 4. State Transitions

### File commit state transition

```
[staged blob: {repoId}/staged/{path}]
  + [repo_staging row]
        │
        ▼  commitStagedWithToken
[committed blob: {repoId}/committed/{path}]
  + [repo_files row (metadata only)]
        │
        ▼  delete/rename commit
[committed blob: deleted or renamed path]
  + [repo_files row: deleted or renamed]
```

### Collaboration content state

```
create_collaboration →  writeCollabBase + writeCollabCurrent
update_collaboration →  writeCollabCurrent
insert_edit          →  writeCollabSnapshot(version)
restore_version      →  readCollabSnapshot(version) → writeCollabCurrent
```

---

## 5. Content Resolution Priority Chain

### `getFileContentByPathWithToken` (rpcHelpers.ts)

```
1. staged blob read → content (if found in staging)
2. committed blob read → content (if committed file exists)
3. return null (no content found)
```

### AI agent `resolveFile`

```
1. sessionFileRegistry → content (in-flight edits)
2. getStagedFileWithToken → staged blob content
3. RepoBlobStore.readCommitted(repoId, filePath) → committed blob content
4. return null → throw "File not found: {filePath}"
```

### AI agent `search` / `wildcard_search`

```
For each matching file from repo_files metadata list:
  RepoBlobStore.readCommitted(repoId, file.path) → content (on-demand)
```

---

## 6. Key Environment Variables

| Variable | Default | Description |
|--|--|--|
| `REPO_FILES_BLOB_CONTAINER` | `generated-apps-files` | Container for all staged + committed + collaboration blobs |
| `AZURE_STORAGE_ACCOUNT_NAME` | — | Storage account (required) |
| `STAGING_BLOB_CONTAINER` | _(removed)_ | Replaced by `REPO_FILES_BLOB_CONTAINER` |

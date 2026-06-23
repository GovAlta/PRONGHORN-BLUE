# Quickstart: Local Dev Setup for Committed Files Blob Storage

**Feature**: 005-committed-files-blob-storage  
**Branch**: `feature/004-staging-blob-store`

---

## Prerequisites

- Node.js 18+
- `app/backend/.env` file configured (copy from `.env.example`)
- Azure CLI installed and logged in (`az login`) with access to the shared Azure Storage account
- Existing local PostgreSQL running (see skill `02.setup-local-postgresql`)

> **Note**: Local development uses the real Azure Blob Storage resource via `DefaultAzureCredential` (which picks up your `az login` session). No local emulator is required — this is the same approach used by the existing staged files implementation.

---

## 1. Update Environment Variables

Add the storage account variable to `app/backend/.env`:

```bash
# Blob Storage — containers are created dynamically per-repo (container name = repoId)
AZURE_STORAGE_ACCOUNT_NAME=<your-storage-account-name>
```

Use the same `AZURE_STORAGE_ACCOUNT_NAME` value already configured for staged files. Remove `STAGING_BLOB_CONTAINER` and `REPO_FILES_BLOB_CONTAINER` — they are no longer read by the application. Containers are created automatically on first write (one per repoId/projectId).

---

## 2. Ensure Azure Login

Local development authenticates via `DefaultAzureCredential`, which picks up your active `az login` session — the same mechanism used by the existing staged files implementation.

```bash
az login
az account set --subscription <your-subscription-id>
```

---

## 3. Container Provisioning

Blob containers are created automatically at runtime via `createIfNotExists()`. No manual container creation is needed. Each repository and project gets its own container (container name = repoId or projectId). The Azure Storage account must allow the logged-in identity to create containers (Storage Blob Data Contributor role).

---

## 4. Run the Schema Migration

Apply migration 006 to drop content columns:

```bash
# From repo root
psql -U pronghorn -d pronghorn_dev -f infra/migrations/006_remove_content_columns.sql
```

> **Important**: Migration 006 uses `DROP COLUMN IF EXISTS` — safe to run on a fresh DB or an existing one.

---

## 5. Start the API

```bash
cd app/backend
npm install
npm run dev
```

The API starts on port 3000 by default. On startup, `initRepoBlobStore()` will verify connectivity to Azure Blob Storage using `DefaultAzureCredential`.

---

## 6. Verify Connectivity

```bash
# Health check
curl http://localhost:3000/api/health

# Check blob store is accessible (should not error)
curl -X POST http://localhost:3000/api/v1/rpc \
  -H "Content-Type: application/json" \
  -d '{"action": "get_artifact_collaboration_with_token", "params": {"p_collaboration_id": "test"}}'
```

---

## 7. Test Staging and Commit Flow

```bash
# 1. Stage a file change
curl -X POST http://localhost:3000/api/functions/staging-operations \
  -H "Content-Type: application/json" \
  -d '{
    "action": "stage",
    "repoId": "<your-repo-id>",
    "shareToken": "<your-token>",
    "filePath": "src/hello.ts",
    "operationType": "create",
    "newContent": "export const hello = () => \"world\";"
  }'

# 2. Commit the staged file
curl -X POST http://localhost:3000/api/functions/staging-operations \
  -H "Content-Type: application/json" \
  -d '{
    "action": "commit",
    "repoId": "<your-repo-id>",
    "shareToken": "<your-token>",
    "commitMessage": "Add hello.ts",
    "branch": "main"
  }'

# 3. Read the committed file content
curl -X POST http://localhost:3000/api/v1/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "action": "get_file_content_with_token",
    "params": {
      "p_repo_id": "<your-repo-id>",
      "p_file_path": "src/hello.ts"
    }
  }'
```

**Expected**: Stage creates a blob at `{repoId}/staged/src%2Fhello.ts` (or with path segment encoding). Commit moves it to `{repoId}/committed/src/hello.ts` and deletes the staged blob. The final read resolves from the committed blob.

---

## 8. Running Tests

```bash
# API tests (Jest)
cd app/backend
npm test

# Specific test files
npx jest --testPathPattern=repoBlobStore
npx jest --testPathPattern=staging
npx jest --testPathPattern=rpcHelpers
```

---

## 9. Troubleshooting

| Issue | Resolution |
|--|--|
| `DefaultAzureCredential: no credential available` | Run `az login` and ensure the correct subscription is set |
| `Container not found` | Run the `az storage container create` command in step 3 |
| `column "content" does not exist` | Migration 006 already applied, but SQL is still referencing old column. Check for any remaining `repo_files.content` references in code. |
| `column "content" of relation "repo_files" does not exist` | Run migration 006 — column not yet dropped. |
| `Missing staged blob content for {path}` | Staged blob was deleted or never written. Re-stage the file. |

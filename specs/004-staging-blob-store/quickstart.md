# Quickstart: Staging Content Blob Storage

**Branch**: `004-staging-blob-store`

## Goal

Validate staging, commit, and discard workflows with blob-backed staged content while preserving existing user-visible behavior.

## Prerequisites

- Node.js 18+
- Docker + Docker Compose
- Local `.env` with `AZURE_STORAGE_CONNECTION_STRING` configured for Azurite (or Azure Storage)

Example local connection string:

```env
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=<key>;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;
STAGING_BLOB_CONTAINER=staging
```

## Setup

1. Start local dependencies (including Azurite once compose changes are applied):

```bash
docker-compose up -d
```

Confirm Azurite is healthy:

```bash
docker-compose ps azurite
```

2. Build API:

```bash
cd app/backend
npm install
npm run build
```

3. Start API dev server:

```bash
npm run dev
```

## Validation Scenarios

1. Single-file stage:
- Edit and save one file in UI.
- Confirm blob exists at `staging/{repoId}/{filePath}`.
- Confirm `repo_staging.new_content` is `NULL`.

2. Batch stage (AI path):
- Trigger an AI operation touching 10+ files.
- Confirm blobs are created for create/modify files.
- Confirm one metadata transaction and a single staging refresh broadcast.

3. Commit path:
- Commit a mix of create/modify/delete rows.
- Confirm commit reads blob content for non-delete rows and updates `repo_files`.
- Confirm blobs are deleted only for committed file paths in partial commits.

4. Discard path:
- Discard one staged file and verify only that blob is removed.
- Clear all staging and verify blob prefix cleanup under `staging/{repoId}/`.

Manual Azurite verification:

```bash
# List blobs for a repo prefix after save/stage.
docker-compose exec azurite ls -R /data

# Verify discard/commit cleanup by checking the same prefix after each action.
docker-compose exec azurite ls -R /data
```

5. Failure handling:
- Simulate missing blob for non-delete staged row and confirm commit rolls back with actionable error.
- Simulate cleanup failure and confirm DB outcome is preserved with logged orphan warning.

## Verification Commands

```bash
# API layer
cd app/backend
npm test -- --testPathPattern staging
npm run build

# Local storage emulator
cd ../..
docker-compose ps azurite

# Optional full stack validation
npm run build
npm run test
```

## Validation Evidence (2026-05-22)

- Backend build passed with `npm run build` in `app/backend/`.
- Focused Jest validation passed with coverage using:
	`npm test -- --coverage --testPathPatterns "staging|blobStagingStore|commitStaged|unstage|aiBatchStaging"`.
- Blob store coverage for `app/backend/src/utils/blobStagingStore.ts`: 100% statements, 95.65% branches, 100% functions, 100% lines.
- Local Azurite validation ran against Docker Compose service `azurite` with SDK uploads to `staging/{repoId}/{filePath}`.
- Single-file blob write timing: 30 writes, p95 11.23ms (target: <500ms).
- Batch blob write timing: 20 files in 79.14ms (target: <2s).
- Save, commit, discard, missing-blob, and cleanup-failure scenarios are covered by the focused backend Jest suites for staging, commit, unstage, and blob store behavior. Browser UI walkthrough was not run in this validation pass.

## Rollback

- Revert code paths to DB-backed `new_content` staging writes.
- Disable blob store initialization usage in staging/commit/discard handlers.
- Keep existing schema unchanged (`repo_staging.new_content` still present), allowing immediate fallback without migration rollback.

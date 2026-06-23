# Quickstart: Staging Storage Optimization (Phase 1)

**Branch**: `003-staging-blob-storage`

## What This Changes

Phase 1 optimizes the code editing workflow to reduce PostgreSQL contention:

1. **Stops writing `old_content` to `repo_staging`** — file content is stored once (`new_content`), not twice
2. **Replaces SELECT-DELETE-INSERT with single UPSERT** — file saves go from 3 DB operations to 1
3. **Batches AI agent staging** — AI file operations are written in a single transaction instead of individually
4. **Adds observability** — structured logging for stage/commit timing and file counts
5. **Fetches diff baselines on-demand** — committed content loaded from `repo_files` only when viewing diffs

## Prerequisites

- Node 18+
- PostgreSQL running locally (see `docs/LOCAL_DEVELOPMENT.md`)
- Schema migrations applied through `004_*`

## Development Setup

```bash
# From repo root
cd app/backend && npm install && npm run build
cd ../frontend && npm install && npm run build
```

## Testing

```bash
# Backend tests
cd app/backend && npm test

# Frontend tests
cd app/frontend && npm test

# Both (from repo root)
# Use skill 21.test-all
```

## Key Files Changed

| File                                                    | Change                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `app/backend/src/utils/rpcHelpers.ts`                   | `stageFileChangeWithToken` passes `null` for `old_content`; new `batchStageFiles` function |
| `app/backend/src/routes/rpc.ts`                         | New RPCs: `get_file_content_by_path_with_token`, `batch_stage_files_with_token`            |
| `app/backend/src/routes/functions.ts`                   | AI agent batches staging at task end via `sessionFileRegistry`                             |
| `app/frontend/src/hooks/useFileBuffer.ts`               | `saveFileAsync` calls single UPSERT, no SELECT                                             |
| `app/frontend/src/components/repository/CodeEditor.tsx` | `handleSave` calls single UPSERT, no SELECT                                                |
| `app/frontend/src/components/build/StagingPanel.tsx`    | Diff baseline fetched from `repo_files` on-demand                                          |

## Feature Flag

Set `STAGING_WRITE_OLD_CONTENT=true` in API environment to re-enable `old_content` writes (rollback without code revert).

## Verification

1. Edit a file in the Build page → verify single UPSERT (check backend logs, no SELECT before stage)
2. Switch between files → verify content preserved in buffer
3. View staged file diff → verify diff shows correct baseline from `repo_files`
4. Stage a new file → verify diff shows all-additions (empty baseline)
5. Run AI task → verify batch staging (single transaction in logs)
6. Commit staged files → verify files appear in `repo_files` correctly

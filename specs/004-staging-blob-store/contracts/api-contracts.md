# API Contract Notes: Staging Content Blob Storage

**Date**: 2026-05-22 | **Spec**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)

## Contract Summary

| Endpoint / RPC                                                       | Change Type | Breaking? | Notes                                                                                                   |
| -------------------------------------------------------------------- | ----------- | --------- | ------------------------------------------------------------------------------------------------------- |
| `stage_file_change_with_token`                                       | Behavior    | No        | Same request/response shape; backend writes blob and stores metadata-only row (`new_content = NULL`)    |
| `batch_stage_files_with_token`                                       | Behavior    | No        | Same caller contract; backend performs blob batch write before metadata transaction                     |
| `commit_staged_with_token`                                           | Behavior    | No        | Same input/output contract; server reads staged content from blob for non-delete operations             |
| staged-content read path / diff viewer content lookup                | Behavior    | No        | Same caller contract; backend resolves staged content from blob when `repo_staging.new_content` is null |
| `unstage_file_with_token`                                            | Behavior    | No        | Same contract; server also deletes corresponding blob                                                   |
| clear-staging operation                                              | Behavior    | No        | Same contract; server performs prefix blob cleanup                                                      |
| WebSocket `staging_refresh` / `repo_files_refresh` / `repos_refresh` | Unchanged   | N/A       | Broadcast names and payload patterns remain unchanged                                                   |

## Contract Preservation Rules

1. Frontend continues sending staged content as string payload in existing RPC calls.
2. Backend internal storage location changes are opaque to callers.
3. `repo_staging` schema is unchanged for this feature; `new_content` remains present but is null for new writes.
4. Staging panel and diff viewer read behavior remains unchanged for callers; backend read logic resolves staged content from blob storage when `repo_staging.new_content` is null.
5. Missing blob during commit for non-delete rows is surfaced as explicit commit error (no silent fallback).

## Request/Response Compatibility

### `stage_file_change_with_token`

Request compatibility:
- No parameter additions/removals.
- `p_new_content` remains required for create/modify operations.

Response compatibility:
- Existing row-style response preserved.
- No response schema change required by callers.

### `batch_stage_files_with_token`

Request compatibility:
- Existing batch payload shape retained.
- Delete items still represented by operation type and no content payload.

Response compatibility:
- Existing staged count/file list semantics preserved.

### `commit_staged_with_token`

Request compatibility:
- Full and partial commit invocation unchanged.

Response compatibility:
- Success/error envelopes unchanged.
- Error text for missing blob is more explicit but remains standard error string field.

### staged-content read path / diff viewer content lookup

Request compatibility:
- No parameter additions/removals for existing staged-content lookup calls.
- File path, repo/project identifiers, and auth/token requirements remain unchanged.

Response compatibility:
- Existing content response shape is preserved for staging panel and diff viewer callers.
- When `repo_staging.new_content` is null for a blob-backed staged row, the backend returns the staged content read from blob storage instead of exposing the storage location to callers.
- Delete operations still return deletion intent metadata without requiring blob content.

## Operational Contract Notes

- Blob cleanup after successful commit/discard is best-effort for storage hygiene.
- Cleanup failure does not alter successful DB outcomes.
- Orphan blobs are accepted in scope and tracked for future maintenance automation.

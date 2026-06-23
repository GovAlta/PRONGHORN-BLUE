# API Contract Changes: Staging Storage Optimization (Phase 1)

**Date**: 2026-05-19 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

## Contract Change Summary

| Endpoint / RPC                           | Change Type | Breaking? | Details                                                  |
| ---------------------------------------- | ----------- | --------- | -------------------------------------------------------- |
| `stage_file_change_with_token`           | Behavior    | No        | `old_content` always `null`; existing callers unaffected |
| `get_staged_changes_with_token`          | Behavior    | No        | `old_content` field returns `null` for new rows          |
| `get_staged_changes_metadata_with_token` | Unchanged   | N/A       | Already excludes content                                 |
| `get_file_content_by_path_with_token`    | **New**     | N/A       | Fetch committed content by path                          |
| `batch_stage_files_with_token`           | **New**     | N/A       | Batch staging in single transaction                      |
| WebSocket `staging_refresh`              | Unchanged   | N/A       | Same broadcast signal                                    |

---

## `stage_file_change_with_token` (Modified Behavior)

**Route**: POST `/api/v1/rpc` with `{ fn: "stage_file_change_with_token", params: {...} }`

### Request (unchanged)

```json
{
  "fn": "stage_file_change_with_token",
  "params": {
    "p_repo_id": "uuid",
    "p_project_id": "uuid",
    "p_file_path": "string",
    "p_operation_type": "add | modify | delete | rename",
    "p_old_content": "string | null",
    "p_new_content": "string | null",
    "p_old_path": "string | null",
    "p_token": "string | null"
  }
}
```

### Behavior Change

- `p_old_content` is accepted but **ignored** by the frontend — always sent as `null`
- Backend UPSERT writes `null` to `old_content` column
- **Backward compatible**: callers sending `p_old_content` still function; the value is written to DB but has no downstream consumer

### Response (unchanged)

```json
{
  "data": [{ "id": "uuid", "repo_id": "uuid", "file_path": "string", ... }],
  "error": null
}
```

---

## `get_staged_changes_with_token` (Modified Behavior)

**Route**: POST `/api/v1/rpc` with `{ fn: "get_staged_changes_with_token", params: {...} }`

### Behavior Change

- `old_content` field in response rows will be `null` for rows written after Phase 1 deployment
- Rows written before Phase 1 retain their `old_content` values until committed/discarded
- Consumers must handle `old_content: null` gracefully

### Response Example (post Phase 1)

```json
{
  "data": [
    {
      "id": "uuid",
      "repo_id": "uuid",
      "file_path": "src/utils/helper.ts",
      "operation_type": "modify",
      "old_content": null,
      "new_content": "export function helper() { ... }",
      "old_path": null,
      "content_length": 1234,
      "is_binary": false,
      "created_at": "2026-05-19T10:00:00Z"
    }
  ],
  "error": null
}
```

---

## `get_file_content_by_path_with_token` (New)

**Route**: POST `/api/v1/rpc` with `{ fn: "get_file_content_by_path_with_token", params: {...} }`

### Request

```json
{
  "fn": "get_file_content_by_path_with_token",
  "params": {
    "p_repo_id": "uuid",
    "p_file_path": "string",
    "p_token": "string | null"
  }
}
```

### Response — File Exists

```json
{
  "data": {
    "content": "file content string",
    "is_binary": false,
    "content_length": 1234
  },
  "error": null
}
```

### Response — File Does Not Exist (New File)

```json
{
  "data": null,
  "error": null
}
```

### Error Response

```json
{
  "data": null,
  "error": "Database error message"
}
```

---

## `batch_stage_files_with_token` (New)

**Route**: POST `/api/v1/rpc` with `{ fn: "batch_stage_files_with_token", params: {...} }`

### Request

```json
{
  "fn": "batch_stage_files_with_token",
  "params": {
    "p_repo_id": "uuid",
    "p_project_id": "uuid",
    "p_token": "string | null",
    "p_files": [
      {
        "file_path": "src/utils/helper.ts",
        "operation_type": "modify",
        "new_content": "export function helper() { ... }",
        "old_path": null
      },
      {
        "file_path": "src/new-file.ts",
        "operation_type": "add",
        "new_content": "export const x = 1;",
        "old_path": null
      }
    ]
  }
}
```

### Response — Success

```json
{
  "data": {
    "staged_count": 2,
    "files": ["src/utils/helper.ts", "src/new-file.ts"]
  },
  "error": null
}
```

### Response — Transaction Failure (Rollback)

```json
{
  "data": null,
  "error": "Batch staging failed: <error detail>"
}
```

### Constraints

- Maximum batch size: 100 files per call (configurable via environment variable)
- All files staged atomically — partial success is not possible
- Single `staging_refresh` WebSocket broadcast after successful batch

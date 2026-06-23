# Research Findings: Staging Storage Optimization

**Date**: 2026-05-19 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

## 1. UPSERT and NULL `old_content` Handling

**Decision**: Pass `null` for `old_content` in all staging writes.

**Rationale**: The backend `stageFileChangeWithToken` (rpcHelpers.ts L626–645) already accepts `oldContent?: string | null` and converts it to `null` at L641 (`oldContent || null`). The UPSERT SQL passes `$5` for `old_content` in both INSERT and ON CONFLICT UPDATE clauses. Passing `null` is already a valid code path — it's used today for AI-created files. No SQL changes needed.

**Alternatives considered**:
- Remove `old_content` from the SQL entirely — rejected because it changes the UPSERT signature and requires migration coordination
- Conditional update (preserve `old_content` on conflict if non-null) — rejected because it complicates the code path and we want to stop storing `old_content` entirely

## 2. Frontend SELECT-before-UPSERT Elimination

**Decision**: Remove the `get_staged_changes_with_token` call from both save paths; derive operation type from in-memory buffer state.

**Rationale**: Both `useFileBuffer.saveFileAsync` (L151–181) and `CodeEditor.handleSave` (L230–281) read ALL staged rows to find the existing record for the current file. This is done to: (a) preserve `old_content` baseline, and (b) determine `operation_type`. With `old_content` elimination, (a) is unnecessary. For (b), the buffer already knows whether a file is new (`!file.id`) or existing (`file.id` populated from initial load).

**Alternatives considered**:
- Use `get_staged_changes_metadata_with_token` instead of full SELECT — rejected because even metadata-only SELECT is unnecessary when the buffer has the information
- Keep SELECT but only for the specific file (by file_path) — rejected because the RPC doesn't support single-file filter (it returns all staged for repo)

## 3. Diff Baseline Source

**Decision**: Fetch committed content from `repo_files` on-demand when user views a diff.

**Rationale**: StagingPanel loads all staged changes at panel open (L116). It currently passes `viewingDiff.old_content` to the diff viewer (L470). With `old_content` removed, the committed baseline must come from `repo_files.content WHERE repo_id = $1 AND path = $2`. This is a single-row SELECT, executed only when the user clicks to view a specific file's diff — not on panel load. For `add` operations, the baseline is empty string (no `repo_files` query needed).

**Alternatives considered**:
- Pre-load all baselines on panel open — rejected because it defeats the purpose of reducing DB content reads
- Cache baselines in frontend memory — acceptable as a follow-up optimization, but not needed for Phase 1

## 4. AI Agent Batch Staging

**Decision**: Defer individual staging during AI task execution; batch all changes at task completion using `sessionFileRegistry`.

**Rationale**: The AI agent already maintains a `sessionFileRegistry` Map (functions.ts) tracking all file changes during a task. Currently it calls `stageFileChangeWithToken` after each operation (edit_lines, create_file, etc.), creating N individual DB writes per task. Batching at task end reduces this to 1 transaction with N UPSERTs.

**Alternatives considered**:
- Keep individual staging but make it async (fire-and-forget) — rejected because it loses error handling and transaction guarantees
- Use PostgreSQL COPY for bulk insert — rejected because UPSERT (ON CONFLICT) is needed, which COPY doesn't support

## 5. Observability Approach

**Decision**: Start with structured JSON logging; defer Application Insights SDK integration.

**Rationale**: Zero Application Insights instrumentation exists in the backend. Adding the SDK is a separate concern with its own configuration requirements (connection string, sampling, custom dimensions). Structured JSON logs with `stage_duration_ms`, `commit_duration_ms`, `commit_files_count` fields can be ingested by Application Insights via container runtime log pipeline (stdout → Log Analytics). This provides immediate value without dependency addition.

**Alternatives considered**:
- Add `applicationinsights` npm package — deferred to a separate task/feature; too much scope for Phase 1
- Use existing internal `metrics` array pattern from functions.ts — rejected because those metrics are per-response payloads, not observability pipeline

## 6. Metadata-Only RPC Confirmation

**Decision**: Use `get_staged_changes_metadata_with_token` for StagingPanel file list; use `get_staged_changes_with_token` only when content is needed.

**Rationale**: `get_staged_changes_metadata_with_token` (rpc.ts L1396–1405) returns `id, repo_id, file_path, operation_type, old_path, content_length, is_binary, created_at` — everything StagingPanel needs for the file list UI. Content is fetched on-demand only when user views a specific file. This RPC already exists and is used in Build.tsx (L157) but underutilized — the save paths still call the full content variant.

**Alternatives considered**:
- Create a new "get single staged file content" RPC — this will be needed for diff viewing, but the metadata RPC handles the list case

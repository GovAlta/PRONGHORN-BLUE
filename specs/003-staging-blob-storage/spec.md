# Feature Specification: Staging Storage Optimization & Blob Migration

**Feature Branch**: `003-staging-blob-storage`  
**Created**: 2026-05-15  
**Status**: Draft  
**Input**: Migrate temporary code file storage from PostgreSQL to Azure Blob Storage to reduce database contention at scale, while optimizing the existing save/stage/commit/push workflow.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - User Editing Code Files (Priority: P1)

A user opens the code editor, makes changes across several files by jumping between them frequently, and expects their changes to be preserved without data loss or noticeable delay. The system should handle rapid file switching without creating database contention that degrades the experience for other concurrent users.

**Why this priority**: This is the core daily workflow. Users jump between files frequently, and every file switch currently triggers a full-content database write. At 300 users this becomes the primary bottleneck.

**Independent Test**: Can be fully tested by opening 5+ files, making edits in each, rapidly switching between them, and verifying all changes are preserved — while monitoring that no full-content database reads occur on file switch.

**Acceptance Scenarios**:

1. **Given** a user has unsaved edits in File A, **When** they switch to File B, **Then** File A's changes are preserved in the client-side buffer without triggering a database write
2. **Given** a user switches back to a previously edited file, **When** the file loads, **Then** the buffered content (including unsaved changes) is restored from memory without a database round-trip
3. **Given** a user explicitly saves (stages) a file, **When** the save completes, **Then** only a single database UPSERT is executed (no pre-read of all staging rows)
4. **Given** 50+ users are concurrently editing files across different projects, **When** they save changes, **Then** average save latency remains under 500ms

---

### User Story 2 - AI/LLM Agent Making Bulk Code Edits (Priority: P1)

An AI agent executes a task that creates, modifies, or deletes multiple files (10-30+) in a single operation. Currently each file operation triggers an individual database write. The system should support batch staging to reduce write amplification during AI operations.

**Why this priority**: AI-driven code edits are a core product differentiator and generate the highest burst write load — 30 files × full content per AI task. Combined with 300 users, this creates the largest contention spikes.

**Independent Test**: Can be tested by triggering an AI task that edits 20 files and verifying it completes with significantly fewer database write operations than individual-file staging.

**Acceptance Scenarios**:

1. **Given** an AI agent completes a multi-file edit task, **When** the changes are staged, **Then** the staging can be performed as a batch operation rather than N individual writes
2. **Given** an AI agent is mid-task editing files, **When** it reads files it has already modified, **Then** it reads from its in-memory session registry without hitting the database
3. **Given** an AI batch-stage operation fails partway through, **When** the error occurs, **Then** all changes in the batch are rolled back and the user is notified

---

### User Story 3 - User Reviewing Staged Changes with Diffs (Priority: P2)

A user opens the Staging Panel to review what they (or an AI agent) have changed before committing. They see a list of staged files and can click any file to view a red/green diff showing what changed relative to the last committed version.

**Why this priority**: Diff viewing is essential for user confidence before committing, but it's a read-heavy display operation that happens less frequently than editing. The system must produce accurate diffs without requiring a duplicate copy of the original content in the staging table.

**Independent Test**: Can be tested by staging 3 files (one new, one modified, one renamed), opening each in the diff viewer, and verifying the diff accurately shows changes against the committed baseline.

**Acceptance Scenarios**:

1. **Given** a user has staged a modified file, **When** they view the diff, **Then** the system computes the diff by comparing staged `new_content` against the committed version in `repo_files`
2. **Given** a user has staged a newly created file (no committed version exists), **When** they view the diff, **Then** the diff shows all lines as additions against an empty baseline
3. **Given** a user has staged a deleted file, **When** they view the diff, **Then** the diff shows all committed lines as removals

---

### User Story 4 - User Committing and Pushing Changes (Priority: P2)

A user commits their staged changes and then pushes to GitHub. The commit atomically moves staged content into the committed file store and creates a commit record. The push sends committed content to the GitHub API.

**Why this priority**: Commit and push are less frequent than editing but must be reliable and atomic. The current DB-transaction-based commit is sound; this story ensures it remains so after staging optimizations.

**Independent Test**: Can be tested by staging 5 files, committing with a message, verifying all files appear in committed state, then pushing to GitHub and verifying the remote matches.

**Acceptance Scenarios**:

1. **Given** a user has 5 staged files, **When** they commit, **Then** all 5 files are atomically moved to `repo_files` and staging is cleared in a single transaction
2. **Given** a commit succeeds, **When** the user pushes to GitHub, **Then** all committed file content is sent to the GitHub API and `pushed_at` is recorded
3. **Given** a commit transaction fails mid-way, **When** the error occurs, **Then** no partial changes are applied — staging remains intact

---

### User Story 5 - Migrate Staging Content to Blob Storage (Priority: P3)

After optimizing the existing database-based staging workflow (Phase 1), the system migrates staged file content storage from PostgreSQL `text` columns to Azure Blob Storage. The database retains metadata (file paths, operation types, blob URIs) while actual file content lives in blob storage.

**Why this priority**: This is the long-term scalability play. Phase 1 optimizations (eliminating `old_content`, fixing the read-before-write pattern, batch staging) address immediate contention. Blob migration provides the ceiling-raise for sustained growth beyond the optimized DB capacity.

**Independent Test**: Can be tested by staging files, verifying content is written to blob storage (not DB), viewing diffs (content fetched from blob), committing (content read from blob into `repo_files`), and pushing to GitHub — all without regression.

**Acceptance Scenarios**:

1. **Given** a user saves a file, **When** the stage operation completes, **Then** file content is stored in Azure Blob Storage and only metadata (path, operation, blob URI) is written to the database
2. **Given** a user views a staged file's diff, **When** the diff loads, **Then** content is fetched from blob storage and diffed against the committed version
3. **Given** a user commits staged changes, **When** the commit runs, **Then** content is read from blob storage and written to `repo_files` within a reliable two-phase process
4. **Given** blob storage is temporarily unavailable during a commit, **When** the read fails, **Then** the transaction is rolled back, staging is preserved, and the user receives a clear error message
5. **Given** a commit completes successfully, **When** blob cleanup runs, **Then** orphaned staging blobs are removed (either immediately or via background sweep)

---

### Edge Cases

- **Concurrent edits to the same file**: Two users (or a user + AI agent) stage changes to the same file in the same repo. The system uses last-write-wins semantics via the `ON CONFLICT` UPSERT — no notification is sent to the overwritten user. This is acceptable because staging is a transient working area and the commit captures the final state.
- **Large file content**: Files exceeding typical sizes (>1MB) must not cause timeouts or memory issues during stage, diff, commit, or blob upload operations.
- **Browser tab crash during editing**: Unsaved in-memory buffer content is lost. The system communicates that only explicitly saved (staged) content is persisted. **Known gap**: Non-technical users may not understand the save/stage distinction. Periodic auto-stage (e.g., every 60 seconds) is planned for a future iteration after the core storage optimization is validated. This is tracked as a deliberate deferral, not an oversight.
- **Stale `repo_files` baseline during long editing sessions**: If another user commits changes to the same file while a user has it staged, the diff baseline becomes stale. The system should detect this scenario and warn the user.
- **Blob storage orphan accumulation**: If commits succeed but blob cleanup fails repeatedly, orphaned blobs accumulate. A background cleanup process must exist to prevent unbounded storage growth. Staging blobs have no TTL/automatic expiration — they persist until committed or explicitly discarded. The orphan cleanup job (FR-012) is the sole cleanup mechanism; no Azure lifecycle policy is applied.
- **Migration transition period**: During the Phase 1 → Phase 2 transition, existing staging rows with content in the DB must continue to function until committed or discarded.

## Requirements *(mandatory)*

### Functional Requirements

#### Phase 1: Optimize Database Usage

- **FR-001**: The frontend file buffer MUST use in-memory `originalContent` as the diff baseline instead of querying the database for `old_content` on every save operation
- **FR-002**: The save (stage) operation MUST execute as a single UPSERT call to `stage_file_change_with_token` without a preceding SELECT of all staging rows
- **FR-003**: The `old_content` column MUST be removed from `repo_staging` table writes — diff baselines are computed on-demand by comparing `new_content` against the committed version in `repo_files`
- **FR-004**: The diff viewer MUST compute diffs by fetching the committed file content from `repo_files` and comparing against `new_content` from `repo_staging`
- **FR-005**: For newly created files (no committed version), the diff viewer MUST diff against an empty string baseline
- **FR-006**: AI/LLM agent file operations SHOULD support a batch-stage mode that writes multiple files in a single database transaction rather than individual UPSERT calls per file
- **FR-007**: The dirty detection mechanism MUST continue to function using the in-memory buffer's `lastSavedContent` comparison (no database dependency)

#### Phase 2: Blob Storage Migration

- **FR-008**: Staged file content (`new_content`) MUST be written to Azure Blob Storage instead of the `repo_staging.new_content` database column
- **FR-009**: The `repo_staging` table MUST store a blob storage reference (URI/path) in place of inline content
- **FR-010**: The commit operation MUST read file content from blob storage when applying staged changes to `repo_files`
- **FR-011**: The commit operation MUST handle blob read failures gracefully — rolling back the database transaction and preserving the staging state
- **FR-012**: A cleanup mechanism MUST exist to remove orphaned blobs after successful commits
- **FR-013**: The existing local filesystem storage fallback (for local development) MUST be extended to support the staging blob pattern

### Observability Requirements

- **OR-001**: The system MUST emit stage operation latency (p95) as a metric via existing Application Insights instrumentation
- **OR-002**: The system MUST log the current staging row count for the affected repo on each staging operation (single or batch) to detect accumulation — emitted as part of the per-operation structured log alongside `stage_duration_ms`
- **OR-003**: The system MUST track commit operation duration and failed commit count as metrics
- **OR-004**: In Phase 2, the system MUST track blob storage container size for the staging container to monitor growth
- **OR-005**: The system MUST log blob orphan cleanup results (count deleted, count failed) at INFO level

### Compatibility & Operational Requirements

- **CR-001**: The StagingPanel UI MUST continue to display staged file lists, diffs, commit, and push workflows with no visible change to users
- **CR-002**: The CodeEditor diff mode (Monaco DiffEditor) MUST continue to show accurate side-by-side diffs
- **CR-003**: The WebSocket broadcast pattern (`staging_refresh`, `repo_files_refresh`) MUST continue to notify connected clients of staging and commit events
- **CR-004**: The `commit_staged_with_token` RPC MUST remain atomic — all staged files are committed or none are
- **CR-005**: The GitHub push flow MUST continue to function unchanged — it reads from `repo_files` which is unaffected by staging changes
- **CR-006**: Phase 1 changes MUST be backward-compatible with existing staged data — any rows with `old_content` populated must still function until committed or discarded
- **CR-007**: A database migration MUST be provided to make `old_content` nullable (if not already) and eventually remove it after Phase 1 is validated

### Key Entities

- **Staged File Change**: Represents a pending modification to a file — includes file path, operation type (create/modify/delete/rename), and content reference (DB column in Phase 1, blob URI in Phase 2)
- **Committed File**: The current committed version of a file in the repository — lives in `repo_files` and serves as the diff baseline
- **Blob Content Reference**: A URI or path pointing to file content in Azure Blob Storage, replacing inline content in the staging table (Phase 2). Uses hierarchical path convention: `staging/{project_id}/{repo_id}/{file_path}` — enables prefix-based cleanup per repo, natural multi-tenant isolation, and human-readable blob names for debugging
- **File Buffer**: Client-side in-memory representation of open files including current content, original baseline content, and dirty state

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: File save (stage) operations complete with a single database write, reducing per-save database operations from 3 to 1
- **SC-002**: The system supports 300 concurrent users across 3,000 projects with save latency under 500ms at the 95th percentile
- **SC-003**: AI/LLM batch operations staging 20+ files complete in under 2 seconds (down from 20+ individual writes)
- **SC-004**: Diff viewing loads within 1 second, including the on-demand baseline fetch from committed files
- **SC-005**: Database storage consumed by `repo_staging` is reduced by 50%+ after `old_content` elimination
- **SC-006**: Commit operations complete within 3 seconds for up to 50 staged files
- **SC-007**: Zero data loss during file editing, staging, committing, and pushing workflows under concurrent load
- **SC-008**: Core operational metrics (stage latency p95, commit duration, failed commit count, staging row count) are visible in Application Insights dashboards within the first deployment of each phase

## Assumptions

- The existing `useFileBuffer` hook's in-memory `originalContent` is a reliable diff baseline for the duration of an editing session — if the committed version changes while a user is editing, the stale baseline is an acceptable trade-off (users can reload)
- The PostgreSQL instance can be right-sized (SKU selection) to handle Phase 1 optimized load; Phase 2 blob migration provides headroom beyond that
- Azure Blob Storage is available in the same region as the application with acceptable latency (<50ms for reads/writes)
- The `repo_files` table will continue to store committed file content in the database (blob migration of committed content is out of scope)
- Binary file handling is out of scope for this feature — the `is_binary` flag and binary storage patterns remain unchanged
- The 300-user / 10-project-per-user upper bound is a planning target, not a hard limit — the system should degrade gracefully beyond these numbers rather than fail

## Open Questions & Items Requiring Clarification

- **OQ-001 — AI Batch Staging**: The batch-stage approach for AI operations (FR-006) needs technical refinement. Should this be a new RPC endpoint that accepts an array of file operations, or should the existing `sessionFileRegistry` pattern be formalized with a flush-at-end-of-task semantic? Needs follow-up with the team.
- **OQ-002 — Blob Storage SKU & Pricing**: The Azure Storage Account SKU selection, replication strategy (LRS vs GRS), access tier (Hot vs Cool for staging content), and cost implications for the target scale need discussion. Staging content is short-lived (created, then deleted on commit) which may favor Hot tier with lifecycle policies.
- **OQ-003 — PostgreSQL SKU**: The current and target PostgreSQL SKU needs evaluation against the Phase 1 optimized write patterns. This determines whether Phase 2 blob migration is strictly necessary or a future optimization.
- **OQ-004 — Commit Two-Phase Reliability (Phase 2)**: The blob-to-DB commit flow introduces a new failure mode (blob storage unavailability blocks commits). The rollback strategy is defined, but the operational impact (user blocked until storage recovers) needs risk assessment and potential mitigation (e.g., caching recent blob content, fallback to DB-only staging for critical commits).

## Clarifications

### Session 2026-05-19

- Q: When two users stage changes to the same file, should the overwritten user be notified? → A: No — silent overwrite, last write wins (current behavior preserved)
- Q: What happens to unsaved buffer content on browser crash — should auto-stage be in scope? → A: Deferred to future iteration; document as known gap with planned mitigation (periodic auto-stage ~60s)
- Q: What blob path naming convention for Phase 2 staging content? → A: Hierarchical: `staging/{project_id}/{repo_id}/{file_path}`
- Q: Should staging blobs have a TTL / automatic expiration policy? → A: No TTL — blobs persist until committed or discarded; orphan cleanup job is sole cleanup mechanism
- Q: What observability signals should be emitted for staging health? → A: Core metrics only — stage latency p95, staging row count per repo, commit duration, failed commit count, blob storage size (Phase 2); via existing Application Insights

## Phasing & Risk

### Phase 1: Optimize Database Usage (Lower Risk)
**Goal**: Eliminate unnecessary database operations and redundant content storage.

| Change                                     | Risk                                                                       | Mitigation                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Remove `old_content` from staging writes   | Low — `old_content` is only used for diffs which can be computed on-demand | Feature flag to fall back to stored `old_content` if on-demand diff has issues |
| Eliminate SELECT-before-UPSERT in frontend | Low — the in-memory buffer already holds the baseline                      | Validate that `useFileBuffer.originalContent` is always populated correctly    |
| Batch staging for AI operations            | Medium — changes the AI agent's write pattern                              | Keep individual staging as fallback; batch is an optimization path             |

### Phase 2: Blob Storage Migration (Higher Risk)
**Goal**: Move staged file content from PostgreSQL to Azure Blob Storage.

| Change                                  | Risk                                            | Mitigation                                            |
| --------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| Content in blob instead of DB           | Medium — adds storage dependency to commit path | Robust error handling; orphan cleanup; monitoring     |
| Two-phase commit (blob read + DB write) | Medium — not atomic across storage systems      | DB transaction rollback on blob failure; retry logic  |
| Infrastructure changes (Terraform)      | Low — storage module already exists             | Extend existing module; test in dev environment first |

### Risks at Scale (300 users × 10 projects)

| Risk                                         | Likelihood | Impact | Mitigation                                                          |
| -------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------- |
| DB contention persists after Phase 1         | Low        | High   | Phase 2 blob migration provides escape valve                        |
| Blob orphan accumulation                     | Medium     | Low    | Background cleanup job with monitoring/alerting                     |
| Stale diff baselines confuse users           | Medium     | Medium | UI indicator when committed baseline has changed; option to refresh |
| Project count exceeds 10-per-user assumption | High       | Medium | Document as soft limit; monitor actual usage; plan capacity reviews |

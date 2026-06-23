# Research Findings: Staging Content Blob Storage

**Date**: 2026-05-22 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

## 1. Blob Path Convention and Idempotency

Decision: Use deterministic object keys `staging/{repoId}/{filePath}` for all staged text content.

Rationale: The same file can be re-staged many times; deterministic keys make overwrite behavior explicit, allow simple selective deletion by file path, and align with partial commit cleanup.

Alternatives considered:
- Content-hash keys per save: rejected because commit/discard lookup becomes indirect and requires extra index metadata.
- Random UUID keys per save: rejected because it complicates overwrite and cleanup semantics.

## 2. Write Order and Failure Semantics

Decision: Keep write order as blob-write first, then DB UPSERT for staging metadata.

Rationale: This preserves a hard guarantee that metadata never points to content that was not written. If DB write fails after blob succeeds, orphan blobs are acceptable per spec and can be cleaned by future maintenance jobs.

Alternatives considered:
- DB UPSERT first then blob write: rejected because it can create metadata rows referencing missing content.
- Two-phase distributed transaction: rejected as unnecessary complexity for current scope.

## 3. Batch Staging Strategy for AI Agent Workloads

Decision: Use `writeBatch()` to upload create/modify payloads in parallel, then execute one DB transaction with metadata-only UPSERT rows.

Rationale: AI tasks commonly stage 10-30 files. Parallel blob upload plus one DB transaction minimizes end-to-end latency and avoids per-file transaction overhead.

Alternatives considered:
- Sequential per-file blob upload: rejected due avoidable latency growth as file count increases.
- Per-file DB transactions: rejected because they increase lock churn and failure surface area.

## 4. Commit-Time Content Retrieval and Missing Blob Handling

Decision: For non-delete operations, read staged content from blob by deterministic path during commit; throw and roll back if content is missing.

Rationale: Missing blob content is a data-loss risk. Hard-failing commit protects repository correctness and preserves staged metadata for recovery via re-stage.

Alternatives considered:
- Treat missing blob as empty content: rejected because it silently corrupts committed data.
- Skip missing files and commit others: rejected because it violates commit atomicity expectations.

## 5. Discard and Cleanup Semantics

Decision: Single-file discard calls selective `deleteContent()`, and full clear-staging calls prefix-based `deleteAllContent()`.

Rationale: This mirrors user intent and keeps cleanup behavior proportional to operation scope while preserving metadata-first UX.

Alternatives considered:
- Always run prefix delete for any discard: rejected due unnecessary broad deletion on single-file operations.
- Never clean blobs on discard: rejected because orphan growth becomes unbounded.

## 6. Blob Client Initialization Pattern

Decision: Initialize `BlobStagingStore` once at API startup via `initBlobStagingStore()` and fail fast if the connection string is invalid or unavailable.

Rationale: Startup validation prevents latent runtime failures during save/commit and keeps errors visible during deployment and local dev boot.

Alternatives considered:
- Lazy initialize on first staging call: rejected because first-user latency/failure becomes unpredictable.
- Recreate client per request: rejected due unnecessary overhead and complexity.

## 7. Local Development Topology

Decision: Add Azurite as a `docker-compose` service and use `AZURE_STORAGE_CONNECTION_STRING` in API env for local parity with production code paths.

Rationale: Developers should exercise the same blob lifecycle logic locally without requiring cloud resources.

Alternatives considered:
- Cloud-only dev storage: rejected due onboarding friction and dependency on Azure availability.
- In-memory fake storage: rejected because it does not validate real blob API behavior.

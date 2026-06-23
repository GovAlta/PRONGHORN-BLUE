# Implementation Plan: Staging Content Blob Storage

**Branch**: `004-staging-blob-store` | **Date**: 2026-05-22 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/004-staging-blob-store/spec.md`

## Summary

Move staged file content from PostgreSQL `repo_staging.new_content` to Azure Blob Storage (and Azurite locally) using deterministic paths `staging/{repoId}/{filePath}` while preserving existing frontend RPC contracts and user behavior. The plan keeps metadata in `repo_staging` (`new_content = NULL`), reads blob content at commit time, and performs selective or prefix cleanup on commit/discard.

## Technical Context

**Language/Version**: TypeScript (Node.js 18+, React 18)  
**Primary Dependencies**: Express, `pg`, `ws`, `winston`, `@azure/storage-blob` (new), Azurite (local)  
**Storage**: PostgreSQL (`repo_staging`, `repo_files`) + Azure Blob Storage (`staging` container)  
**Testing**: Jest (API), Vitest (frontend contract stability), local docker-compose manual validation with Azurite  
**Target Platform**: Linux local dev, Azure Container Apps API runtime, Azure Storage Account in production  
**Project Type**: Web application monorepo (`app/backend`, `app/frontend`, `infra`)  
**Performance Goals**: save p95 < 500ms, batch stage 20 files < 2s, preserve current commit UX latency envelope  
**Constraints**: preserve RPC names/shapes, keep `repo_staging` schema unchanged, support partial commits, accept orphan blobs on cleanup failure, no UI layout changes  
**Scale/Scope**: user and AI-agent staging flows (single file and 10-30 file bursts), commit and discard lifecycle, local parity via Azurite

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Contract Preservation**: Identify every affected user-facing contract
  (UI flow, API, auth, realtime, schema, deployment, or automation) and state
  whether the change is backward compatible. Any intentional break MUST include
  migration or fallback steps.
- **Traceability**: Map each user story and requirement to the concrete
  subsystems, files, and validation evidence that will implement it.
- **Verification**: Define the required lint, build, automated tests, and/or
  manual validation needed to prove the change is safe for the touched layers.
- **Security and Compliance**: Record secret handling, auth and RBAC impact,
  external connectivity changes, and compliance-sensitive data handling.
- **Operability**: Describe deployment, monitoring, rollback, migration, and
  post-deploy validation expectations for the change.
- **UI/UX Layout Immutability**: Confirm no page layouts, navigation flows,
  component positioning, or visual hierarchy changes are introduced. If layout
  changes are proposed, attach written client approval to the spec artifacts.

Gate assessment (pre-research):
- Contract Preservation: PASS. `stage_file_change_with_token`, `batch_stage_files_with_token`, and `commit_staged_with_token` request/response contracts remain stable; behavior changes are server-side storage internals only.
- Traceability: PASS. FR-001..FR-010 map directly to backend staging helpers, RPC routes, commit/discard handlers, blob lifecycle wrapper, startup initialization, and local compose configuration.
- Verification: PASS with defined checks: backend build/tests, targeted staging/commit tests, and local end-to-end validation against Azurite.
- Security and Compliance: PASS. Blob connection string stays in environment configuration; no new auth surfaces or secrets in source; least-privilege storage credentials required in deployment config.
- Operability: PASS. Includes startup fail-fast when storage unavailable, structured logging for blob operations, and documented orphan-blob acceptance/cleanup follow-up.
- UI/UX Layout Immutability: PASS. No structural frontend layout/navigation changes are planned.

## Affected Layers

*Identify which repository layers this feature touches and the validation
required for each.*

| Layer                         | Touched?           | Validation Required                                                                    |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| Web App (`app/frontend/src/`) | No (contract only) | `npm run lint` + `npm run build` only if frontend adapter/types change                 |
| API (`app/backend/`)          | Yes                | `npm run build` + targeted Jest staging/commit tests                                   |
| Infrastructure (`infra/`)     | Yes                | compose/dev env update validation; Terraform only if production storage wiring changes |
| CI/CD (`.github/workflows/`)  | No                 | N/A                                                                                    |

## Project Structure

### Documentation (this feature)

```text
specs/004-staging-blob-store/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── api-contracts.md
└── tasks.md
```

### Source Code (repository root)

```text
app/backend/src/
├── index.ts                         # startup initialization for blob store singleton
├── routes/rpc.ts                    # stage/commit/unstage/clear RPC handlers
├── utils/rpcHelpers.ts              # staging/commit DB logic + blob integration hooks
├── utils/                           # blob store abstraction module (new)
└── __tests__/                       # staging/commit/blob integration tests

app/backend/package.json             # add Azure Blob SDK dependency
docker-compose.yml                   # add Azurite service for local development
infra/                               # optional env/config follow-up for production storage wiring
```

**Structure Decision**: Use the existing web-app monorepo structure and concentrate implementation in API and local infra/dev configuration paths, with no UI layout changes and no new top-level modules.

## Phase 0: Research Output

Research completed in [research.md](research.md) with all technical unknowns resolved:
- Blob naming convention, overwrite behavior, and delete semantics
- Transaction boundaries and failure behavior (including accepted orphan policy)
- Commit-time missing-blob error handling strategy
- Azurite local topology and startup requirements
- SDK/library and initialization patterns for singleton storage client

## Phase 1: Design & Contracts Output

- Data model and lifecycle documented in [data-model.md](data-model.md)
- API/RPC contract compatibility documented in [contracts/api-contracts.md](contracts/api-contracts.md)
- Local validation and rollout quickstart documented in [quickstart.md](quickstart.md)

## Phase 2: Task Planning Scope

Phase 2 task generation will decompose implementation into:
1. Blob storage abstraction and startup wiring
2. Single-file staging + batch staging blob writes
3. Commit path blob reads + selective cleanup
4. Discard path cleanup (`deleteContent` and `deleteAllContent`)
5. Azurite compose integration and local env docs
6. Backend test updates for success/failure/rollback/orphan scenarios

## Constitution Re-Check (Post-Design)

- Contract Preservation: PASS. Contracts are explicitly marked non-breaking in [contracts/api-contracts.md](contracts/api-contracts.md).
- Traceability: PASS. FR and SC mapping captured across [plan.md](plan.md), [research.md](research.md), and [data-model.md](data-model.md).
- Verification: PASS. Command-level and scenario-level validation captured in [quickstart.md](quickstart.md).
- Security and Compliance: PASS. Environment-only connection string usage and no secret-in-repo policy retained.
- Operability: PASS. Startup checks, cleanup semantics, and rollback posture documented.
- UI/UX Layout Immutability: PASS. No frontend structural changes planned.

## Complexity Tracking

No constitution violations identified.

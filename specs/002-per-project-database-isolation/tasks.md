# Tasks: Per-Project Database Isolation

**Input**: Design documents from `/specs/002-per-project-database-isolation/`
**Prerequisites**: impl-plan.md (required), spec.md (required for user stories)

**Tests**: Include validation tasks for all behavior changes — provisioning, deletion, error handling, and frontend updates all carry regression risk.

**Organization**: Tasks are grouped by user scenario (from spec.md) to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user scenario this task belongs to (US1 = Provisioning, US2 = Deletion, US3 = Failure Handling)
- Exact file paths included in descriptions

## Path Conventions

- **API**: `app/backend/src/`
- **Frontend**: `src/`
- **Infrastructure**: `infra/`, `docker-compose.yml`

---

## Phase 1: Setup (Infrastructure Prerequisites)

**Purpose**: Grant CREATEDB privilege so the API user can create per-project databases

- [X] T001 Add CREATEDB privilege for API user in `docker-compose.yml` init SQL
- [X] T002 [P] Verify CREATEDB privilege grant in `infra/modules/postgresql/main.tf` (add if needed)
- [X] T003 [P] Verify `azure.extensions` allows uuid-ossp and pgcrypto in `infra/modules/postgresql/main.tf`

---

## Phase 2: Foundational (Pool Factory Abstraction)

**Purpose**: Replace duplicated pool construction with shared pool factory — ALL user stories depend on this

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 Implement shared pool factory with keyed cache in `app/backend/src/utils/database.ts`
- [X] T005 Add `queryWithPoolTarget(target, text, params)` helper in `app/backend/src/utils/database.ts`
- [X] T006 Add `getPoolClient(target)` helper in `app/backend/src/utils/database.ts`
- [X] T007 Retain backward-compatible `getPool()` and `getUserDataPool()` wrappers in `app/backend/src/utils/database.ts`
- [X] T008 [P] Write Jest tests for pool factory in `app/backend/src/__tests__/database-pool-factory.test.ts`

**Checkpoint**: Pool factory operational — existing functionality unchanged, new factory can target arbitrary database names

---

## Phase 3: User Story 1 — Project Provisioning (Priority: P1) 🎯 MVP

**Goal**: When a user creates a project, the API creates an isolated database with dedicated role and valid connection string on the existing PostgreSQL server.

**Independent Test**: `curl -X POST` create action → verify database exists in `pg_database`, role authenticates, extensions installed, connection string in metadata table valid.

### Tests for User Story 1

- [X] T009 [P] [US1] Write Jest integration test for `handleDatabaseProvisioning` action `create` in `app/backend/src/__tests__/database-provisioning.test.ts`

### Implementation for User Story 1

- [X] T010 [US1] Implement action `create` in `handleDatabaseProvisioning` in `app/backend/src/routes/functions.ts` — generate DB name, create database, install extensions, create role, grant permissions
- [X] T011 [US1] Store connection string, host, database_name, port, status='available' in `project_database_connections` table via `app/backend/src/routes/functions.ts`
- [X] T012 [US1] Implement action `connectionInfo` returning direct DB connection (no search_path) in `app/backend/src/routes/functions.ts`
- [X] T013 [US1] Implement action `status` querying `pg_database` (not `information_schema.schemata`) in `app/backend/src/routes/functions.ts`
- [X] T014 [US1] Handle `42P04` (duplicate_database) error as non-fatal in create action in `app/backend/src/routes/functions.ts`

**Checkpoint**: Project provisioning creates isolated databases; status and connectionInfo return per-database data

---

## Phase 4: User Story 2 — Project Deletion (Priority: P2)

**Goal**: When a user deletes a project, the API drops the project database and role, and updates metadata.

**Independent Test**: Create a test project DB → call delete action → verify DB gone from `pg_database`, role cannot authenticate, metadata record updated.

### Tests for User Story 2

- [X] T015 [P] [US2] Write Jest integration test for `handleDatabaseProvisioning` action `delete` in `app/backend/src/__tests__/database-provisioning.test.ts`

### Implementation for User Story 2

- [X] T016 [US2] Implement action `delete` with `DROP DATABASE ... WITH (FORCE)` and `DROP ROLE IF EXISTS` in `app/backend/src/routes/functions.ts`
- [X] T017 [US2] Update `project_database_connections.status = 'deleted'` after successful deletion in `app/backend/src/routes/functions.ts`

**Checkpoint**: Project deletion cleans up databases, roles, and metadata

---

## Phase 5: User Story 3 — Failure During Provisioning (Priority: P3)

**Goal**: When provisioning partially fails, the system marks the project as failed with diagnostic context and blocks user access.

**Independent Test**: Simulate role grant failure after DB creation → verify status = 'failed', last_error populated, user receives error on access attempt.

### Tests for User Story 3

- [X] T018 [P] [US3] Write Jest test simulating partial provisioning failure in `app/backend/src/__tests__/database-provisioning.test.ts`

### Implementation for User Story 3

- [X] T019 [US3] Add error handling for partial failures (DB created but role/grant fails) in `app/backend/src/routes/functions.ts`
- [X] T020 [US3] Populate `project_database_connections.last_error` and set `status = 'failed'` on partial failure in `app/backend/src/routes/functions.ts`
- [X] T021 [US3] Block user access when status is `failed` — return error with diagnostic context in `app/backend/src/routes/functions.ts`

**Checkpoint**: Failed provisions are properly tracked and surfaced to users/operators

---

## Phase 6: Schema Removal & Caller Migration

**Purpose**: Remove all schema-based code paths and migrate remaining callers to per-database model

- [X] T022 Remove `CREATE SCHEMA IF NOT EXISTS` logic from `handleDatabaseProvisioning` in `app/backend/src/routes/functions.ts`
- [X] T023 Remove `DROP SCHEMA ... CASCADE` logic from `handleDatabaseProvisioning` in `app/backend/src/routes/functions.ts`
- [X] T024 Remove `information_schema.schemata` queries from `handleDatabaseProvisioning` in `app/backend/src/routes/functions.ts`
- [X] T025 Remove `search_path` from connection info responses in `app/backend/src/routes/functions.ts`
- [X] T026 Update `get_schema` case (~line 690) to connect to project's own DB via pool factory in `app/backend/src/routes/functions.ts`
- [X] T027 Update all `userDataQuery()` / `getUserDataClient()` callers in `app/backend/src/routes/functions.ts` to use pool factory with project DB target

---

## Phase 7: Frontend Updates

**Purpose**: Update frontend components to display per-database model instead of per-schema model

- [X] T028 [P] Remove `SET search_path` hints and refactor `handleDropSchemaRequest` to database-level drop in `app/frontend/src/components/deploy/DatabaseExplorer.tsx`
- [X] T029 [P] Change `table_schema = schemaName` to `table_schema = 'public'` and update "Schema:" labels to "Database:" in `app/frontend/src/components/deploy/DatabaseSchemaTree.tsx`
- [X] T030 [P] Remove schema-name-based filtering logic in `app/frontend/src/components/project/DatabaseSchemaSelector.tsx`
- [X] T031 [P] Add provisioning status badges (available | failed | deleted) if not already present in database display components

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Build validation, grep verification, and final E2E testing

- [ ] T032 Run `npm run lint` (root) and fix any lint errors
- [ ] T033 Run `npm run build` (root) and fix any build errors
- [ ] T034 Run `npm run build` in `app/backend/` and fix any build errors
- [ ] T035 Run Jest tests in `app/backend/` and ensure all pass
- [X] T036 Grep verification: confirm no `search_path`, `CREATE SCHEMA`, or `DROP SCHEMA` references remain in API code
- [ ] T037 E2E manual test: Provision → connect → query → delete workflow locally

---

## Dependencies

```
Phase 1 (Setup)
  └── Phase 2 (Pool Factory)
        ├── Phase 3 (US1: Provisioning) ← MVP
        │     ├── Phase 4 (US2: Deletion)
        │     ├── Phase 5 (US3: Failure Handling)
        │     └── Phase 6 (Schema Removal)
        │           └── Phase 7 (Frontend)
        │                 └── Phase 8 (Polish)
```

## Parallel Execution Opportunities

| Tasks                  | Reason                                |
| ---------------------- | ------------------------------------- |
| T001, T002, T003       | Independent infrastructure files      |
| T009, T015, T018       | Test files can be written in parallel |
| T028, T029, T030, T031 | Independent frontend component files  |
| T032, T033, T034       | Independent build/lint commands       |

## Implementation Strategy

1. **MVP**: Phases 1–3 (Setup + Pool Factory + Provisioning) — delivers core value
2. **Complete**: Add Phases 4–5 (Deletion + Failure Handling) — full API lifecycle
3. **Cleanup**: Phase 6 (Schema Removal) — removes legacy code paths
4. **UI**: Phase 7 (Frontend) — user-facing updates
5. **Ship**: Phase 8 (Polish) — build validation and E2E verification

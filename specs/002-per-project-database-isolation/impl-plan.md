# Implementation Plan: Per-Project Database Isolation

**Branch**: `002-per-project-database-isolation` | **Date**: May 7, 2026 | **Spec**: [spec.md](spec.md)  
**Status**: Ready for Phase 1 → Phase 2 → Phase 3 (phased delivery)

---

## Executive Summary

Migrate project database provisioning from **per-schema isolation** (shared `pronghorn_user_data` database with `CREATE SCHEMA` per project) to **per-database isolation** (`CREATE DATABASE` per project) on the **existing single PostgreSQL server**. This replaces `search_path`-based schema switching with direct database connections, improves failure isolation between projects, and establishes the foundation for future server separation.

**What changed** (May 7, 2026): Second PostgreSQL server requirement removed from this feature. All two-server architecture decisions preserved in [docs/analysis/SECOND_POSTGRESQL_SERVER.md](../../docs/analysis/SECOND_POSTGRESQL_SERVER.md) for future implementation.

**Key design principle**: Replace duplicated pool construction with a shared pool factory and keyed cache so the same abstraction serves admin and project database connections without code duplication.

---

## Technical Context

| Aspect                   | Details                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| **Language/Version**     | TypeScript 5.x (Node.js 18+), PostgreSQL 14+                                        |
| **Primary Dependencies** | Express.js, pg library, Terraform azapi_resource                                    |
| **Storage**              | Existing Azure PostgreSQL Flexible Server (single server)                           |
| **Testing**              | Jest (API), Vitest (frontend), manual E2E                                           |
| **Target Platform**      | Azure Container Apps + Azure PostgreSQL Flexible Server                             |
| **Project Type**         | Greenfield (fresh deployments only; no migration of existing schema-based projects) |
| **Performance Goals**    | Provision <10s, delete <5s, no latency regression                                   |
| **Constraints**          | Non-transactional CREATE DATABASE, operator-driven recovery, no async retry         |

---

## Constitution Check

### I. Contract Preservation

✅ **PASS** — Internal implementation details only; no user-facing contract breaks.
- API endpoint response contract unchanged (actions: create, delete, status, connectionInfo)
- Connection string format updated internally; stored in existing table
- Project DB naming convention preserved

### II. Spec-Driven Traceability

✅ **PASS** — Each requirement maps to concrete implementation files:
- **Infrastructure**: `docker-compose.yml` (CREATEDB privilege), `infra/modules/postgresql/` (CREATEDB grant)
- **API**: `app/backend/src/routes/functions.ts` (`handleDatabaseProvisioning`), `app/backend/src/utils/database.ts` (pool factory)
- **Database**: Existing `project_database_connections` table (no new migration)
- **Frontend**: `app/frontend/src/components/deploy/DatabaseExplorer.tsx`, `app/frontend/src/components/deploy/DatabaseSchemaTree.tsx`

### III. Verification Before Merge (NON-NEGOTIABLE)

| Layer          | Requirement                                          | Validation                                 |
| -------------- | ---------------------------------------------------- | ------------------------------------------ |
| Infrastructure | API user has CREATEDB privilege                      | Local docker-compose test + Terraform plan |
| API            | Provisioning creates/deletes databases (not schemas) | Jest integration tests + manual curl       |
| API            | Pool factory replaces duplicated pool code           | Code review + Jest tests                   |
| Frontend       | Schema references removed; database model displayed  | `npm run lint` + visual inspection         |
| E2E            | Provision → query → delete workflow                  | Local manual test                          |

### IV. Security and Compliance by Default

✅ **PASS** — Credentials/RBAC properly scoped:
- **Secrets**: Per-project role passwords stored in `project_database_connections.connection_string` (plaintext; Key Vault deferred)
- **RBAC**: Each project has dedicated role; scoped to public schema of its own database
- **Isolation**: Per-database model prevents cross-project data access via credential separation

### V. Operability and Reproducible Delivery

✅ **PASS** — Clear deployment and rollback paths:
- **Deployment**: CREATEDB privilege grant is the only infrastructure change; reversible
- **Rollback**: Drop project databases, revert API code to schema-based provisioning
- **Monitoring**: `project_database_connections.status` column enables operational queries
- **No Terraform infrastructure changes** required (no new servers, NSG rules, or env vars)

### VI. UI/UX Layout Immutability

✅ **PASS** — No layout changes; only label and data source updates within existing component bounds.

---

## Affected Layers & Validation

| Layer                        | Touched?    | Validation Required                                     |
| ---------------------------- | ----------- | ------------------------------------------------------- |
| Web App (`app/frontend/src/`)             | **Yes**     | `npm run lint`, `npm run build`, visual component tests |
| API (`app/backend/`)                 | **Yes**     | `npm run build`, Jest integration tests                 |
| Infrastructure (`infra/`)    | **Minimal** | CREATEDB privilege grant; `terraform plan`              |
| CI/CD (`.github/workflows/`) | **No**      | No workflow changes required                            |

---

## Phased Implementation Timeline

### Phase 1: Infrastructure & Pool Factory

**Duration**: 1 sprint | **Deliverable**: CREATEDB privilege + shared pool factory abstraction

**Tasks**:

1. **CREATEDB Privilege — Local Dev** (`docker-compose.yml`):
   - Ensure the API database user has `CREATEDB` privilege
   - Add to init SQL or use `POSTGRES_INITDB_ARGS` if needed

2. **CREATEDB Privilege — Azure** (`infra/modules/postgresql/`):
   - Ensure Terraform-provisioned API user has CREATEDB
   - May require post-provisioning script or `azapi_resource` for role alteration

3. **Shared Pool Factory** (`app/backend/src/utils/database.ts`):
   - Replace duplicated pool construction (main pool vs `getUserDataPool()`) with a shared pool factory and keyed cache
   - Introduce a parameterized target model keyed by `database` name (single server — no `server` parameter needed; add that when second server is introduced per [SECOND_POSTGRESQL_SERVER.md](../../docs/analysis/SECOND_POSTGRESQL_SERVER.md))
   - Keep thin wrappers for common call sites, routing through one implementation:
     - `getPool()` → existing main pool (backward compatible wrapper)
     - `getUserDataPool()` → existing user data pool (backward compatible wrapper)
     - Project database admin operations → factory with `{ database: 'postgres' }` or `{ database: 'pronghorn' }` target
     - Project database per-project connections → factory with `{ database: projectDatabaseName }` target
   - Add shared helpers that operate on the factory output:
     - `queryWithPoolTarget(target, text, params)`
     - `getPoolClient(target)`
   - Cache pools by stable composite key; reuse for identical targets
   - Standardize pool defaults in one place (`max`, SSL, idle timeout, connection timeout, keepalive)
   - All targets use the same `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD` credentials (single server) — the factory simply varies the `database` parameter

**Validation**:
- ✅ Existing `getPool()` and `getUserDataPool()` still work (backward compat)
- ✅ Factory can create pool for arbitrary database name on same server
- ✅ Pool cache reuses connections for same target
- ✅ CREATEDB verified locally: `CREATE DATABASE test_db` succeeds, then drop it

---

### Phase 2: API Handler Refactoring

**Duration**: 1 sprint | **Deliverable**: `handleDatabaseProvisioning` uses CREATE/DROP DATABASE instead of CREATE/DROP SCHEMA

**Tasks**:

1. **Action `create`** (`app/backend/src/routes/functions.ts`):
   - Generate random password for role via `crypto.randomBytes()`
   - Use admin-target client from pool factory (connected to `postgres` or `pronghorn` DB)
   - Execute: `CREATE DATABASE "proj_..."`
   - Connect to the newly created project DB
   - Execute: `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`, `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`
   - Execute: `CREATE ROLE "role_..." WITH LOGIN PASSWORD '...'`
   - Grant permissions on public schema
   - Store in `project_database_connections`: connection_string, host, database_name, port, status = 'available'

2. **Action `delete`**:
   - Use admin-target client from pool factory
   - Execute: `DROP DATABASE IF EXISTS "proj_..." WITH (FORCE)`
   - Execute: `DROP ROLE IF EXISTS "role_..."`
   - Update `project_database_connections.status = 'deleted'` or delete record

3. **Action `status`**:
   - Query via admin target: `SELECT datname FROM pg_database WHERE datname = $1`
   - Replace current `information_schema.schemata` query
   - Return: available | deleted | failed

4. **Action `connectionInfo`**:
   - Fetch from `project_database_connections.connection_string`
   - Return: host, port, database_name, role (no `search_path`)
   - Remove schema field and `search_path` note from response

5. **Error Handling**:
   - Catch partial failures (DB created but role grant fails)
   - Populate `project_database_connections.last_error`
   - Mark status = 'failed'
   - Block user access until operator resolves
   - Handle `42P04` (duplicate_database) error from concurrent `CREATE DATABASE` as non-fatal — treat existing DB as success if role and grants are in place

6. **Remove schema-based code paths**:
   - Remove `CREATE SCHEMA IF NOT EXISTS` logic in `handleDatabaseProvisioning`
   - Remove `DROP SCHEMA ... CASCADE` logic in `handleDatabaseProvisioning`
   - Remove `information_schema.schemata` queries in `handleDatabaseProvisioning` (status action)
   - Remove `search_path` from connection info responses

7. **Update `get_schema` case** (functions.ts ~line 690):
   - The `get_schema` case queries `information_schema.schemata` for schema introspection — this is a separate feature from provisioning
   - Update to connect to the project's own database (via pool factory target) instead of using `pronghorn_user_data` with schema context
   - Schema list query remains valid (introspects the project DB's schemas), but connection source changes

8. **Update remaining callers in functions.ts**:
   - All `userDataQuery()` and `getUserDataClient()` calls are in `functions.ts` (not `rpc.ts` — verified no schema-related calls exist in rpc.ts)
   - SQL execution routes → connect to project's own DB instead of `pronghorn_user_data` with `search_path`

**Validation**:
- ✅ Create project → database exists in `pg_database`, extensions installed, role can connect
- ✅ Delete project → database and role gone
- ✅ Status returns correct state
- ✅ Connection info returns direct DB connection (no search_path)
- ✅ Jest integration tests for all four actions
- ✅ Error handling test: simulate role grant failure → status = 'failed'

---

### Phase 3: Frontend Updates & E2E Testing

**Duration**: 0.5 sprint | **Deliverable**: Frontend updated + full E2E verification

**Tasks**:

1. **Frontend Updates**:
   - `DatabaseExplorer.tsx`: Remove `SET search_path` hints; query `public` schema of project DB directly; refactor `handleDropSchemaRequest` to a database-level drop operation (rename to `handleDropDatabaseRequest` or similar)
   - `DatabaseSchemaTree.tsx`: Change `table_schema = schemaName` to `table_schema = 'public'`; update "Schema:" labels to "Database:"
   - `DatabaseSchemaSelector.tsx`: Remove schema-name-based filtering logic (line ~386); update to work with per-database model
   - Connection info display: remove `search_path` note
   - Add provisioning status badges (available | failed | deleted) if not already present

2. **E2E Testing**:
   - **Local**: Provision → connect → query → delete workflow
   - **Staging**: Create 3 test projects, verify all provisioned, query app DB to confirm no performance impact, delete all
   - **Performance**: Measure provision/delete latency (<10s / <5s targets)

3. **Build Validation**:
   - `npm run lint` (root)
   - `npm run build` (root)
   - `npm run build` (api/)
   - Jest tests pass
   - No `search_path` references remain in codebase (grep verification)

**Validation**:
- ✅ All Jest tests pass
- ✅ Frontend displays per-database model correctly
- ✅ No `search_path` or `CREATE SCHEMA` references in codebase
- ✅ No lint/build errors

---

## Data Model: `project_database_connections` Table

**Existing table reused** (no new migration required):

| Column              | Type        | Usage                                                                   |
| ------------------- | ----------- | ----------------------------------------------------------------------- |
| `id`                | UUID        | Unique record ID                                                        |
| `project_id`        | UUID        | FK to project                                                           |
| `name`              | text        | Connection display name                                                 |
| `description`       | text        | User-provided description                                               |
| `connection_string` | text        | `postgresql://role_...:{password}@{host}:5432/proj_...?sslmode=require` |
| `host`              | text        | Existing server FQDN (same as `POSTGRES_HOST`)                          |
| `port`              | integer     | 5432                                                                    |
| `database_name`     | text        | `proj_${projectId.replace(/-/g, '_').substring(0, 20)}`                 |
| `ssl_mode`          | text        | `require`                                                               |
| `status`            | text        | `available                                                              | deleted | failed | untested` |
| `last_connected_at` | timestamptz | Last successful query timestamp                                         |
| `last_error`        | text        | Error context from failed provision                                     |
| `created_at`        | timestamptz | Audit trail                                                             |
| `updated_at`        | timestamptz | Audit trail                                                             |

**API Behavior**:
- On `create` success: populate all fields; status = 'available'; host = existing POSTGRES_HOST
- On `create` failure: status = 'failed'; populate last_error
- On `delete`: status = 'deleted' or remove record

---

## Source Code Changes

```text
api/
├── src/
│   ├── utils/
│   │   └── database.ts        # REFACTOR: Shared pool factory replacing duplicated pool code
│   ├── routes/
│   │   └── functions.ts       # MODIFY: handleDatabaseProvisioning + get_schema + callers (schema → database)
│   └── __tests__/
│       └── database-provisioning.test.ts  # NEW: Jest integration tests

docker-compose.yml             # MODIFY: CREATEDB privilege for API user

infra/
└── modules/
    └── postgresql/
        └── main.tf            # MODIFY: Ensure API user CREATEDB privilege (if needed)

src/
└── components/
    ├── deploy/
    │   ├── DatabaseExplorer.tsx    # MODIFY: Remove search_path, refactor handleDropSchemaRequest
    │   └── DatabaseSchemaTree.tsx  # MODIFY: Schema → Database labels
    └── project/
        └── DatabaseSchemaSelector.tsx  # MODIFY: Remove schema-based filtering
```

---

## Environment Variables

**No new environment variables required.** All connections use existing `POSTGRES_*` variables:

```
POSTGRES_HOST          = (existing server FQDN)
POSTGRES_PORT          = 5432
POSTGRES_DATABASE      = pronghorn
POSTGRES_USER          = (existing admin user — now with CREATEDB)
POSTGRES_PASSWORD      = (from Key Vault)
POSTGRES_USER_DATA_DB  = pronghorn_user_data  (retained for backward compat; may be removed later)
POSTGRES_SSL           = true
```

---

## Deployment Phases & Rollout

| Phase | Sprint | Component                                   | Status    |
| ----- | ------ | ------------------------------------------- | --------- |
| **1** | 1      | CREATEDB privilege + shared pool factory    | 🔄 PENDING |
| **2** | 1      | API handler refactoring (schema → database) | 🔄 PENDING |
| **3** | 1      | Frontend updates + E2E testing              | 🔄 PENDING |

---

## Success Criteria

| Metric                     | Target           | Validation Method                                                  |
| -------------------------- | ---------------- | ------------------------------------------------------------------ |
| All tests passing          | 100%             | Jest + `npm run build` green                                       |
| Provisioning latency       | <10 seconds      | Stopwatch test (local + staging)                                   |
| Deletion latency           | <5 seconds       | Stopwatch test (local + staging)                                   |
| Metadata accuracy          | 100% consistency | Query `project_database_connections` vs. actual DB state           |
| Connection string validity | 100%             | Test connection with stored credentials                            |
| Schema removal             | 100%             | Grep: no `search_path`, `CREATE SCHEMA`, `DROP SCHEMA` in API code |
| UI correctness             | 100%             | Visual verification of per-database display                        |

---

## Deferred Items (Future Features)

| Item                              | Deferred To                             | Reference                                                                      |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| Second PostgreSQL server          | Future feature                          | [SECOND_POSTGRESQL_SERVER.md](../../docs/analysis/SECOND_POSTGRESQL_SERVER.md) |
| Network isolation (NSG rules)     | Future feature (requires second server) | [SECOND_POSTGRESQL_SERVER.md](../../docs/analysis/SECOND_POSTGRESQL_SERVER.md) |
| Storage isolation (separate disk) | Future feature (requires second server) | [SECOND_POSTGRESQL_SERVER.md](../../docs/analysis/SECOND_POSTGRESQL_SERVER.md) |
| Key Vault credential storage      | Future security hardening               | Out-of-scope                                                                   |
| Credential rotation               | Future security hardening               | Out-of-scope                                                                   |
| Async provisioning retry          | Future operational hardening            | Out-of-scope                                                                   |

---

## Approval & Sign-Off

| Role         | Name          | Date        | Status                       |
| ------------ | ------------- | ----------- | ---------------------------- |
| Architecture | Database Team | May 7, 2026 | ✓ Approved                   |
| Product      | Requirements  | May 7, 2026 | ✓ Approved (scope reduction) |
| Engineering  | API Lead      | TBD         | ⏳ Pending                    |

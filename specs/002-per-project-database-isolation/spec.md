# Feature Specification: Per-Project Database Isolation

**Feature Name**: Per-Project Database Isolation  
**Status**: Ready for Implementation  
**Created**: May 7, 2026  
**Updated**: May 7, 2026 (scope reduction — single server only; second server deferred)  
**Author**: Database Architecture Review  

---

## Executive Summary

Migrate project database provisioning from **per-schema isolation** (shared `pronghorn_user_data` database) to **per-database isolation** on the existing PostgreSQL Flexible Server. Each project gets its own database instead of a schema within a shared database. This improves failure isolation between projects, enables independent resource management per project, and eliminates `search_path`-based connection complexity.

**Scope**: Per-schema → per-database migration on the existing single PostgreSQL server. Fresh deployments only — no backward compatibility with existing schema-based projects.

**Deferred**: Deploying a second dedicated PostgreSQL server for project databases. See [docs/analysis/SECOND_POSTGRESQL_SERVER.md](../../docs/analysis/SECOND_POSTGRESQL_SERVER.md) for that future feature.

---

## Business Objectives

1. **Failure isolation**: A project database failure (corruption, runaway query, disk full) does not impact other project databases
2. **Clean connection model**: Direct database connections replace `search_path`-based schema switching, reducing connection complexity and misconfiguration risk
3. **Independent lifecycle**: Project databases can be backed up, restored, or dropped independently without affecting other projects
4. **Future readiness**: Per-database model is a prerequisite for future server separation (dedicated projects server)

---

## User Scenarios & Acceptance Workflows

### Scenario 1: Project Provisioning
**Actor**: System (API service)  
**Trigger**: User creates a new project via API  
**Expected Outcome**: Project database is created on the existing server with isolated role and connection string

**Steps**:
1. API receives project creation request
2. API generates project DB name: `proj_${projectId.replace(/-/g, '_').substring(0, 20)}`
3. API connects to the existing PostgreSQL server with admin credentials and executes:
   - `CREATE DATABASE "proj_..."`
   - `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` (on project DB)
   - `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` (on project DB)
   - `CREATE ROLE "role_..." WITH LOGIN PASSWORD '...'`
   - `GRANT USAGE, CREATE ON SCHEMA public TO "role_..."`
   - `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "role_..."`
   - `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "role_..."`
   - `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "role_..."`
4. API stores connection string in `project_database_connections` table with host and database name
5. API updates `project_database_connections.status = 'available'`
6. User project container can now query its own database using stored connection string

**Acceptance Criteria**:
- ✓ Database exists on the server with correct naming convention
- ✓ Extensions uuid-ossp and pgcrypto are installed
- ✓ Dedicated role exists and can authenticate
- ✓ Role has CRUD permissions on public schema
- ✓ Connection string stored in metadata table is valid and tested
- ✓ Provision operation completes in < 10 seconds
- ✓ Project container can execute SQL against its database

---

### Scenario 2: Project Deletion
**Actor**: System (API service)  
**Trigger**: User deletes a project or admin deletes via API  
**Expected Outcome**: Project database, role, and metadata records are deleted

**Steps**:
1. API receives project deletion request
2. API queries `project_database_connections` for project provisioning record
3. API extracts database name from record
4. API connects to server with admin credentials and executes:
   - `DROP DATABASE IF EXISTS "proj_..." WITH (FORCE)` (terminates active connections)
   - `DROP ROLE IF EXISTS "role_..."`
5. API deletes or updates `project_database_connections` record

**Acceptance Criteria**:
- ✓ Database does not exist after deletion
- ✓ Role cannot authenticate after deletion
- ✓ Metadata record is updated (status = 'deleted') or removed
- ✓ Delete operation completes in < 5 seconds
- ✓ No orphaned databases or roles remain

---

### Scenario 3: Failure During Provisioning
**Actor**: System (API service)  
**Trigger**: DB creation succeeds but role grant fails (permission issue, connection drop, etc.)  
**Expected Outcome**: Project marked as failed; user cannot access project

**Steps**:
1. DB is created successfully
2. Role creation or permission grant fails with error
3. Exception is caught in provisioning handler
4. API updates `project_database_connections.status = 'failed'` and stores error in `last_error` column
5. API logs error for operator review
6. User project container cannot connect (no valid connection string or status check prevents access)

**Acceptance Criteria**:
- ✓ Failed provision is marked in metadata table
- ✓ User receives error when attempting to access project
- ✓ Error message provides diagnostic context
- ✓ Operator can retry provisioning after root cause is fixed
- ✓ No partial state persists (manual cleanup may be required for orphaned DB)

---

## Functional Requirements

### Infrastructure

| ID    | Requirement           | Details                                                                                         |
| ----- | --------------------- | ----------------------------------------------------------------------------------------------- |
| INF-1 | CREATEDB Privilege    | API database user must have `CREATEDB` privilege on the existing PostgreSQL Flexible Server     |
| INF-2 | Extensions Allowed    | Server `azure.extensions` config must include uuid-ossp, pgcrypto                               |
| INF-3 | Docker Compose Update | Local dev `docker-compose.yml` must grant CREATEDB to the API user                              |
| INF-4 | Terraform CREATEDB    | Ensure Terraform-provisioned API user has CREATEDB (post-provisioning script or azapi_resource) |

### API Implementation

| ID    | Requirement        | Details                                                                                                              |
| ----- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| API-1 | Provision Endpoint | `handleDatabaseProvisioning` action `'create'` creates **database** (not schema) on the existing server              |
| API-2 | Delete Endpoint    | `handleDatabaseProvisioning` action `'delete'` drops **database** with `WITH (FORCE)` (not `DROP SCHEMA CASCADE`)    |
| API-3 | Status Check       | `handleDatabaseProvisioning` action `'status'` queries `pg_database` (not `information_schema.schemata`)             |
| API-4 | Connection Info    | Returns connection string pointing to project DB directly — no `search_path`                                         |
| API-5 | Error Handling     | Failed provisions mark status as `failed` with error context; user cannot access project                             |
| API-6 | DB Naming          | Format: `proj_${projectId.replace(/-/g, '_').substring(0, 20)}`                                                      |
| API-7 | Role Creation      | Each project gets dedicated role: `role_${projectId}` with scoped permissions on public schema                       |
| API-8 | Transaction Safety | CREATE DATABASE cannot be transactional; error handling must account for partial failures                            |
| API-9 | Pool Abstraction   | Replace duplicated pool construction with a shared pool factory keyed by target (server, database, credentialSource) |

### Database Schema

| ID   | Requirement      | Details                                                                                                                                           |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB-1 | Metadata Storage | Existing `project_database_connections` table tracks per-database provisioning (database_name, host, port, connection_string, status, last_error) |
| DB-2 | Status Values    | `status` column values: `available                                                                                                                | deleted | failed | untested` |
| DB-3 | Error Logging    | Use existing `last_error` column to store provisioning failure context                                                                            |
| DB-4 | Extensions       | uuid-ossp, pgcrypto created on every project DB at creation time                                                                                  |

### Frontend (Minimal)

| ID   | Requirement        | Details                                                                                                                             |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| FE-1 | Database Explorer  | Remove `SET search_path` hints; query only `public` schema of project DB; refactor `handleDropSchemaRequest` to database-level drop |
| FE-2 | Connection Display | Remove "Schema:" label; show "Database:" name instead                                                                               |
| FE-3 | Status Display     | Show project provisioning status (`available                                                                                        | deleted | failed`) |
| FE-4 | Schema Selector    | Update `DatabaseSchemaSelector.tsx` to remove schema-based filtering logic                                                          |

---

## Key Entities

### Existing PostgreSQL Server
- **Host**: Existing `POSTGRES_HOST` (e.g., `pronghorn-dev-db.postgres.database.azure.com`)
- **Databases**: `pronghorn` (app metadata), `pronghorn_user_data` (existing, retained), `proj_*` (new per-project databases)
- **Admin**: Existing admin user with CREATEDB privilege added
- **Network**: Existing private endpoint + NSG rules (no changes)

### Project Database (per project)
- **Name**: `proj_${projectId.replace(/-/g, '_').substring(0, 20)}`
- **Schema**: `public` only (no custom schemas)
- **Extensions**: uuid-ossp, pgcrypto
- **Role**: `role_${projectId}` — scoped read/write on public schema
- **Connection**: Direct to project DB (no `search_path`)

### Metadata Table: `project_database_connections`
- **Existing columns reused**: id, project_id, name, description, connection_string, host, port, database_name, ssl_mode, status, last_error, last_connected_at, created_at, updated_at
- **No new migration required** — API populates existing columns with per-database details

---

## Success Criteria

| Criterion            | Measurement                                                                      | Target       |
| -------------------- | -------------------------------------------------------------------------------- | ------------ |
| Provisioning latency | Time to create project DB from API request                                       | < 10 seconds |
| Deletion latency     | Time to drop project DB from API request                                         | < 5 seconds  |
| Connection validity  | % of created project DBs with valid, tested connection strings                   | 100%         |
| Failure recovery     | % of failed provisions correctly marked with status + error context              | 100%         |
| Metadata accuracy    | % of `project_database_connections` records matching actual DB state on server   | 100%         |
| Schema removal       | All `SET search_path` and schema-based connection patterns removed from codebase | 100%         |

---

## Assumptions & Dependencies

### Assumptions
1. **Fresh deployment only**: No migration of existing schema-based projects; this applies to new deployments only
2. **No data migration**: Existing user project data in `pronghorn_user_data` schemas is not migrated
3. **AI threat model**: AI cannot access other project connection strings; application-level isolation is sufficient
4. **Admin connectivity**: API user has CREATEDB privilege (added as part of this feature)
5. **Single API instance**: No distributed lock needed for creation idempotency; concurrent duplicate `CREATE DATABASE` calls produce a `42P04` (duplicate_database) error which is caught and treated as non-fatal

### Dependencies
- Existing Azure PostgreSQL Flexible Server
- `azure.extensions` server configuration allowing uuid-ossp, pgcrypto
- Docker Compose local dev setup with CREATEDB-capable user

---

## Constraints & Limitations

| Constraint                        | Impact                                                  | Mitigation                                                                                 |
| --------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| CREATE DATABASE not transactional | Partial failure possible (DB created, role grant fails) | Mark status `failed`, block user access, require manual recovery for orphaned DB           |
| No async retry                    | Failed provisions don't auto-retry                      | Operator must fix root cause and retry; documented as out-of-scope                         |
| No per-project secret rotation    | Project credentials static for lifetime                 | Deferred to future security hardening; plaintext storage in metadata acceptable short-term |
| Shared server resources           | All project DBs share CPU/memory/disk with app DB       | Acceptable for current scale; second server deferred to future feature                     |
| Max project count                 | Limited by single server's connection pool and disk     | 50-100 concurrent projects acceptable for current usage                                    |

---

## Out-of-Scope (Deferred to Future Work)

- **Second PostgreSQL server**: Separate server for project databases (see [SECOND_POSTGRESQL_SERVER.md](../../docs/analysis/SECOND_POSTGRESQL_SERVER.md))
- **Network isolation**: NSG-based separation between app and project databases (requires second server)
- **Storage isolation**: Separate disk for project databases (requires second server)
- **Key Vault integration**: Credential storage and rotation
- **Async provisioning retry**: Failed provisions require manual operator intervention
- **Monitoring & alerting**: Project DB disk usage alerts
- **Backward compatibility**: No coexistence with schema-based model

---

## Acceptance Workflow (Testing)

### Local Dev Verification
1. ✓ Ensure local PostgreSQL user has CREATEDB privilege
2. ✓ Create project DB via API endpoint; verify DB, extensions, role exist
3. ✓ Connect to project DB using stored credentials
4. ✓ Delete project DB via API; verify DB and role are gone
5. ✓ Simulate provisioning failure; verify status = `failed`, user cannot access

### Integration Testing
1. ✓ API can create/delete databases on the existing server
2. ✓ Project container can query its own DB using stored connection string
3. ✓ Project container cannot query other projects' databases (credential isolation)
4. ✓ Status endpoint correctly reflects available/failed/deleted states
5. ✓ `SET search_path` is no longer used anywhere in the codebase

### Production Deployment
1. ✓ API user has CREATEDB privilege on production server
2. ✓ Create 3 test projects; verify all provisioned successfully
3. ✓ Query application DB from API; confirm no performance impact
4. ✓ Delete all test projects; verify clean state

---

## Related Documents

- [Analysis: Per-Project Database Isolation](../../docs/analysis/PER_PROJECT_DATABASE_ISOLATION.md)
- [Future: Second PostgreSQL Server](../../docs/analysis/SECOND_POSTGRESQL_SERVER.md)
- [Terraform Modules](../../infra/modules/postgresql/)
- [API Functions Routes](../../app/backend/src/routes/functions.ts) — `handleDatabaseProvisioning`

---

## Approval & Sign-Off

| Role         | Name          | Date        | Status     |
| ------------ | ------------- | ----------- | ---------- |
| Architecture | Database Team | May 7, 2026 | ✓ Approved |
| Product      | Requirements  | May 7, 2026 | ✓ Approved |
| Engineering  | API Lead      | Pending     | -          |

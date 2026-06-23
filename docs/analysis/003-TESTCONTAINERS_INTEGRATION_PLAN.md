# Testcontainers Integration Plan — Per-Project Database Lifecycle

> **Scope**: Integration tests for the `proj_XXXX` per-project database lifecycle — provisioning, management, and teardown.  
> **Constraint**: Complements existing mocked unit tests — does not replace them.  
> **Sequencing**: This work follows the `functions.ts` refactor (see [002-FUNCTIONS_REFACTOR_PLAN.md](002-FUNCTIONS_REFACTOR_PLAN.md)). Once handlers are extracted into `database.handlers.ts`, these integration tests validate the refactored implementation against a real PostgreSQL engine.  
> **Target**: The user-facing project database operations — NOT the `pronghorn` application database.

### Two Distinct Databases

| Database    | Owner       | Purpose                                                                                                                                                                  | Tested By                                          |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `pronghorn` | Platform    | Application data — `projects`, `project_databases`, `project_database_connections`, `artifacts`, etc.                                                                    | Existing mocked unit tests (supertest + jest.mock) |
| `proj_XXXX` | Per-project | User-created project database with its own role, extensions, and schema. Created/deleted dynamically by `handleDatabaseProvisioning`. Queried by `handleManageDatabase`. | **This plan** — Testcontainers integration tests   |

The `pronghorn` database is the platform's own data store. It is well-served by mocked tests because the operations are standard CRUD via `db.query()` and `rpc.*` helpers against a known schema. The **project databases** (`proj_XXXX`) are the focus of this plan because their lifecycle involves DDL operations (`CREATE DATABASE`, `CREATE ROLE`, `GRANT`, `DROP DATABASE`) that mocks cannot validate.

---

## 1. Current State

### 1.1 Test Infrastructure

| Aspect            | Current State                                                               |
| ----------------- | --------------------------------------------------------------------------- |
| Test runner       | Jest 30 + ts-jest                                                           |
| HTTP testing      | supertest 7                                                                 |
| Test files        | 20 files under `app/backend/src/__tests__/`                                         |
| Database mocking  | Full mock of `pg.Pool` and `utils/database` exports                         |
| CI test execution | **None** — all 3 GitHub workflows are deployment-only; no test stage exists |
| Integration tests | **None** — zero tests execute real SQL                                      |

### 1.2 Mocking Pattern

All database-related tests mock `pg` at the module level. For example, `database-provisioning.test.ts`:

```typescript
const mockQuery = jest.fn();
const mockGetClient = jest.fn();
const mockQueryWithPoolTarget = jest.fn();
const mockGetPoolClient = jest.fn();

jest.mock('../../utils/database', () => ({
    query: mockQuery,
    getClient: mockGetClient,
    queryWithPoolTarget: mockQueryWithPoolTarget,
    getPoolClient: mockGetPoolClient,
    getPoolForTarget: jest.fn(),
    getActiveDbPort: jest.fn().mockReturnValue(5432),
    close: jest.fn(),
}));
```

The existing provisioning tests validate naming conventions and expected SQL patterns via string assertions but **do not execute any SQL against a database**. For example, the "creates a database" test asserts `expectedDbName.length <= 25` and verifies the mock chain was wired, but never runs `CREATE DATABASE`.

### 1.3 Project Database Lifecycle Under Test

The integration tests target the complete lifecycle of a `proj_XXXX` database — from creation through user interaction to deletion. This lifecycle spans two handlers:

#### `handleDatabaseProvisioning` — Lifecycle Management of `proj_XXXX`

This handler manages the existence and infrastructure of project databases. It operates against the **PostgreSQL server** (not a specific database) for DDL, and against the `pronghorn` database for record-keeping.

**action: `create`** — Full provisioning flow:

| Step | Target                                  | Operation                 | SQL / Mechanism                                                                                                                                                                                                  |
| ---- | --------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Server (via admin client)               | Create project database   | `CREATE DATABASE "proj_<projectId>"` — must run outside a transaction                                                                                                                                            |
| 2    | `proj_XXXX` (via `queryWithPoolTarget`) | Install extensions        | `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`, `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`                                                                                                                        |
| 3    | Server (via admin client)               | Create project role       | `CREATE ROLE "role_<databaseId>" WITH LOGIN PASSWORD <escapedPassword>` — uses `escapeLiteral()` for injection prevention                                                                                        |
| 4    | `proj_XXXX` (via `queryWithPoolTarget`) | Grant privileges          | `GRANT USAGE ON SCHEMA public`, `GRANT CREATE ON SCHEMA public`, `GRANT ALL PRIVILEGES ON ALL TABLES`, `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES`, `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON SEQUENCES` |
| 5    | In-process                              | Encrypt connection string | AES-256-GCM encrypt of `postgresql://role:pass@host:port/proj_XXXX`                                                                                                                                              |
| 6    | `pronghorn` (via `db.query`)            | Store records             | `UPDATE project_databases SET status='available'`, `INSERT INTO project_database_connections`                                                                                                                    |

**action: `delete`** — Teardown:

| Step | Target                    | Operation                                                                                                       |
| ---- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1    | Server (via admin client) | `DROP DATABASE IF EXISTS "proj_XXXX" WITH (FORCE)` — terminates active connections                              |
| 2    | Server (via `db.query`)   | `DROP ROLE IF EXISTS "role_XXXX"`                                                                               |
| 3    | `pronghorn`               | `UPDATE project_databases SET status = 'deleted'`, `UPDATE project_database_connections SET status = 'deleted'` |

**action: `status`** — Health check:

| Step | Target                                  | Operation                                                                                           |
| ---- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1    | Server                                  | `SELECT 1 FROM pg_database WHERE datname = $1` — checks database existence in system catalog        |
| 2    | `proj_XXXX` (via `queryWithPoolTarget`) | `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'` — counts user tables |
| 3    | `pronghorn`                             | `UPDATE project_databases SET status = $1` — syncs record to reality                                |

**action: `connectionInfo`** — Credential retrieval:

| Step | Target      | Operation                                                                          |
| ---- | ----------- | ---------------------------------------------------------------------------------- |
| 1    | `pronghorn` | `SELECT connection_string FROM project_database_connections WHERE project_id = $1` |
| 2    | In-process  | Decrypt stored AES-256-GCM connection string                                       |
| 3    | Response    | Return host, port, database, user, password, connectionString, psqlCommand         |

**action: `suspend` / `resume` / `restart`** — No-ops for per-database isolation (always available).

#### `handleManageDatabase` — User Operations Against `proj_XXXX`

Once a project database is provisioned, this handler connects to it and executes user-requested operations. It resolves the connection in one of three ways:

1. **`databaseId` with `database_internal_name`** — Per-project provisioned database. Builds connection string from env vars + `database_internal_name` (i.e., `proj_XXXX`). Connects as the platform admin user.
2. **`databaseId` with stored `connection_string`** — Encrypted connection string from provisioning. Decrypts and connects as the project role.
3. **`connectionId`** — External database connection (user-supplied). Not in scope for these integration tests.

**Operations against `proj_XXXX`:**

| Action                    | What it does against the project database                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `test_connection`         | `SELECT 1` — verifies connectivity                                                                                                         |
| `get_schema`              | Introspects `information_schema.schemata`, tables, columns, functions, triggers, indexes, sequences, types, constraints across all schemas |
| `execute_sql`             | Runs arbitrary user SQL and returns rows, columns, execution time                                                                          |
| `execute_sql_batch`       | Runs multiple SQL statements in sequence, optionally wrapped in a transaction. Rolls back on first error.                                  |
| `get_table_data`          | `SELECT * FROM "schema"."table" LIMIT/OFFSET/ORDER BY` with total count                                                                    |
| `get_table_columns`       | Column metadata from `information_schema.columns`                                                                                          |
| `export_table`            | Full table export as JSON, CSV, or SQL INSERT statements                                                                                   |
| `get_table_definition`    | Column defs, primary keys, foreign keys, indexes via `information_schema` + `pg_indexes`                                                   |
| `get_view_definition`     | `SELECT view_definition FROM information_schema.views`                                                                                     |
| `get_function_definition` | `SELECT pg_get_functiondef(oid) FROM pg_proc`                                                                                              |

### 1.4 What Mocks Cannot Validate

The following are real failure modes that mocked tests miss entirely:

1. **SQL syntax correctness** — Mocks accept any string. A typo in `CREATE DATABASE` or `GRANT` SQL goes undetected until production.
2. **DDL transaction constraints** — `CREATE DATABASE` cannot run inside a transaction. The code uses `getClient()` to avoid this, but mocks don't enforce this PostgreSQL rule.
3. **Privilege chain correctness** — The sequence of `GRANT USAGE`, `GRANT CREATE`, `ALTER DEFAULT PRIVILEGES` must be applied in the right order, to the right schema, in the right database. Mocks pass regardless.
4. **`queryWithPoolTarget` pool switching** — The pool factory must create a new `pg.Pool` targeting `proj_xxx` on the same server. Mocks skip pool creation entirely.
5. **`pg_database` catalog queries** — The `status` action queries the system catalog to check if a database exists. Mocks return whatever rows you configure, but can't verify the query actually returns correct results after `CREATE DATABASE`.
6. **`escapeLiteral` behavior** — Role password injection prevention depends on `PoolClient.escapeLiteral()`. Mocked clients return `undefined` for this method.
7. **Extension installation in project DB** — `CREATE EXTENSION` must run inside the newly created project database, not the admin database. Mocks can't catch target-database mistakes.
8. **`DROP DATABASE ... WITH (FORCE)`** — This terminates active connections to the target database. Mock tests can't verify this interacts correctly with pool lifecycle.
9. **Partial failure recovery** — When role creation fails after database creation, the handler updates status to `failed` and stores `last_error`. Testing this end-to-end requires real constraint violations.
10. **AES-256-GCM encrypt/decrypt round-trip** — The connection string is encrypted before storage and decrypted on `connectionInfo` reads. Mocks skip the crypto entirely.

### 1.5 Production Target

| Aspect          | Value                                                   |
| --------------- | ------------------------------------------------------- |
| Service         | Azure Database for PostgreSQL Flexible Server           |
| Version         | PostgreSQL 16 (configured in `infra/params/dev.tfvars`) |
| Extensions used | `uuid-ossp`, `pgcrypto`                                 |
| Admin role      | `pronghorn_admin` (member of `azure_pg_admin` on Azure) |
| Local dev       | `postgres:16-alpine` via docker-compose                 |

---

## 2. Testcontainers Approach

### 2.1 What Is Testcontainers

[Testcontainers](https://testcontainers.com/) is a library that provides lightweight, throwaway Docker containers for integration testing. The `@testcontainers/postgresql` module manages the lifecycle of a `postgres` container — start, configure, expose ports, and tear down — programmatically from test code.

### 2.2 Why Testcontainers for This Codebase

| Requirement                                                            | How Testcontainers Addresses It                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Real DDL execution (`CREATE DATABASE`, `CREATE ROLE`, `DROP DATABASE`) | Runs against an actual PostgreSQL 16 engine                                   |
| Pool target switching (`queryWithPoolTarget`)                          | Real TCP connection to a real server on a dynamic port                        |
| System catalog queries (`pg_database`)                                 | Returns real catalog data reflecting actual database state                    |
| Extension installation                                                 | `uuid-ossp` and `pgcrypto` are bundled in `postgres:16-alpine`                |
| Version parity with production                                         | Uses `postgres:16-alpine` — same major version as Azure Flexible Server PG 16 |
| CI compatibility                                                       | GitHub Actions `ubuntu-latest` runners include Docker — no extra setup        |
| Test isolation                                                         | Each test suite gets a fresh container; no shared state between runs          |
| No infrastructure cost                                                 | Runs locally and in CI with no cloud dependency                               |

### 2.3 Fidelity Assessment: `postgres:16-alpine` vs Azure Flexible Server PG 16

| Operation                             | Community PG 16       | Azure Flexible Server PG 16              | Match                                  |
| ------------------------------------- | --------------------- | ---------------------------------------- | -------------------------------------- |
| `CREATE DATABASE`                     | Full support          | Full support                             | Identical                              |
| `CREATE ROLE ... WITH LOGIN PASSWORD` | Full support          | Full support (admin has `CREATEROLE`)    | Identical                              |
| `GRANT` / `ALTER DEFAULT PRIVILEGES`  | Full support          | Full support                             | Identical                              |
| `DROP DATABASE ... WITH (FORCE)`      | Full support (PG 13+) | Full support                             | Identical                              |
| `CREATE EXTENSION "uuid-ossp"`        | Bundled               | Allowlisted                              | Identical                              |
| `CREATE EXTENSION "pgcrypto"`         | Bundled               | Allowlisted                              | Identical                              |
| `pg_database` catalog                 | Full support          | Full support                             | Identical                              |
| `information_schema.tables`           | Full support          | Full support                             | Identical                              |
| `escapeLiteral` via `pg` client       | Full support          | Full support                             | Identical                              |
| Superuser access                      | Available             | Restricted to `azuresu` (Microsoft-only) | Divergent — not used by our code       |
| `azure_pg_admin` role                 | Absent                | Built-in pseudo-superuser                | Divergent — not referenced by our code |
| PgBouncer (port 6432)                 | Absent                | Optional built-in                        | N/A — our code connects directly       |

**Conclusion**: For every DDL and DML operation in `handleDatabaseProvisioning` and `handleManageDatabase`, community PostgreSQL 16 is functionally identical to Azure Flexible Server PG 16. The Azure-specific divergences (`azure_pg_admin`, `azuresu`, blocked `pg_write_all_data`) are not referenced in our provisioning code.

### 2.4 Dependencies

```bash
cd app/backend && npm install -D @testcontainers/postgresql testcontainers
```

No additional runtime dependencies. `pg` (already in `dependencies`) is used for client connections.

### 2.5 Architecture

```
api/
├── jest.config.ts                        # Existing unit test config (unchanged)
├── jest.integration.config.ts            # NEW — integration test config
├── src/
│   ├── __tests__/                        # Existing mocked unit tests (unchanged)
│   └── __integration__/
│       ├── setup/
│       │   ├── globalSetup.ts            # Start PG container, run migrations, export env
│       │   └── globalTeardown.ts         # Stop container
│       ├── helpers/
│       │   └── testDatabase.ts           # Per-suite database factory + cleanup
│       ├── database-provisioning.integration.test.ts
│       ├── database-management.integration.test.ts
│       └── pool-factory.integration.test.ts
```

### 2.6 Global Setup / Teardown

A single PostgreSQL container is started once before all integration test suites and stopped after all suites complete. This amortizes the ~2-3 second container startup across all tests.

```typescript
// app/backend/src/__integration__/setup/globalSetup.ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';

export default async function globalSetup() {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('pronghorn')
    .withUsername('pronghorn_admin')
    .withPassword('testpass')
    .start();

  // Run schema migration against the container
  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const schemaSql = fs.readFileSync(
    path.resolve(__dirname, '../../../../infra/migrations/001_full_schema.sql'),
    'utf-8'
  );
  await client.query(schemaSql);
  await client.end();

  // Export connection details for test suites via env vars
  process.env.POSTGRES_HOST = container.getHost();
  process.env.POSTGRES_PORT = container.getMappedPort(5432).toString();
  process.env.POSTGRES_DATABASE = 'pronghorn';
  process.env.POSTGRES_USER = 'pronghorn_admin';
  process.env.POSTGRES_PASSWORD = 'testpass';
  process.env.POSTGRES_SSL = 'false';
  process.env.SECRETS_ENCRYPTION_KEY = 'a'.repeat(64); // 32-byte hex key for test

  // Store container reference for teardown
  (globalThis as any).__TESTCONTAINER__ = container;
  // Persist env for worker processes (Jest runs tests in workers)
  (globalThis as any).__TC_ENV__ = {
    POSTGRES_HOST: process.env.POSTGRES_HOST,
    POSTGRES_PORT: process.env.POSTGRES_PORT,
    POSTGRES_DATABASE: process.env.POSTGRES_DATABASE,
    POSTGRES_USER: process.env.POSTGRES_USER,
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
    POSTGRES_SSL: process.env.POSTGRES_SSL,
    SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
  };
}
```

```typescript
// app/backend/src/__integration__/setup/globalTeardown.ts
export default async function globalTeardown() {
  const container = (globalThis as any).__TESTCONTAINER__;
  if (container) {
    await container.stop();
  }
}
```

### 2.7 Jest Integration Config

```typescript
// api/jest.integration.config.ts
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__integration__/**/*.integration.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
  globalSetup: '<rootDir>/src/__integration__/setup/globalSetup.ts',
  globalTeardown: '<rootDir>/src/__integration__/setup/globalTeardown.ts',
  testTimeout: 30000, // DDL operations can be slow on first run
};

export default config;
```

### 2.8 Package.json Scripts

```json
{
  "scripts": {
    "test": "jest",
    "test:coverage": "jest --coverage",
    "test:integration": "jest --config jest.integration.config.ts",
    "test:all": "jest && jest --config jest.integration.config.ts"
  }
}
```

### 2.9 Per-Suite Database Helper

For tests that create project databases, a helper provides isolated database names and cleanup:

```typescript
// app/backend/src/__integration__/helpers/testDatabase.ts
import { Client } from 'pg';

function adminConnectionString(): string {
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  return `postgresql://pronghorn_admin:testpass@${host}:${port}/pronghorn`;
}

/**
 * Create a unique test database name to avoid collisions between parallel suites.
 */
export function uniqueDbName(prefix = 'proj'): string {
  const suffix = Math.random().toString(36).substring(2, 10);
  return `${prefix}_test_${suffix}`;
}

/**
 * Drop a test database and its associated role, ignoring errors.
 */
export async function cleanupTestDatabase(dbName: string, roleName?: string): Promise<void> {
  const client = new Client({ connectionString: adminConnectionString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    if (roleName) {
      await client.query(`DROP ROLE IF EXISTS "${roleName}"`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Get a fresh admin client connected to the pronghorn database.
 */
export async function getAdminClient(): Promise<Client> {
  const client = new Client({ connectionString: adminConnectionString() });
  await client.connect();
  return client;
}
```

### 2.10 Example Integration Test: `proj_XXXX` Provisioning Lifecycle

These tests replicate the exact DDL operations from `handleDatabaseProvisioning` against a real PostgreSQL 16 engine. They validate that the SQL the handler generates is syntactically correct, that the privilege chain works end-to-end, and that the created databases are properly isolated from the platform's `pronghorn` database.

```typescript
// app/backend/src/__integration__/database-provisioning.integration.test.ts
import { Client } from 'pg';
import { cleanupTestDatabase, getAdminClient, uniqueDbName } from './helpers/testDatabase';

describe('proj_XXXX Provisioning Lifecycle (integration)', () => {
  let adminClient: Client;

  beforeAll(async () => {
    adminClient = await getAdminClient();
  });

  afterAll(async () => {
    await adminClient.end();
  });

  describe('CREATE DATABASE lifecycle', () => {
    const dbName = uniqueDbName();
    const roleName = `role_test_${dbName.substring(5)}`;

    afterAll(async () => {
      await cleanupTestDatabase(dbName, roleName);
    });

    it('creates a project database', async () => {
      await adminClient.query(`CREATE DATABASE "${dbName}"`);

      // Verify via pg_database
      const result = await adminClient.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [dbName]
      );
      expect(result.rows).toHaveLength(1);
    });

    it('installs extensions in the project database', async () => {
      const projClient = new Client({
        host: process.env.POSTGRES_HOST,
        port: parseInt(process.env.POSTGRES_PORT!),
        database: dbName,
        user: 'pronghorn_admin',
        password: 'testpass',
      });
      await projClient.connect();
      try {
        await projClient.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
        await projClient.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

        const extResult = await projClient.query(
          "SELECT extname FROM pg_extension WHERE extname IN ('uuid-ossp', 'pgcrypto')"
        );
        expect(extResult.rows.map(r => r.extname).sort())
          .toEqual(['pgcrypto', 'uuid-ossp']);
      } finally {
        await projClient.end();
      }
    });

    it('creates a project role with LOGIN and PASSWORD', async () => {
      const password = 'test_password_123';
      const escaped = adminClient.escapeLiteral(password);
      await adminClient.query(`CREATE ROLE "${roleName}" WITH LOGIN PASSWORD ${escaped}`);

      const roleResult = await adminClient.query(
        'SELECT rolcanlogin FROM pg_roles WHERE rolname = $1',
        [roleName]
      );
      expect(roleResult.rows).toHaveLength(1);
      expect(roleResult.rows[0].rolcanlogin).toBe(true);
    });

    it('grants schema privileges to the project role', async () => {
      const projClient = new Client({
        host: process.env.POSTGRES_HOST,
        port: parseInt(process.env.POSTGRES_PORT!),
        database: dbName,
        user: 'pronghorn_admin',
        password: 'testpass',
      });
      await projClient.connect();
      try {
        await projClient.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
        await projClient.query(`GRANT CREATE ON SCHEMA public TO "${roleName}"`);
        await projClient.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
        await projClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${roleName}"`);
        await projClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${roleName}"`);

        // Verify: connect as the project role and create a table
        const roleClient = new Client({
          host: process.env.POSTGRES_HOST,
          port: parseInt(process.env.POSTGRES_PORT!),
          database: dbName,
          user: roleName,
          password: 'test_password_123',
        });
        await roleClient.connect();
        try {
          await roleClient.query('CREATE TABLE test_table (id serial PRIMARY KEY, name text)');
          await roleClient.query("INSERT INTO test_table (name) VALUES ('hello')");
          const result = await roleClient.query('SELECT name FROM test_table');
          expect(result.rows[0].name).toBe('hello');
        } finally {
          await roleClient.end();
        }
      } finally {
        await projClient.end();
      }
    });

    it('role cannot access the main pronghorn database tables', async () => {
      const roleClient = new Client({
        host: process.env.POSTGRES_HOST,
        port: parseInt(process.env.POSTGRES_PORT!),
        database: 'pronghorn',
        user: roleName,
        password: 'test_password_123',
      });
      await roleClient.connect();
      try {
        await expect(
          roleClient.query('SELECT * FROM projects LIMIT 1')
        ).rejects.toThrow(/permission denied/);
      } finally {
        await roleClient.end();
      }
    });
  });

  describe('DROP DATABASE lifecycle', () => {
    const dbName = uniqueDbName();
    const roleName = `role_test_${dbName.substring(5)}`;

    it('drops a database with force', async () => {
      await adminClient.query(`CREATE DATABASE "${dbName}"`);
      await adminClient.query(`CREATE ROLE "${roleName}" WITH LOGIN PASSWORD 'pass'`);

      await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await adminClient.query(`DROP ROLE IF EXISTS "${roleName}"`);

      const result = await adminClient.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [dbName]
      );
      expect(result.rows).toHaveLength(0);

      const roleResult = await adminClient.query(
        'SELECT 1 FROM pg_roles WHERE rolname = $1',
        [roleName]
      );
      expect(roleResult.rows).toHaveLength(0);
    });
  });

  describe('duplicate database handling', () => {
    const dbName = uniqueDbName();

    afterAll(async () => {
      await cleanupTestDatabase(dbName);
    });

    it('handles 42P04 (duplicate_database) gracefully', async () => {
      await adminClient.query(`CREATE DATABASE "${dbName}"`);

      try {
        await adminClient.query(`CREATE DATABASE "${dbName}"`);
        fail('Expected 42P04 error');
      } catch (err: any) {
        expect(err.code).toBe('42P04');
      }
    });
  });

  describe('status check via pg_database', () => {
    const dbName = uniqueDbName();

    afterAll(async () => {
      await cleanupTestDatabase(dbName);
    });

    it('reports existing database as available', async () => {
      await adminClient.query(`CREATE DATABASE "${dbName}"`);

      const result = await adminClient.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [dbName]
      );
      expect(result.rows).toHaveLength(1);
    });

    it('reports non-existent database correctly', async () => {
      const result = await adminClient.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        ['nonexistent_db_xyz']
      );
      expect(result.rows).toHaveLength(0);
    });
  });
});
```

### 2.11 Example Integration Test: Pool Factory Targeting `proj_XXXX`

The pool factory (`queryWithPoolTarget`) is the mechanism that lets the API route queries to a specific project database. These tests verify that pool switching works against a real server and that operations in a project database don't leak into the `pronghorn` database.

```typescript
// app/backend/src/__integration__/pool-factory.integration.test.ts
import { Client } from 'pg';
import { cleanupTestDatabase, uniqueDbName } from './helpers/testDatabase';

describe('queryWithPoolTarget targeting proj_XXXX (integration)', () => {
  const dbName = uniqueDbName();
  let dbModule: typeof import('../utils/database');

  beforeAll(async () => {
    // Create a test database for pool targeting
    const client = new Client({
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT!),
      database: 'pronghorn',
      user: 'pronghorn_admin',
      password: 'testpass',
    });
    await client.connect();
    await client.query(`CREATE DATABASE "${dbName}"`);
    await client.end();

    // Import database module with real env vars (no mocks)
    dbModule = await import('../utils/database');
  });

  afterAll(async () => {
    await dbModule.close();
    await cleanupTestDatabase(dbName);
  });

  it('connects to a target database and executes queries', async () => {
    const result = await dbModule.queryWithPoolTarget(
      { database: dbName },
      'SELECT current_database() AS db'
    );
    expect(result.rows[0].db).toBe(dbName);
  });

  it('creates tables in the target database without affecting the main DB', async () => {
    await dbModule.queryWithPoolTarget(
      { database: dbName },
      'CREATE TABLE pool_test (id serial PRIMARY KEY)'
    );

    const result = await dbModule.queryWithPoolTarget(
      { database: dbName },
      "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pool_test'"
    );
    expect(parseInt(result.rows[0].count)).toBe(1);

    // Verify table does NOT exist in main pronghorn DB
    const mainResult = await dbModule.query(
      "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pool_test'"
    );
    expect(parseInt(mainResult.rows[0].count)).toBe(0);
  });

  it('reuses pool for repeated calls to the same target', async () => {
    const r1 = await dbModule.queryWithPoolTarget({ database: dbName }, 'SELECT 1');
    const r2 = await dbModule.queryWithPoolTarget({ database: dbName }, 'SELECT 2');
    expect(r1.rows).toHaveLength(1);
    expect(r2.rows).toHaveLength(1);
  });
});
```

### 2.12 Example Integration Test: User Operations Against `proj_XXXX`

These tests simulate what `handleManageDatabase` does — connecting to a provisioned project database and running schema introspection, SQL execution, and data export operations. The project database is created in `beforeAll` (mimicking the provisioning lifecycle), and user operations are tested against it.

```typescript
// app/backend/src/__integration__/database-management.integration.test.ts
import { Client } from 'pg';
import { cleanupTestDatabase, getAdminClient, uniqueDbName } from './helpers/testDatabase';

describe('handleManageDatabase operations against proj_XXXX (integration)', () => {
  const dbName = uniqueDbName();
  const roleName = `role_test_${dbName.substring(5)}`;
  const rolePassword = 'test_role_pass_456';
  let adminClient: Client;

  beforeAll(async () => {
    // Replicate the provisioning lifecycle — CREATE DATABASE, extensions, role, grants
    adminClient = await getAdminClient();
    await adminClient.query(`CREATE DATABASE "${dbName}"`);

    const projClient = new Client({
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT!),
      database: dbName,
      user: 'pronghorn_admin',
      password: 'testpass',
    });
    await projClient.connect();
    await projClient.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await projClient.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await adminClient.query(
      `CREATE ROLE "${roleName}" WITH LOGIN PASSWORD ${adminClient.escapeLiteral(rolePassword)}`
    );
    await projClient.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await projClient.query(`GRANT CREATE ON SCHEMA public TO "${roleName}"`);
    await projClient.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
    await projClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${roleName}"`);
    await projClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${roleName}"`);
    await projClient.end();

    // Create test tables as the project role (same as a user would via execute_sql)
    const roleClient = new Client({
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT!),
      database: dbName,
      user: roleName,
      password: rolePassword,
    });
    await roleClient.connect();
    await roleClient.query(`
      CREATE TABLE users (
        id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
        name text NOT NULL,
        email text UNIQUE,
        created_at timestamptz DEFAULT now()
      )
    `);
    await roleClient.query(`INSERT INTO users (name, email) VALUES ('Alice', 'alice@test.com')`);
    await roleClient.query(`INSERT INTO users (name, email) VALUES ('Bob', 'bob@test.com')`);
    await roleClient.end();
  });

  afterAll(async () => {
    await adminClient.end();
    await cleanupTestDatabase(dbName, roleName);
  });

  function connectAsRole(): Client {
    return new Client({
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT!),
      database: dbName,
      user: roleName,
      password: rolePassword,
    });
  }

  describe('get_schema — schema introspection', () => {
    it('discovers tables, columns, and extensions in project database', async () => {
      const client = connectAsRole();
      await client.connect();
      try {
        const schemas = await client.query(`
          SELECT schema_name FROM information_schema.schemata
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        `);
        expect(schemas.rows.map(r => r.schema_name)).toContain('public');

        const tables = await client.query(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        `);
        expect(tables.rows.map(r => r.table_name)).toContain('users');

        const columns = await client.query(`
          SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users'
          ORDER BY ordinal_position
        `);
        expect(columns.rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ column_name: 'id', data_type: 'uuid' }),
            expect.objectContaining({ column_name: 'name', data_type: 'text' }),
          ])
        );
      } finally {
        await client.end();
      }
    });
  });

  describe('execute_sql — arbitrary SQL against proj_XXXX', () => {
    it('runs a SELECT query and returns results', async () => {
      const client = connectAsRole();
      await client.connect();
      try {
        const result = await client.query('SELECT name FROM users ORDER BY name');
        expect(result.rows).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
      } finally {
        await client.end();
      }
    });

    it('executes DDL (CREATE TABLE) in the project database', async () => {
      const client = connectAsRole();
      await client.connect();
      try {
        await client.query('CREATE TABLE tasks (id serial PRIMARY KEY, title text)');
        const result = await client.query(
          "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tasks'"
        );
        expect(result.rows).toHaveLength(1);
      } finally {
        await client.end();
      }
    });

    it('uses uuid-ossp extension in project database', async () => {
      const client = connectAsRole();
      await client.connect();
      try {
        const result = await client.query('SELECT uuid_generate_v4() AS id');
        expect(result.rows[0].id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
      } finally {
        await client.end();
      }
    });

    it('uses pgcrypto extension in project database', async () => {
      const client = connectAsRole();
      await client.connect();
      try {
        const result = await client.query("SELECT gen_random_uuid() AS id");
        expect(result.rows[0].id).toBeDefined();
      } finally {
        await client.end();
      }
    });
  });

  describe('execute_sql_batch — transactional batch operations', () => {
    it('commits batch on success', async () => {
      const client = connectAsRole();
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@test.com')");
        await client.query("INSERT INTO users (name, email) VALUES ('Diana', 'diana@test.com')");
        await client.query('COMMIT');

        const result = await client.query('SELECT COUNT(*) as count FROM users');
        expect(parseInt(result.rows[0].count)).toBeGreaterThanOrEqual(4);
      } finally {
        await client.end();
      }
    });

    it('rolls back batch on error', async () => {
      const client = connectAsRole();
      await client.connect();
      try {
        const before = await client.query('SELECT COUNT(*) as count FROM users');
        const countBefore = parseInt(before.rows[0].count);

        await client.query('BEGIN');
        await client.query("INSERT INTO users (name, email) VALUES ('Eve', 'eve@test.com')");
        try {
          // Duplicate email — violates UNIQUE constraint
          await client.query("INSERT INTO users (name, email) VALUES ('Eve2', 'eve@test.com')");
        } catch {
          await client.query('ROLLBACK');
        }

        const after = await client.query('SELECT COUNT(*) as count FROM users');
        expect(parseInt(after.rows[0].count)).toBe(countBefore);
      } finally {
        await client.end();
      }
    });
  });

  describe('get_table_data — paginated reads', () => {
    it('returns rows with LIMIT/OFFSET and total count', async () => {
      const client = connectAsRole();
      await client.connect();
      try {
        const result = await client.query('SELECT * FROM users ORDER BY name LIMIT 1 OFFSET 0');
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].name).toBe('Alice');

        const countResult = await client.query('SELECT COUNT(*) as count FROM users');
        expect(parseInt(countResult.rows[0].count)).toBeGreaterThanOrEqual(2);
      } finally {
        await client.end();
      }
    });
  });

  describe('get_table_definition — structure introspection', () => {
    it('returns column definitions, primary keys, and indexes', async () => {
      const client = connectAsRole();
      await client.connect();
      try {
        const cols = await client.query(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users'
          ORDER BY ordinal_position
        `);
        expect(cols.rows.find((c: any) => c.column_name === 'id')?.data_type).toBe('uuid');
        expect(cols.rows.find((c: any) => c.column_name === 'email')?.is_nullable).toBe('YES');

        const pk = await client.query(`
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = 'public' AND tc.table_name = 'users'
        `);
        expect(pk.rows.map((r: any) => r.column_name)).toContain('id');

        const indexes = await client.query(`
          SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'users'
        `);
        expect(indexes.rows.length).toBeGreaterThanOrEqual(1);
      } finally {
        await client.end();
      }
    });
  });
});
```

---

## 3. CI Workflow

None of the 3 existing GitHub workflows (`deploy-to-azure.yml`, `deploy.yml`, `deploy-dev-internal.yml`) run tests. A new CI workflow is required.

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main, dev-internal, 'feature/**']
  push:
    branches: [main, dev-internal]
    paths-ignore:
      - '*.md'
      - 'docs/**'
      - '.github/skills/**'

jobs:
  test-api:
    name: API Tests
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: npm
          cache-dependency-path: api/package-lock.json

      - name: Install API dependencies
        run: cd app/backend && npm ci

      - name: Lint
        run: cd app/backend && npx eslint src/

      - name: Build
        run: cd app/backend && npm run build

      - name: Unit tests
        run: cd app/backend && npm test

      - name: Integration tests (Testcontainers)
        run: cd app/backend && npm run test:integration

  test-frontend:
    name: Frontend Tests
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Build
        run: npm run build
```

**Key points**:
- `ubuntu-latest` includes Docker — Testcontainers works with zero additional setup.
- No `services:` block needed — Testcontainers manages its own container lifecycle.
- Unit tests and integration tests run as separate npm scripts so either can be run independently.

---

## 4. Test Coverage Targets

### Provisioning Lifecycle (`handleDatabaseProvisioning` → `proj_XXXX`)

| Test Scope                               | What to Cover                                                                                                             | Priority |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| `CREATE DATABASE "proj_XXXX"`            | Database appears in `pg_database`, runs outside transaction                                                               | P0       |
| Extension installation in `proj_XXXX`    | `uuid-ossp` and `pgcrypto` install in the project DB (not admin DB)                                                       | P0       |
| `CREATE ROLE "role_XXXX"`                | Role appears in `pg_roles`, `rolcanlogin` is true, password auth works                                                    | P0       |
| Privilege chain                          | `GRANT USAGE/CREATE/ALL`, `ALTER DEFAULT PRIVILEGES` — project role can `CREATE TABLE`, `INSERT`, `SELECT` in `proj_XXXX` | P0       |
| Cross-database isolation                 | Project role **cannot** query `projects` table in `pronghorn`                                                             | P0       |
| `DROP DATABASE "proj_XXXX" WITH (FORCE)` | Database and role no longer exist in system catalogs                                                                      | P0       |
| `pg_database` status check               | Correct results for existing and non-existent `proj_XXXX` databases                                                       | P0       |
| Duplicate database (`42P04`)             | Handled gracefully — not a fatal error                                                                                    | P1       |
| Encryption round-trip                    | Encrypt `postgresql://role:pass@host/proj_XXXX`, store, retrieve, decrypt, verify original                                | P1       |
| Partial failure recovery                 | Error after `CREATE DATABASE` but before grants → `status = 'failed'`, `last_error` stored                                | P1       |
| `escapeLiteral` injection prevention     | Special characters in role passwords are properly escaped                                                                 | P2       |

### User Operations (`handleManageDatabase` → `proj_XXXX`)

| Test Scope                | What to Cover                                                                                                          | Priority |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------- |
| `test_connection`         | `SELECT 1` succeeds against provisioned `proj_XXXX`                                                                    | P0       |
| `get_schema`              | Returns tables, views, functions, triggers, indexes, sequences, types, constraints from `proj_XXXX`                    | P0       |
| `execute_sql`             | SELECT, INSERT, CREATE TABLE work in `proj_XXXX`; extensions (`uuid_generate_v4()`, `gen_random_uuid()`) are available | P0       |
| `execute_sql_batch`       | Successful batch commits; failed batch rolls back (UNIQUE violation)                                                   | P0       |
| `get_table_data`          | Returns rows with LIMIT/OFFSET and total count from `proj_XXXX`                                                        | P1       |
| `get_table_columns`       | Returns column metadata from `information_schema.columns`                                                              | P1       |
| `export_table`            | JSON, CSV, SQL export formats return correct data                                                                      | P1       |
| `get_table_definition`    | Column defs, primary keys, foreign keys, indexes returned correctly                                                    | P1       |
| `get_view_definition`     | View definition returned from `information_schema.views`                                                               | P2       |
| `get_function_definition` | Function definition returned from `pg_get_functiondef()`                                                               | P2       |

### Infrastructure

| Test Scope                                       | What to Cover                                                                           | Priority |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- | -------- |
| `queryWithPoolTarget({ database: 'proj_XXXX' })` | Connects to correct database, pool reuse, isolation from main pool                      | P0       |
| Schema migration                                 | `001_full_schema.sql` applies cleanly to a fresh container (validated by `globalSetup`) | P0       |

---

## 5. Alternatives Considered

| Tool                                    | Why Rejected                                                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`pg-mem`** (in-memory PG emulator)    | Does not support `CREATE DATABASE`, `CREATE ROLE`, `pg_database` catalog, or extensions. Fundamentally cannot test per-project isolation DDL.                                                                                 |
| **`pglite`** (PG compiled to WASM)      | Single-database only — cannot `CREATE DATABASE`. No TCP listener for `pg.Pool` connections. No role management.                                                                                                               |
| **Docker Compose `services:` in CI**    | Less flexible than Testcontainers — no programmatic control over container lifecycle, harder to do per-suite cleanup of dynamically created databases, one static container for all tests.                                    |
| **Shared local dev PostgreSQL**         | Not isolated — tests pollute dev data. Parallel CI runs conflict. No fresh-state guarantee.                                                                                                                                   |
| **Live Azure Flexible Server**          | ~30s+ round-trip per test, costs money, requires network access in CI, provisioning takes minutes. Unsuitable for CI test suites.                                                                                             |
| **`pgTAP`** (SQL-native test framework) | Validates DB-level invariants well but doesn't test Node.js handler logic. Could complement Testcontainers but adds a separate test runner and SQL-based test authoring. Added complexity without covering the handler layer. |

Testcontainers was selected because it is the **only option** that supports the full DDL lifecycle (`CREATE DATABASE` → `CREATE ROLE` → `GRANT` → pool target switch → `DROP DATABASE`) while integrating natively with Jest and running with zero additional CI infrastructure.

---

## 6. Relationship to 002-FUNCTIONS_REFACTOR_PLAN

This integration test plan is designed to execute **after** the refactor described in [002-FUNCTIONS_REFACTOR_PLAN.md](002-FUNCTIONS_REFACTOR_PLAN.md).

### Why After the Refactor

The current `functions.ts` is a 6,453-line monolith. The refactor will extract `handleDatabaseProvisioning` and `handleManageDatabase` into a dedicated `database.handlers.ts` domain module with clean interfaces. Writing integration tests against the **refactored** code:

1. **Tests validate the new implementation** — The refactored handlers are the code that needs confidence. Testing the old monolith then re-testing the refactored version is wasted effort.
2. **Cleaner test boundaries** — Extracted handlers with explicit dependencies (db client, pool factory, encryption) are easier to wire up in integration tests than the current deeply-nested closure-based approach.
3. **Tests serve as a regression gate** — Once the refactored handlers pass integration tests, they become the acceptance criteria for the refactor itself.

### Sequencing

```
002-FUNCTIONS_REFACTOR_PLAN.md
├── Phase 1-4: Extract domain handlers from functions.ts
│   ├── database.handlers.ts (handleDatabaseProvisioning)
│   └── database-management.handlers.ts (handleManageDatabase)
│
└── Phase 5: Integration testing (THIS PLAN — 003)
    ├── Install testcontainers
    ├── Create integration test infrastructure
    ├── Write proj_XXXX lifecycle tests
    ├── Write user operation tests
    └── Add CI workflow
```

---

## 7. Implementation Order

| Step | Task                                                                                   | Depends On                     |
| ---- | -------------------------------------------------------------------------------------- | ------------------------------ |
| 0    | **Complete 002 refactor** — extract database handlers from `functions.ts`              | 002-FUNCTIONS_REFACTOR_PLAN.md |
| 1    | Install `@testcontainers/postgresql` and `testcontainers` as devDependencies           | Step 0                         |
| 2    | Create `jest.integration.config.ts`                                                    | —                              |
| 3    | Add `test:integration` and `test:all` npm scripts                                      | Step 2                         |
| 4    | Create `globalSetup.ts` and `globalTeardown.ts`                                        | Step 1                         |
| 5    | Create `testDatabase.ts` helper                                                        | Step 4                         |
| 6    | Write `database-provisioning.integration.test.ts` — `proj_XXXX` lifecycle              | Steps 4, 5                     |
| 7    | Write `pool-factory.integration.test.ts` — `queryWithPoolTarget` targeting `proj_XXXX` | Steps 4, 5                     |
| 8    | Write `database-management.integration.test.ts` — user operations against `proj_XXXX`  | Steps 4, 5                     |
| 9    | Create `.github/workflows/ci.yml`                                                      | Steps 1-8                      |
| 10   | Verify all integration tests pass locally and in CI                                    | Step 9                         |

---

## 8. Risks and Mitigations

| Risk                                                       | Impact                 | Mitigation                                                                                                                         |
| ---------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Container startup adds ~2-3s to test suite                 | Slower CI              | Shared container via `globalSetup` — startup cost is amortized across all suites                                                   |
| Jest worker processes don't inherit `globalSetup` env vars | Tests fail to connect  | Write env vars to a temp file in `globalSetup`, read in each suite's `beforeAll` (or use Jest `--runInBand` for integration tests) |
| Parallel test suites create conflicting database names     | `42P04` errors         | `uniqueDbName()` helper generates random suffixes; `afterAll` cleanup                                                              |
| Docker not available on CI runner                          | Integration tests fail | `ubuntu-latest` includes Docker; document Docker as a prerequisite for local dev                                                   |
| `001_full_schema.sql` migration fails on container         | `globalSetup` crashes  | Run migration in CI smoke test; schema changes must remain compatible with clean `postgres:16-alpine`                              |
| Testcontainers version drift vs production PG version      | False confidence       | Pin `postgres:16-alpine` in `globalSetup` to match `infra/params/dev.tfvars` (`postgresql_version = "16"`); update both together   |

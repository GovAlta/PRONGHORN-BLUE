---
name: 03.run-local-schema-migration
description: This skill will guide you through running the PostgreSQL schema migration for Pronghorn development.
argument-hint: "Please follow the instructions to apply the schema migration to your PostgreSQL database."
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Run PostgreSQL Schema Migration for Pronghorn

This skill will guide you through the process of applying the Pronghorn database schema migration to your PostgreSQL instance using Docker.

## When to use this skill
- When you need to initialize a fresh PostgreSQL database with the Pronghorn schema.
- After setting up a new PostgreSQL container via the PostgreSQL setup skill.
- When resetting your development database to a known state.
- When migrating from an older version of the schema.

## Pre-requisites
- PostgreSQL Docker container named `pronghorn-db` is running and accepting connections.
- You can verify this with: `docker exec pronghorn-db pg_isready -U pronghorn_admin -d pronghorn`
- Expected output: `/var/run/postgresql:5432 - accepting connections`

## Running the Schema Migration with Docker PostgreSQL

The full database schema is defined in `infra/migrations/001_full_schema.sql`. This creates all tables, functions, RPC handlers, Row Level Security (RLS) policies, and triggers.

### Executing the Migration

Run the following command from the repository root:

```powershell
Get-Content "infra/migrations/001_full_schema.sql" | docker exec -i pronghorn-db psql -U pronghorn_admin -d pronghorn
```

This command:
- Connects to the `pronghorn-db` Docker container via `docker exec`
- Uses `psql` to execute SQL commands
- Authenticates as `pronghorn_admin` user
- Targets the `pronghorn` database
- Reads and executes the schema file from `infra/migrations/001_full_schema.sql`

### Verifying the Migration

After the migration completes, verify that all tables were created:

```powershell
docker exec pronghorn-db psql -U pronghorn_admin -d pronghorn -c "\dt" | head -20
```

This displays the first 20 tables. You should see tables like:
- `projects`
- `artifacts`
- `requirements`
- `standards`
- `deployments`
- `ai_agents`
- `users`
- And many others (62 tables in the `public` schema)

### Full Table Count

To confirm all 62 public-schema tables were created:

```powershell
docker exec pronghorn-db psql -U pronghorn_admin -d pronghorn -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
```

Expected output: `62` (this counts only `public` schema tables; the migration also creates tables in `auth`, `storage`, `_realtime`, and `cron` schemas)

## Troubleshooting

### "Did not find any relations"?

If `\dt` returns "Did not find any relations", the migration hasn't been applied. This commonly happens when:
- You restarted an existing Docker container with `docker start` instead of `docker run`
- Docker's `docker-entrypoint-initdb.d` init scripts didn't run
- The database volume was lost

**Solution:** Re-run the migration command above. The schema will be applied to the empty database.

### "role 'pronghorn_admin' does not exist"

The database user was not created. Run the PostgreSQL setup skill first to create the user and database.

### "database 'pronghorn' does not exist"

The database was not created. Run the PostgreSQL setup skill first.

### "Permission denied" or "FATAL: password authentication failed"

Verify the correct credentials:
- User: `pronghorn_admin`
- Database: `pronghorn`
- Ensure the password matches what was set during PostgreSQL setup

## Schema Contents

The migration creates:
- **62 public-schema tables** (plus additional tables in `auth`, `storage`, `_realtime`, and `cron` schemas) with primary keys, foreign keys, and indexes
- **RLS (Row Level Security) policies** for data access control
- **PostgreSQL extensions**: `uuid-ossp` (UUID generation), `pgcrypto` (cryptographic functions)
- **Stored procedures and functions** for application business logic
- **Triggers** for automated data consistency

This ensures your local database matches the production schema exactly.

## Next Steps

After successful schema migration:
1. Verify the API can connect to the database
2. Proceed to [4. Set Up the API](../../../LOCAL_DEVELOPMENT.md#4-set-up-the-api) in the Local Development Guide
3. Begin building/testing Pronghorn features

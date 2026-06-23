-- 010_make_secret_columns_nullable.sql
-- Expand/contract step 1 of 2 (NON-DESTRUCTIVE).
--
-- Per-generated-app Key Vaults are now the single source of truth for env vars,
-- user secrets, and database connection strings. The backend no longer writes
-- these values into Postgres:
--   * project_database_connections INSERTs omit `connection_string`.
--   * project_deployments no longer writes `env_vars` / `secrets`.
--
-- project_database_connections.connection_string is currently NOT NULL (see
-- 001_full_schema.sql). If the new backend ships before the column is made
-- nullable, every INSERT that omits connection_string fails with a NOT NULL
-- violation. This migration removes that constraint so the new code is safe to
-- run while the (now-unused) columns still physically exist.
--
-- This is the EXPAND step: apply it WITH (or before) the backend deploy.
-- The destructive DROP of these columns is the CONTRACT step in
-- 011_drop_plaintext_secret_columns.sql, applied only after the new backend is
-- fully rolled out and verified.

BEGIN;

-- Allow connection strings to be omitted now that they live in Key Vault.
ALTER TABLE public.project_database_connections
    ALTER COLUMN connection_string DROP NOT NULL;

COMMIT;

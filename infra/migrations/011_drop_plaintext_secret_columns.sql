-- 011_drop_plaintext_secret_columns.sql
-- Expand/contract step 2 of 2 (DESTRUCTIVE — apply only after the new backend
-- is fully rolled out and verified).
--
-- Remove plaintext secret storage now that per-generated-app Key Vaults are the
-- single source of truth.
--
-- Prerequisites (verified before applying):
--   * Migration 009 added project_deployments.azure_key_vault_name / _uri and
--     the backend now provisions a per-deployment vault on create/deploy.
--   * Migration 010 dropped the NOT NULL constraint on
--     project_database_connections.connection_string (expand step) so the new
--     backend could run safely while these columns still existed.
--   * The backend reads/writes ALL env vars and user secrets via the vault
--     (services/deployment/docker/genappKeyVault.ts) — see envVars.ts, rpc.ts
--     (update_deployment_with_token), and rpcHelpers.ts.
--   * Database connection strings are stored in the per-project vault; every
--     INSERT into project_database_connections now omits connection_string and
--     all reads go through getConnectionStringSecret().
--
-- IRREVERSIBLE: this DROPs columns that previously held secret material. Once
-- applied, the values exist only in Key Vault. Take a backup beforehand.

BEGIN;

-- Deployment-scoped env vars and user secrets -> per-deployment Key Vault.
ALTER TABLE public.project_deployments
    DROP COLUMN IF EXISTS env_vars,
    DROP COLUMN IF EXISTS secrets;

-- Per-database connection string -> per-project Key Vault.
ALTER TABLE public.project_database_connections
    DROP COLUMN IF EXISTS connection_string;

COMMIT;

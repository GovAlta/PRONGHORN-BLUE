-- 009_genapp_keyvault_columns.sql
-- Per-generated-app Key Vault support.
--
-- Each user-generated app owns a dedicated Azure Key Vault that becomes the
-- single source of truth for its environment variables, user secrets, and
-- database connection string. This migration is ADDITIVE: it records the
-- vault name/uri the backend provisions for each deployment. The removal of
-- the now-superseded value columns (project_deployments.env_vars,
-- project_deployments.secrets, project_database_connections.connection_string)
-- is performed by a later, separate migration once the backend cutover to
-- Key Vault is verified end-to-end.

ALTER TABLE public.project_deployments
    ADD COLUMN IF NOT EXISTS azure_key_vault_name text,
    ADD COLUMN IF NOT EXISTS azure_key_vault_uri  text;

COMMENT ON COLUMN public.project_deployments.azure_key_vault_name IS
    'Name of the per-app Azure Key Vault (deterministic: kv-ga-<first 18 hex of app id>). Backend-provisioned; consumed by the generated-app Terraform.';
COMMENT ON COLUMN public.project_deployments.azure_key_vault_uri IS
    'Data-plane URI of the per-app Azure Key Vault (https://<name>.vault.azure.net). Single source of truth for env vars, user secrets, and the DB connection string.';

# =============================================================================
# PBMM Landing Zone Environment Variables (Template)
# =============================================================================
# This file provides the PBMM-compliant configuration for deploying Pronghorn
# into a Government of Canada Protected B, Medium Integrity, Medium Availability
# (PBMM) Azure Landing Zone.
#
# INSTRUCTIONS FOR CUSTOMERS:
#   1. Copy this file to params/<environment>.tfvars (e.g. params/prod.tfvars)
#   2. Replace all placeholder values marked with "REPLACE:" comments
#   3. Do NOT add secrets here. Generated secrets (DB passwords, JWT) are seeded
#      into the platform Key Vault by Terraform; the GitHub App identity is set
#      out-of-band in Key Vault. The tfstate backend identifiers live in the
#      committed params/<environment>.backend.hcl.
#   4. Environment-specific values (subscription, subnet/DNS IDs, URL overrides)
#      are injected from GitHub Environment Variables as TF_VAR_*, not set here.
#      See docs/PBMM_DEPLOYMENT.md §6.0 for the required variable list.
#
# Usage:
#   terraform plan  -var-file="params/dev.tfvars"
#   terraform apply -var-file="params/dev.tfvars"
# =============================================================================

# ── Azure Configuration ──────────────────────────────────────────────────────

resource_group_name = "goa-cc-pronghorn_dev-rg"
location            = "canadacentral"
project_name        = "pronghorn"
environment         = "dev"
archetype           = "corp" # corp = PBMM landing zone with VNet/PE/private networking

# ── Central Private DNS (PBMM / vWAN hub) ────────────────────────────────────
# PBMM landing zones attach private DNS zone groups out-of-band via Azure Policy
# (DeployIfNotExists). The deploying identity has NO access to the central DNS
# subscription, so Terraform must not look up or wire any private DNS zones.
# This toggle skips all central zone lookups and passes empty zone IDs to every
# private endpoint; policy owns DNS resolution end-to-end.
delegate_private_dns_to_policy = false

# Leave central DNS settings empty when delegate_private_dns_to_policy = true.
# (Populate these only for non-policy environments where Terraform resolves
# zone IDs from the central DNS subscription.)

# Wait for Azure Policy to attach DNS zone groups to private endpoints
private_endpoint_dns_wait = {
  enabled  = true
  timeout  = "25m"
  interval = "10s"
}

# DNS registration wait (minutes) for central DNS propagation
dns_registration_wait_minutes = 20

# ── PostgreSQL Configuration ─────────────────────────────────────────────────
postgresql_server_name   = "goa-cc-prongblue-dev-pbmm-psql"
postgresql_database_name = "pronghorn"
administrator_login      = "gaea"
# Password: generated write-only secret seeded into Key Vault (postgres-password).
# No -var injection; set `administrator_password` only for break-glass override.
postgresql_version    = "16"
postgresql_sku_name   = "GP_Standard_D4s_v3" # Production: General Purpose (4 vCore)
postgresql_storage_mb = 131072               # 128 GB

# PostgreSQL VNet injection (server deployed inside delegated subnet)
# REPLACE: with your private DNS zone for PostgreSQL
# private_dns_zone_id is resolved automatically via central_dns when central_dns_subscription_id is set

# Alternatively, use Private Endpoint mode (uncomment and set):
# postgresql_private_endpoint_subnet_id = "REPLACE: /subscriptions/.../subnets/private-endpoints"

# ── Security Settings ────────────────────────────────────────────────────────
enable_development_access = false # NEVER enable in production
# HA temporarily disabled for the app DB: zone-redundant standby provisioning was
# intermittently failing during first create (Azure masks the cause behind a
# ServerDropping auto-rollback). Bring the server up single-zone first, then
# re-enable HA on the live server in a follow-up apply. standby_availability_zone
# is retained so re-enabling is a one-line change.
enable_high_availability         = false # was: true (Zone-redundant HA) — see note above
postgresql_disable_public_access = true  # PBMM: public access disabled (uses VNet/PE)
availability_zone                = "1"   # Primary in zone 1
standby_availability_zone        = "2"   # Standby must differ from primary for ZoneRedundant HA

# ── PostgreSQL Generated Applications Server ─────────────────────────────────
postgresql_genapps_server_name         = "goa-cc-prongblue-dev-genapps-psql"
postgresql_genapps_database_name       = "genapps_default"
postgresql_genapps_administrator_login = "gaea"
# Password: generated write-only secret seeded into Key Vault (postgres-genapps-password).
# No -var injection; set `postgresql_genapps_administrator_password` only for break-glass.
postgresql_genapps_version                      = "16"
postgresql_genapps_sku_name                     = "GP_Standard_D4s_v3" # Production: General Purpose (4 vCore)
postgresql_genapps_storage_mb                   = 131072               # 128 GB
postgresql_genapps_disable_public_access        = true                 # PBMM: public access disabled (uses VNet/PE)
postgresql_genapps_availability_zone            = "1"                  # Zone 1 (portable across all Canadian regions)
postgresql_genapps_enable_high_availability     = true                 # Zone-redundant HA for production
postgresql_genapps_backup_retention_days        = 35                   # Maximum retention for production
postgresql_genapps_geo_redundant_backup_enabled = true                 # Geo-redundant backup for DR
postgresql_genapps_maintenance_day              = 3                    # Wednesday — stagger from app server (Sunday)
postgresql_genapps_maintenance_hour             = 4                    # 04:00 UTC — stagger from app server (02:00 UTC)
# Alternatively, use Private Endpoint mode (uncomment and set):
# postgresql_genapps_private_endpoint_subnet_id = "REPLACE: /subscriptions/.../subnets/private-endpoints"

# Backup
backup_retention_days        = 35   # Maximum retention for production
geo_redundant_backup_enabled = true # Geo-redundant backup for DR

# Key Vault
keyvault_sku                        = "premium" # PBMM: Premium for HSM-backed keys
keyvault_soft_delete_retention_days = 90        # PBMM: maximum retention
keyvault_purge_protection_enabled   = true      # PBMM: purge protection required
keyvault_public_network_access      = false     # PBMM: private access only
keyvault_network_default_action     = "Deny"    # PBMM: deny by default
# Per-generated-app Key Vaults (created at runtime by the backend) are reached
# via private endpoints in PBMM, so public access stays disabled and no
# SecurityControl=Ignore policy-exemption tag is applied.
genapp_keyvault_public_network_access = "Disabled"

# Storage
storage_account_tier              = "Standard" # Standard for most workloads
storage_replication_type          = "GRS"      # PBMM: Geo-redundant for DR
storage_cors_max_age              = 3600
storage_public_network_access     = false # PBMM: private access only
storage_shared_access_key_enabled = false # PBMM: RBAC-only access

# ── API Container App Environment Variables ──────────────────────────────────
# Static env vars for the API container app. Infrastructure-derived values
# (POSTGRES_HOST, ACR_LOGIN_SERVER, etc.) are computed automatically by Terraform.
api_extra_env_vars = {
  # Runtime mode for the API container.
  NODE_ENV = "production"

  # API listener port inside the container.
  PORT = "8080"

  # PostgreSQL connectivity settings that are NOT inferred from Terraform resources.
  POSTGRES_PORT         = "5432"
  POSTGRES_SSL          = "true"
  POSTGRES_GENAPPS_PORT = "5432"
  POSTGRES_GENAPPS_SSL  = "true"
}

# ── GitHub + Workflow Routing (Single Source) ───────────────────────────────
# Organization where customer repositories are created and managed.
github_org = "phb-msft-dev"

# Owner of the platform repository that hosts genapp-deploy.yml.
genapp_workflow_owner = "phb-msft-dev"

# Repository that hosts genapp-deploy.yml.
genapp_workflow_repository = "pronghorn"

# Branch/ref used when dispatching genapp-deploy.yml.
genapp_workflow_ref = "dev"

# Workflow file dispatched by the backend for generated app operations.
genapp_workflow_file = "genapp-deploy.yml"

# ── GitHub Integration ────────────────────────────────────────────
# GitHub App identity (App ID, Installation ID, and private key) is managed in
# the platform Key Vault, NOT in tfvars. Terraform dummy-seeds the secrets
# github-app-id, github-app-installation-id, and github-app-private-key; an
# operator sets the real values out-of-band:
#   az keyvault secret set --vault-name <platform-kv> --name github-app-id --value <id>
#   az keyvault secret set --vault-name <platform-kv> --name github-app-installation-id --value <id>
#   az keyvault secret set --vault-name <platform-kv> --name github-app-private-key --file app.pem

# ── Database Migrations ──────────────────────────────────────────────────────────
run_migrations_on_startup = true # Auto-apply schema migrations on API container startup

# ── Container Apps ────────────────────────────────────────────────────────────
api_container_name       = "api"
api_target_port          = 8080
api_ingress_transport    = "auto"
frontend_container_name  = "frontend"
container_image          = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest" # Placeholder — overridden after ACR build
frontend_container_image = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest" # Placeholder — overridden after ACR build
container_cpu            = 2.0                                                           # Production: more CPU
container_memory         = "4Gi"                                                         # Production: more memory
container_min_replicas   = 2                                                             # Production: minimum 2 for HA
container_max_replicas   = 10
aca_environment_name     = "goa-cc-pronghorn-dev-cae-001"

# VNet Injection — Container Apps Environment deployed inside this subnet
container_apps_internal_only = true # PBMM: internal load balancer only

# Workload Container Apps Environment (tenant-deployed containers)
workload_aca_environment_name = "goa-cc-pronghorn-dev-workload-cae-001"
workload_aca_internal_only    = true

# Frontend
frontend_container_cpu    = 0.5   # Production: more CPU than dev default (0.25)
frontend_container_memory = "1Gi" # Production: more memory than dev default (0.5Gi)
frontend_min_replicas     = 2     # Production: minimum 2 for HA
frontend_max_replicas     = 10

# ── API Management ───────────────────────────────────────────────────────────
apim_sku                  = "Premium_1" # PBMM: Premium required for Internal VNet integration + multi-AZ + SLA
apim_api_name             = "pronghorn-dev-api"
apim_api_display_name     = "Pronghorn Dev API"
apim_api_path             = "api"
apim_openai_api_version   = "2025-04-01-preview"
apim_publisher_name       = "Pronghorn"
apim_publisher_email      = "admin@example.com"
apim_virtual_network_type = "Internal" # PBMM: internal VNet integration
# NOTE: Internal VNet integration requires the Premium SKU. Standard/Developer
# cannot be deployed into a VNet in Internal mode for production use.

# ── Container Registry ───────────────────────────────────────────────────────
acr_name                  = "goaccprongbluedevacr"
acr_sku                   = "Premium" # PBMM: Premium required for PE, zone redundancy, trust policies
acr_public_network_access = false     # PBMM: private access only
use_existing_acr          = false
# Dedicated ACR agent pool runs image builds inside the VNet (private). Required
# because the registry has public access disabled — `az acr build` tasks execute
# on these VNet-attached agents instead of the public ACR build fleet.
enable_acr_agent_pool         = true
acr_agent_pool_name           = "pronghorn-build-pool"
acr_agent_pool_tier           = "S2" # Production: faster build agents
acr_agent_pool_instance_count = 1

# ── Platform Resource Group ──────────────────────────────────────────────────
# Optional override for shared platform resources. Leave empty to reuse
# resource_group_name.
platform_resource_group_name = "goa-cc-pronghorn_dev-rg"

# ── Logging ───────────────────────────────────────────────────────────────────
app_insights_type            = "web"
resource_group_wait_duration = "30s"
log_analytics_sku            = "PerGB2018"
log_retention_days           = 90 # Production: longer retention

# ── CORS ──────────────────────────────────────────────────────────────────────
# REPLACE: with your actual frontend domain(s) once a domain is assigned
allowed_origins = ["https://pronghorn.example.com"]

# ── Entra ID App Registration ────────────────────────────────────────────────
# Option A: Terraform-managed (requires Graph API permissions on the deploying SP)
# create_entra_app_registration = true

# Option B: Manually-created (set the IDs from Azure Portal)
create_entra_app_registration = false
vite_auth_mode                = "msal"
vite_use_azure_api            = true

# ── Frontend Build-Time Environment Variables ────────────────────────────────
frontend_build_vars = {
  VITE_AUTH_MODE     = "msal"
  VITE_USE_AZURE_API = "true"
}

# Public custom domain fronting the frontend (public App Gateway -> hub -> internal
# App Gateway -> private Container App). Bakes the custom domain into the frontend
# build as VITE_AZURE_REDIRECT_URI (the MSAL redirect URI), registers it as the
# Entra App Registration redirect URI, and adds it to the API CORS allow-list,
# instead of the auto-generated azurecontainerapps.io FQDN.

# Public custom domain fronting the API (public App Gateway -> hub -> internal
# App Gateway -> internal APIM). The frontend makes direct browser calls to the
# API, so VITE_API_BASE_URL must be a publicly reachable host. Without this the
# build would use the internal APIM gateway URL, which the browser cannot reach.
# Also derives VITE_WS_URL (wss://api.pronghorn.blue) for the WebSocket path.

# ── Azure AI Foundry ──────────────────────────────────────────────────────────
enable_ai_foundry                = true
ai_foundry_location              = "canadaeast"
ai_foundry_project_name          = "pronghorn-dev-pbmm"
ai_foundry_project_description   = "Pronghorn AI dev project"
ai_foundry_enable_agent_service  = true
ai_foundry_sku                   = "S0"
ai_foundry_public_network_access = false # PBMM: private access only
ai_foundry_disable_local_auth    = true  # PBMM: Entra-only auth

# AI Model Deployments
ai_model_deployments = [
  {
    deployment_name        = "gpt-4o"
    model_name             = "gpt-4o"
    model_version          = "2024-11-20"
    sku_name               = "GlobalStandard"
    sku_capacity           = 30
    version_upgrade_option = "OnceCurrentVersionExpired"
  },
  {
    deployment_name        = "gpt-4o-mini"
    model_name             = "gpt-4o-mini"
    model_version          = "2024-07-18"
    sku_name               = "GlobalStandard"
    sku_capacity           = 100
    version_upgrade_option = "OnceCurrentVersionExpired"
  }
]

# ── Policy-Required Tags (Azure Landing Zone) ────────────────────────────────
# REPLACE: with your organization's actual values
client_organization = "Pronghorn"
cost_center         = "Pronghorn-PBMM"
data_sensitivity    = "Protected B"
project_contact     = "admin@example.com"
project_name_tag    = "Pronghorn"
technical_contact   = "admin@example.com"

# ── Tags ──────────────────────────────────────────────────────────────────────
extra_tags = {
  Team               = "Platform"
  Deployment         = "dev"
  SecurityProfile    = "PBMM"
  DataClassification = "Protected B"
}

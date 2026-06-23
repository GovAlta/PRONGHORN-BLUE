# =============================================================================
# Pronghorn Infrastructure - Main Configuration
# =============================================================================
# This is the root module that orchestrates all infrastructure components.
# 
# Usage:
#   terraform init
#   terraform plan -var-file="params/dev.tfvars" -var="administrator_password=YOUR_PASSWORD"
#   terraform apply -var-file="params/dev.tfvars" -var="administrator_password=YOUR_PASSWORD"
#
# Note: Terraform version constraints and required providers are defined in terraform.tf
# =============================================================================

# =============================================================================
# Current deployer identity
# =============================================================================
# Resolves the principal Terraform is authenticated as. During CI this is the
# per-environment OIDC service principal, which both the platform deploy
# (platform-deploy.yml) and the generated-app deploy (genapp-deploy.yml)
# log in as. Used to grant that SP data-plane read access to genapp Key Vaults
# so the genapp Terraform can enumerate secrets at plan time.
data "azurerm_client_config" "current" {}

# =============================================================================
# Random Suffix for Unique Names
# =============================================================================

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

# -----------------------------------------------------------------------------
# Resource Group
# -----------------------------------------------------------------------------

resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.common_tags
}

resource "time_sleep" "wait_for_resource_group" {
  depends_on      = [azurerm_resource_group.main]
  create_duration = var.resource_group_wait_duration

  lifecycle {
    precondition {
      condition     = var.acr_public_network_access || var.acr_private_endpoint_subnet_id != null
      error_message = "ACR is unreachable: acr_public_network_access is false but no acr_private_endpoint_subnet_id is provided. Either enable public access or supply a private endpoint subnet."
    }
    precondition {
      condition     = var.workload_aca_subnet_id == null || var.container_apps_subnet_id == null || var.workload_aca_subnet_id != var.container_apps_subnet_id
      error_message = "workload_aca_subnet_id and container_apps_subnet_id must not be the same subnet. Azure allows only one Managed Environment per delegated subnet."
    }
  }
}

# =============================================================================
# Logging Module (Log Analytics + Application Insights)
# =============================================================================

module "logging" {
  source = "./modules/logging"

  resource_group_name = var.resource_group_name
  location            = var.location
  log_analytics_name  = local.log_analytics_name
  app_insights_name   = local.app_insights_name

  log_analytics_sku = var.log_analytics_sku
  retention_in_days = var.log_retention_days
  application_type  = var.app_insights_type

  tags = local.common_tags

  depends_on = [time_sleep.wait_for_resource_group]
}

# =============================================================================
# Container Registry Module
# =============================================================================

# =============================================================================
# Container Registry - Use existing OR create new based on use_existing_acr
# =============================================================================

# Option A: Use existing ACR (default)
data "azurerm_container_registry" "existing" {
  count               = var.use_existing_acr ? 1 : 0
  name                = var.acr_name
  resource_group_name = local.effective_platform_resource_group_name
}

# Option B: Create new ACR
module "container_registry" {
  count  = var.use_existing_acr ? 0 : 1
  source = "./modules/container-registry"

  resource_group_name           = var.resource_group_name
  location                      = var.location
  registry_name                 = var.acr_name
  sku                           = var.acr_sku
  public_network_access_enabled = var.acr_public_network_access

  # Private Endpoint
  private_endpoint_subnet_id = var.acr_private_endpoint_subnet_id
  private_dns_zone_id        = local.resolved_acr_dns_zone_id

  tags = local.common_tags

  depends_on = [time_sleep.wait_for_resource_group]
}

locals {
  # Provide the same interface regardless of whether ACR is existing or created
  acr_id           = var.use_existing_acr ? data.azurerm_container_registry.existing[0].id : module.container_registry[0].id
  acr_name         = var.use_existing_acr ? data.azurerm_container_registry.existing[0].name : module.container_registry[0].name
  acr_login_server = var.use_existing_acr ? data.azurerm_container_registry.existing[0].login_server : module.container_registry[0].login_server
}

# =============================================================================
# Key Vault Module
# =============================================================================

module "keyvault" {
  source = "./modules/keyvault"

  resource_group_name = var.resource_group_name
  location            = var.location
  key_vault_name      = local.keyvault_name

  sku_name                   = var.keyvault_sku
  soft_delete_retention_days = var.keyvault_soft_delete_retention_days
  purge_protection_enabled   = var.keyvault_purge_protection_enabled

  # Network access — honor tfvars flags directly (do not override based on PE presence)
  # During bootstrap, public access may be needed even with a PE configured
  public_network_access_enabled = var.keyvault_public_network_access
  network_default_action        = var.keyvault_network_default_action
  allowed_ip_ranges             = var.keyvault_allowed_ip_ranges
  # Skip subnet allowlisting when PE is in use — subnets may lack Microsoft.KeyVault service endpoint
  allowed_subnet_ids = var.keyvault_private_endpoint_subnet_id == null && var.container_apps_subnet_id != null ? [var.container_apps_subnet_id] : []

  # Private Endpoint (set in tfvars for landing zone deployments)
  private_endpoint_subnet_id = var.keyvault_private_endpoint_subnet_id
  private_dns_zone_id        = local.resolved_keyvault_dns_zone_id

  # Wait for Azure Policy to attach the PE DNS zone group before writing secrets
  # (PBMM/landing zones). No-op when enabled = false (default).
  private_endpoint_dns_wait = var.private_endpoint_dns_wait

  # Grant the API container app's user-assigned managed identity read access to
  # secrets (Azure RBAC: "Key Vault Secrets User"). Using the pre-created UAMI
  # (rather than the container app's system-assigned identity) avoids a
  # dependency cycle: container_apps references module.keyvault for secret URIs,
  # so keyvault must not depend on module.container_apps.
  secrets_user_principal_ids = [azurerm_user_assigned_identity.api.principal_id]

  # Secrets — only optional, externally-supplied secrets are Terraform-managed
  # here. The generated platform secrets (postgres-password,
  # postgres-genapps-password, jwt-secret) are intentionally NOT in this map:
  # they are seeded create-if-absent by terraform_data.seed_generated_secrets
  # (see secrets.tf) so their plaintext values never land in Terraform state.
  # storage-connection-string was removed entirely — the API authenticates to
  # blob storage with its managed identity (AZURE_STORAGE_ACCOUNT_NAME), so the
  # connection string is unused.
  secrets = local.optional_secrets

  tags = local.common_tags

  depends_on = [time_sleep.wait_for_resource_group]
}

# =============================================================================
# Storage Module
# =============================================================================

module "storage" {
  source = "./modules/storage"

  subscription_id      = var.subscription_id
  resource_group_name  = var.resource_group_name
  location             = var.location
  storage_account_name = local.storage_name

  account_tier       = var.storage_account_tier
  replication_type   = var.storage_replication_type
  allow_public_blobs = false

  # Honor explicit tfvars flags for network access and shared key auth
  public_network_access_enabled = var.storage_public_network_access
  shared_access_key_enabled     = var.storage_shared_access_key_enabled

  # Private Endpoint (set in tfvars for landing zone deployments)
  private_endpoint_subnet_id = var.storage_private_endpoint_subnet_id
  private_dns_zone_id        = local.resolved_storage_dns_zone_id

  # In PBMM/hub-DNS environments, wait for central Private DNS auto-registration
  # before attempting blob data-plane operations (container creation).
  dns_registration_wait_minutes = var.dns_registration_wait_minutes

  containers = var.storage_blob_containers

  cors_rules = [
    {
      allowed_headers    = ["*"]
      allowed_methods    = ["GET", "POST", "PUT", "DELETE"]
      allowed_origins    = var.allowed_origins
      exposed_headers    = ["*"]
      max_age_in_seconds = var.storage_cors_max_age
    }
  ]

  tags = local.common_tags

  depends_on = [time_sleep.wait_for_resource_group]
}

# =============================================================================
# Storage Module — Dedicated Repo / Code-Writes Account
# =============================================================================
# Dedicated storage account that backs the backend repo blob store
# (app/backend/src/utils/repoBlobStore.ts). The backend writes generated-app
# code files here via DefaultAzureCredential, using one container per project
# (container name = projectId, created on-the-fly at runtime). Isolating these
# writes onto their own account keeps code-file traffic and RBAC separate from
# the platform storage account above. The container app reaches this account via
# the AZURE_STORAGE_ACCOUNT_NAME env var (see locals.tf) and managed identity.
module "storage_repo" {
  source = "./modules/storage"

  subscription_id      = var.subscription_id
  resource_group_name  = var.resource_group_name
  location             = var.location
  storage_account_name = local.repo_storage_name

  account_tier       = var.storage_account_tier
  replication_type   = var.storage_replication_type
  allow_public_blobs = false

  # Honor explicit tfvars flags for network access and shared key auth
  public_network_access_enabled = var.storage_public_network_access
  shared_access_key_enabled     = var.storage_shared_access_key_enabled

  # Private Endpoint (set in tfvars for landing zone deployments)
  private_endpoint_subnet_id = var.storage_private_endpoint_subnet_id
  private_dns_zone_id        = local.resolved_storage_dns_zone_id

  # In PBMM/hub-DNS environments, wait for central Private DNS auto-registration
  # before attempting blob data-plane operations (container creation).
  dns_registration_wait_minutes = var.dns_registration_wait_minutes

  # No static containers — the backend creates one container per project at runtime.
  containers = {}

  cors_rules = [
    {
      allowed_headers    = ["*"]
      allowed_methods    = ["GET", "POST", "PUT", "DELETE"]
      allowed_origins    = var.allowed_origins
      exposed_headers    = ["*"]
      max_age_in_seconds = var.storage_cors_max_age
    }
  ]

  tags = local.common_tags

  depends_on = [time_sleep.wait_for_resource_group]
}

# =============================================================================
# PostgreSQL Module
# =============================================================================

module "postgresql" {
  source = "./modules/postgresql"

  resource_group_name = var.resource_group_name
  location            = var.location
  server_name         = var.postgresql_server_name
  database_name       = var.postgresql_database_name
  administrator_login = var.administrator_login

  # Write-only admin password: read from Key Vault as an ephemeral value (never
  # persisted to state). var.administrator_password is a null-by-default
  # break-glass override handled inside the module via coalesce().
  administrator_password            = var.administrator_password
  administrator_password_wo         = ephemeral.azurerm_key_vault_secret.postgres_password.value
  administrator_password_wo_version = var.administrator_password_wo_version

  # Server configuration
  postgresql_version = var.postgresql_version
  sku_name           = var.postgresql_sku_name
  storage_mb         = var.postgresql_storage_mb
  availability_zone  = var.availability_zone

  # Network - set in tfvars for landing zone deployments (null = public-facing)
  vnet_id             = var.vnet_id
  delegated_subnet_id = var.delegated_subnet_id
  private_dns_zone_id = local.resolved_postgres_dns_zone_id

  # Private Endpoint (for servers NOT using delegated subnet)
  private_endpoint_subnet_id = var.postgresql_private_endpoint_subnet_id
  pe_private_dns_zone_id     = local.resolved_postgres_dns_zone_id
  private_endpoint_dns_wait  = var.private_endpoint_dns_wait

  # High availability
  enable_high_availability  = var.enable_high_availability
  standby_availability_zone = var.standby_availability_zone

  # Backup
  backup_retention_days        = var.backup_retention_days
  geo_redundant_backup_enabled = var.geo_redundant_backup_enabled

  # Maintenance window
  maintenance_day  = var.maintenance_day
  maintenance_hour = var.maintenance_hour

  # Security
  require_ssl                  = var.require_ssl
  enable_connection_throttling = var.enable_connection_throttling
  log_connections              = var.log_connections
  log_disconnections           = var.log_disconnections

  # Firewall
  enable_development_access = var.enable_development_access
  allowed_ip_start          = var.allowed_ip_start
  allowed_ip_end            = var.allowed_ip_end
  custom_firewall_rules     = var.custom_firewall_rules
  # Public access (disabled by default for PBMM; set false in dev.tfvars for public-facing dev environments)
  disable_public_access = var.postgresql_disable_public_access
  # Extensions
  postgresql_extensions = var.postgresql_extensions

  # Tags
  tags = local.common_tags

  depends_on = [time_sleep.wait_for_resource_group]
}

# =============================================================================
# PostgreSQL Generated Applications Module
# =============================================================================
# Second Flexible Server dedicated to per-project databases (proj_*) created
# dynamically by the API.  Day-1 deployment creates an empty server with only
# the default "postgres" system database; project databases are provisioned at
# runtime when users click "Create Database" in the UI.
# =============================================================================

module "postgresql_genapps" {
  source = "./modules/postgresql"

  resource_group_name = var.resource_group_name
  location            = var.location
  server_name         = var.postgresql_genapps_server_name
  database_name       = var.postgresql_genapps_database_name
  administrator_login = var.postgresql_genapps_administrator_login

  # Write-only admin password sourced from the ephemeral Key Vault read.
  administrator_password            = var.postgresql_genapps_administrator_password
  administrator_password_wo         = ephemeral.azurerm_key_vault_secret.postgres_genapps_password.value
  administrator_password_wo_version = var.postgresql_genapps_administrator_password_wo_version

  # Server configuration
  postgresql_version = var.postgresql_genapps_version
  sku_name           = var.postgresql_genapps_sku_name
  storage_mb         = var.postgresql_genapps_storage_mb
  availability_zone  = var.postgresql_genapps_availability_zone

  # Network — reuses the same VNet / DNS zone as the application server
  vnet_id             = var.vnet_id
  delegated_subnet_id = var.delegated_subnet_id
  private_dns_zone_id = local.resolved_postgres_dns_zone_id

  # Private Endpoint (for servers NOT using delegated subnet)
  private_endpoint_subnet_id = var.postgresql_genapps_private_endpoint_subnet_id
  pe_private_dns_zone_id     = try(coalesce(var.postgresql_genapps_pe_private_dns_zone_id, local.resolved_postgres_dns_zone_id), null)
  private_endpoint_dns_wait  = var.private_endpoint_dns_wait

  # High availability (independent from app server for scaling flexibility)
  enable_high_availability  = var.postgresql_genapps_enable_high_availability
  standby_availability_zone = var.standby_availability_zone

  # Backup (independent from app server for cost/retention flexibility)
  backup_retention_days        = var.postgresql_genapps_backup_retention_days
  geo_redundant_backup_enabled = var.postgresql_genapps_geo_redundant_backup_enabled

  # Maintenance window (stagger from app server to avoid simultaneous downtime)
  maintenance_day  = var.postgresql_genapps_maintenance_day
  maintenance_hour = var.postgresql_genapps_maintenance_hour

  # Security
  require_ssl                  = var.require_ssl
  enable_connection_throttling = var.enable_connection_throttling
  log_connections              = var.log_connections
  log_disconnections           = var.log_disconnections

  # Firewall
  enable_development_access = var.enable_development_access
  allowed_ip_start          = var.allowed_ip_start
  allowed_ip_end            = var.allowed_ip_end
  custom_firewall_rules     = var.custom_firewall_rules
  disable_public_access     = var.postgresql_genapps_disable_public_access

  # Extensions — same set as the application server
  postgresql_extensions = var.postgresql_extensions

  # Tags
  tags = local.common_tags

  depends_on = [time_sleep.wait_for_resource_group]
}

# =============================================================================
# User-Assigned Managed Identities for Container Apps
# =============================================================================
# Pre-created so AcrPull can be granted BEFORE the container app exists,
# eliminating the bootstrap race where system-assigned identity requires
# the app to exist before the role can be assigned, but the app creation
# polls for a healthy revision which needs the role.
# =============================================================================

resource "azurerm_user_assigned_identity" "api" {
  name                = "${local.container_app_name}-identity"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = local.common_tags

  depends_on = [time_sleep.wait_for_resource_group]
}

resource "azurerm_user_assigned_identity" "frontend" {
  name                = "${local.frontend_app_name}-identity"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = local.common_tags

  depends_on = [time_sleep.wait_for_resource_group]
}

# AcrPull granted on the UAMI — exists before container apps are created
resource "azurerm_role_assignment" "api_uami_acr_pull" {
  scope                = local.acr_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.api.principal_id
}

resource "azurerm_role_assignment" "frontend_uami_acr_pull" {
  scope                = local.acr_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.frontend.principal_id
}

resource "azurerm_role_assignment" "api_uami_storage_blob_contributor" {
  scope                = module.storage_repo.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.api.principal_id
}

# The backend builds its blob client with a bare DefaultAzureCredential(). Because
# the API container app has BOTH a system-assigned identity and the user-assigned
# identity attached, the SDK resolves to the SYSTEM-ASSIGNED identity at runtime.
# Grant the same data-plane role to that identity so blob operations are authorized
# (the UAMI assignment above is retained for ACR/UAMI-based flows and future use).
# Both assignments target the dedicated repo/code-writes account, since that is the
# account the backend writes generated-app files to (AZURE_STORAGE_ACCOUNT_NAME).
resource "azurerm_role_assignment" "api_system_identity_storage_blob_contributor" {
  scope                = module.storage_repo.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = module.container_apps.principal_id
}

# =============================================================================
# Container Apps Module (Platform — API + Frontend)
# =============================================================================

module "container_apps" {
  source = "./modules/container-apps"

  subscription_id            = var.subscription_id
  resource_group_name        = var.resource_group_name
  location                   = var.location
  environment_name           = var.aca_environment_name
  container_app_name         = local.container_app_name
  log_analytics_workspace_id = module.logging.log_analytics_id

  # User-Assigned Managed Identity for ACR access (avoids bootstrap race)
  user_assigned_identity_id = azurerm_user_assigned_identity.api.id

  # Use the existing platform ACA environment (managed outside Terraform)
  existing_environment_id         = var.existing_container_app_environment_id
  environment_resource_group_name = local.effective_platform_resource_group_name

  # VNet Integration (set in tfvars for landing zone deployments)
  infrastructure_subnet_id       = var.container_apps_subnet_id
  internal_load_balancer_enabled = var.container_apps_internal_only

  # Environment Private Endpoint
  environment_private_endpoint_subnet_id = var.aca_environment_private_endpoint_subnet_id
  environment_private_dns_zone_id        = local.resolved_aca_env_dns_zone_id

  # Container configuration
  # Note: Bootstrap uses public MCR image for initial deploy (online archetype).
  # For VNet-restricted (corp) environments, import to ACR first:
  #   az acr import --name <acr> --source mcr.microsoft.com/azuredocs/containerapps-helloworld:latest --image containerapps-helloworld:latest
  # The workflow's deploy-container-apps-apply step overwrites this with the real image.
  container_name   = var.api_container_name
  container_image  = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
  container_cpu    = var.container_cpu
  container_memory = var.container_memory

  # Scaling
  min_replicas = var.container_min_replicas
  max_replicas = var.container_max_replicas

  # Environment variables
  environment_variables = local.api_environment_variables


  secret_environment_variables = local.api_secret_environment_variables

  # Secrets are sourced from the platform Key Vault via Container App Key Vault
  # references (resolved at runtime using the API's user-assigned managed
  # identity). Values are not stored in Terraform state or the Container App
  # configuration. Two sources are merged:
  #   1. Terraform-managed optional secrets (github-*, render-*) — versionless
  #      ids come straight from the keyvault module.
  #   2. Seeded generated secrets (postgres-password, postgres-genapps-password,
  #      jwt-secret) — NOT Terraform-managed, so their versionless reference URIs
  #      are constructed directly from the vault URI + secret name.
  secret_key_vault_references = merge(
    {
      for name, versionless_id in module.keyvault.secret_versionless_ids : name => {
        key_vault_secret_id = versionless_id
      }
    },
    {
      for name in local.seeded_generated_secret_names : name => {
        key_vault_secret_id = "${module.keyvault.vault_uri}secrets/${name}"
      }
    },
    {
      # Dummy-seeded GitHub App identity (real values set out-of-band); each
      # referenced by its Terraform-managed versionless id.
      "github-app-private-key" = {
        key_vault_secret_id = azurerm_key_vault_secret.github_app_private_key.versionless_id
      }
      "github-app-id" = {
        key_vault_secret_id = azurerm_key_vault_secret.github_app_id.versionless_id
      }
      "github-app-installation-id" = {
        key_vault_secret_id = azurerm_key_vault_secret.github_app_installation_id.versionless_id
      }
    }
  )
  secret_identity_id = azurerm_user_assigned_identity.api.id

  # Health probes - disabled for hello-world sample image
  # Enable these when deploying your actual API container
  liveness_probe  = null
  readiness_probe = null

  # Ingress
  enable_ingress    = true
  external_ingress  = true
  target_port       = var.api_target_port
  ingress_transport = var.api_ingress_transport

  # Container Registry — Terraform owns the registries block so that any apply
  # (core-infra or container-apps) includes ACR credentials in the resource body.
  # UAMI + AcrPull role are created before this module via depends_on.
  # Having an ACR registry configured while using an MCR bootstrap image is safe:
  # Azure only uses registry credentials for images matching the registry server.
  registry_server               = local.acr_login_server
  use_managed_identity_for_acr  = true
  registry_username             = null
  registry_password_secret_name = null

  tags = local.common_tags

  depends_on = [
    time_sleep.wait_for_resource_group,
    module.postgresql,
    module.postgresql_genapps,
    module.storage,
    module.storage_repo,
    module.keyvault,
    terraform_data.seed_generated_secrets,
    azurerm_key_vault_secret.github_app_private_key,
    azurerm_key_vault_secret.github_app_id,
    azurerm_key_vault_secret.github_app_installation_id,
    azurerm_role_assignment.api_uami_acr_pull
  ]
}

# -----------------------------------------------------------------------------
# Key Vault access for the API Container App
# Access is granted via Azure RBAC: the API's user-assigned managed identity
# (azurerm_user_assigned_identity.api) is assigned "Key Vault Secrets User"
# inside the keyvault module (secrets_user_principal_ids). The container app
# resolves secrets at runtime via Key Vault references using that identity.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# ACR Pull Role Assignment for Container App
# -----------------------------------------------------------------------------

resource "azurerm_role_assignment" "container_app_acr_pull" {
  scope                = local.acr_id
  role_definition_name = "AcrPull"
  principal_id         = module.container_apps.principal_id
}

resource "azurerm_role_assignment" "frontend_acr_pull" {
  scope                = local.acr_id
  role_definition_name = "AcrPull"
  principal_id         = module.frontend.principal_id
}

# -----------------------------------------------------------------------------
# Non-VNet ACR Dedicated Agent Pool (PBMM)
# -----------------------------------------------------------------------------
# Dedicated agent pools can push to private ACRs (public access disabled)
# because they run within Azure's trusted infrastructure.
# No VNet integration needed — avoids VMSS injection issues with forced tunneling.
# Used by GitHub Actions via `az acr build --agent-pool`.
# -----------------------------------------------------------------------------

resource "azurerm_container_registry_agent_pool" "build" {
  count                   = var.enable_acr_agent_pool ? 1 : 0
  name                    = var.acr_agent_pool_name
  resource_group_name     = local.effective_platform_resource_group_name
  location                = var.location
  container_registry_name = local.acr_name
  instance_count          = var.acr_agent_pool_instance_count
  tier                    = var.acr_agent_pool_tier

  tags = local.common_tags
}

# =============================================================================
# API Management Module
# =============================================================================

module "api_management" {
  source = "./modules/api-management"

  resource_group_name = var.resource_group_name
  location            = var.location
  apim_name           = local.apim_name
  publisher_name      = var.apim_publisher_name
  publisher_email     = var.apim_publisher_email

  sku_name = var.apim_sku

  # VNet integration (required to reach internal Container Apps)
  virtual_network_type = var.apim_virtual_network_type
  subnet_id            = var.apim_subnet_id

  # Application Insights integration
  app_insights_id                  = module.logging.app_insights_id
  app_insights_instrumentation_key = module.logging.app_insights_instrumentation_key
  enable_diagnostics               = true

  # API configuration
  create_api            = true
  api_name              = var.apim_api_name
  api_display_name      = var.apim_api_display_name
  api_path              = var.apim_api_path
  subscription_required = false
  backend_url           = "${module.container_apps.app_url}/api"

  # OpenAI API proxy to Azure AI Foundry
  # Note: AI Foundry uses cognitiveservices.azure.com/openai, NOT openai.azure.com
  create_openai_api  = var.enable_ai_foundry
  openai_backend_url = var.enable_ai_foundry ? "https://${local.ai_foundry_name}.cognitiveservices.azure.com/openai" : null
  openai_api_version = var.apim_openai_api_version

  # Entra ID configuration for JWT validation
  azure_tenant_id   = local.effective_tenant_id
  azure_client_id   = local.effective_client_id
  enable_entra_auth = var.create_entra_app_registration || var.azure_client_id != null

  # CORS allowed origins - include frontend URL and localhost for development.
  # When frontend_app_url_override is set (public custom domain), the browser's
  # Origin header is that domain, so it must be in the allow-list. Note: Origin
  # headers never carry a trailing slash, so the override is added verbatim.
  cors_allowed_origins = concat(
    var.allowed_origins,
    [module.frontend.app_url],
    var.frontend_app_url_override != null ? [var.frontend_app_url_override] : [],
    var.enable_development_access ? ["http://localhost:5173"] : []
  )

  tags = local.common_tags

  depends_on = [module.container_apps]
}

# =============================================================================
# Frontend Container App Module
# =============================================================================

module "frontend" {
  source = "./modules/frontend"

  subscription_id              = var.subscription_id
  resource_group_name          = var.resource_group_name
  location                     = var.location
  container_app_name           = local.frontend_app_name
  container_app_environment_id = module.container_apps.environment_id

  # User-Assigned Managed Identity for ACR access (avoids bootstrap race)
  user_assigned_identity_id = azurerm_user_assigned_identity.frontend.id

  # Bootstrap uses public MCR image for initial deploy (online archetype)
  container_image = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"

  # Container configuration
  container_name   = var.frontend_container_name
  container_cpu    = var.frontend_container_cpu
  container_memory = var.frontend_container_memory

  # Scaling
  min_replicas = var.frontend_min_replicas
  max_replicas = var.frontend_max_replicas

  # Container Registry — Terraform owns the registries block (see API container app comment).
  registry_server               = local.acr_login_server
  use_managed_identity_for_acr  = true
  registry_username             = null
  registry_password_secret_name = null

  secrets = {}

  tags = local.common_tags

  depends_on = [
    time_sleep.wait_for_resource_group,
    module.container_apps,
    azurerm_role_assignment.frontend_uami_acr_pull
  ]
}

# =============================================================================
# Entra ID App Registration (optional – controlled by create_entra_app_registration)
# =============================================================================

module "entra_app_registration" {
  count  = var.create_entra_app_registration ? 1 : 0
  source = "./modules/entra-app-registration"

  application_display_name = var.entra_app_display_name
  sign_in_audience         = var.entra_app_sign_in_audience
  expose_api_scope         = true
  owners                   = var.entra_app_owners

  redirect_uris = concat(
    # Primary redirect: frontend Container App URL (auto-detected)
    # Azure AD requires a trailing slash on URIs without a path segment
    ["${trimsuffix(coalesce(var.frontend_app_url_override, module.frontend.app_url), "/")}/"],
    # Additional redirect URIs (e.g. custom domains)
    var.entra_app_redirect_uris,
    # Optional localhost for dev
    var.entra_app_include_localhost_redirect ? ["http://localhost:5173/"] : []
  )

  depends_on = [module.frontend]
}

# =============================================================================
# Workload Container Apps Environment (tenant-deployed containers)
# =============================================================================

module "workload_environment" {
  source = "./modules/workload-environment"

  subscription_id            = var.subscription_id
  resource_group_name        = var.resource_group_name
  location                   = var.location
  environment_name           = var.workload_aca_environment_name
  log_analytics_workspace_id = module.logging.log_analytics_id

  # VNet Integration (share platform subnet or use dedicated)
  infrastructure_subnet_id       = var.workload_aca_subnet_id
  internal_load_balancer_enabled = var.workload_aca_internal_only

  # Private Endpoint
  private_endpoint_subnet_id = var.workload_aca_private_endpoint_subnet_id
  private_dns_zone_id        = local.resolved_workload_aca_dns_zone_id

  tags = local.common_tags

  depends_on = [time_sleep.wait_for_resource_group]
}

# -----------------------------------------------------------------------------
# Contributor Role for API MI on Workload Environment
# Allows the API to dynamically create/manage Container Apps in the workload env
# -----------------------------------------------------------------------------

resource "azurerm_role_assignment" "api_workload_env_contributor" {
  scope                = module.workload_environment.environment_id
  role_definition_name = "Contributor"
  principal_id         = module.container_apps.principal_id
}

# -----------------------------------------------------------------------------
# Contributor Role for API MI at Subscription Scope
# Allows the API to read and manage genapp container apps in dynamically-created
# resource groups (rg-genapp-*) for FQDN resolution, stop, start, and restart.
# -----------------------------------------------------------------------------

resource "azurerm_role_assignment" "api_subscription_contributor" {
  scope                = "/subscriptions/${var.subscription_id}"
  role_definition_name = "Contributor"
  principal_id         = module.container_apps.principal_id
}

# -----------------------------------------------------------------------------
# Key Vault Secrets Officer for API MI on the genapp Key Vault resource group
# -----------------------------------------------------------------------------
# The backend creates a per-generated-app / per-project Key Vault at runtime
# (genappKeyVault.ts) and writes the app's env vars, user secrets, and DB
# connection string into it over the Key Vault data plane. The backend
# authenticates as the API container's SYSTEM-assigned identity (bare
# DefaultAzureCredential resolves to it). Granting Secrets Officer at the
# resource-group scope lets the backend read/write secrets on every kv-ga-*
# vault by inheritance — no per-vault role assignment (which would require the
# more powerful User Access Administrator) is needed.
#
# Scope = the resource group the backend places genapp vaults in, which mirrors
# genappKeyVaultResourceGroup(): AZURE_GENAPP_KEYVAULT_RESOURCE_GROUP, else
# AZURE_DEPLOY_RESOURCE_GROUP, else the deploy RG. Today that is the platform
# deploy RG (azurerm_resource_group.main); a dedicated genapp KV RG can be
# substituted later to keep the platform vault out of this scope.
resource "azurerm_role_assignment" "api_system_identity_genapp_kv_secrets_officer" {
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = module.container_apps.principal_id
}

# -----------------------------------------------------------------------------
# Network Contributor for API MI on the genapp Key Vault private-endpoint subnet
# -----------------------------------------------------------------------------
# When genapp Key Vaults are locked down (genapp_keyvault_public_network_access
# == "Disabled"), the backend (genappKeyVault.ts) creates a per-vault private
# endpoint at runtime so it can reach the vault's data plane to write secrets.
# Creating the private endpoint and joining it to the subnet requires the
# Microsoft.Network/virtualNetworks/subnets/join/action permission on the PE
# subnet. The platform already grants the API MI subscription-scope Contributor
# above (api_subscription_contributor), which covers this; this scoped grant is
# an explicit, least-privilege safeguard so the connectivity flow keeps working
# even if the broad Contributor grant is later trimmed by PBMM hardening. It is
# only created when lockdown is on and a PE subnet is resolvable.
resource "azurerm_role_assignment" "api_genapp_kv_pe_subnet_network_contributor" {
  count = var.genapp_keyvault_public_network_access == "Disabled" && local.genapp_keyvault_pe_subnet_id != null ? 1 : 0

  scope                = local.genapp_keyvault_pe_subnet_id
  role_definition_name = "Network Contributor"
  principal_id         = module.container_apps.principal_id
}

# -----------------------------------------------------------------------------
# Key Vault Secrets User for the CI deploy SP on the genapp Key Vault RG
# -----------------------------------------------------------------------------
# The generated-app deploy workflow (genapp-deploy.yml) runs Terraform from
# infra/generated-app-template, authenticated as the pbmm-<env> OIDC service
# principal (the same identity that runs this platform deploy). That Terraform
# READS each genapp Key Vault's secrets at plan time
# (data.azurerm_key_vault_secrets / azurerm_key_vault_secret) to wire them into
# the Container App as secretRef env vars. Because the vaults use RBAC
# authorization, the deploy SP needs a data-plane read role or the read fails
# with 403 ForbiddenByRbac. This grant (read-only Secrets User, least
# privilege) at the genapp KV resource-group scope covers every kv-ga-* vault
# by inheritance. The backend (API system identity) keeps the broader Secrets
# Officer role above because it WRITES secret values; the deploy SP only reads.
resource "azurerm_role_assignment" "deployer_genapp_kv_secrets_user" {
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = data.azurerm_client_config.current.object_id
}

# =============================================================================
# Azure AI Foundry Module (New Project-Based Architecture)
# =============================================================================

module "ai_foundry" {
  count  = var.enable_ai_foundry ? 1 : 0
  source = "./modules/ai-foundry"

  subscription_id     = var.subscription_id
  resource_group_name = var.resource_group_name
  location            = var.ai_foundry_location # Use separate region for better GPT model availability
  ai_services_name    = local.ai_foundry_name

  # Project configuration (NEW Foundry Architecture)
  project_name         = var.ai_foundry_project_name
  project_description  = var.ai_foundry_project_description
  enable_agent_service = var.ai_foundry_enable_agent_service

  # SKU and access configuration
  sku_name              = var.ai_foundry_sku
  public_network_access = var.ai_foundry_public_network_access
  disable_local_auth    = var.ai_foundry_disable_local_auth

  # Model deployments
  model_deployments = var.ai_model_deployments

  # Monitoring
  log_analytics_workspace_id = module.logging.log_analytics_id

  # Private Endpoint (APIM calls AI Foundry over Private Link)
  private_endpoint_subnet_id = var.ai_foundry_private_endpoint_subnet_id
  private_endpoint_location  = var.location # VNet is in canadacentral, PE must be co-located
  private_dns_zone_ids       = local.resolved_ai_foundry_dns_zone_ids
  private_dns_zone_id        = var.ai_foundry_private_dns_zone_id

  tags = local.common_tags

  depends_on = [time_sleep.wait_for_resource_group]
}

# =============================================================================
# APIM Role Assignment for AI Foundry Access
# =============================================================================

resource "azurerm_role_assignment" "apim_cognitive_services" {
  count                = var.enable_ai_foundry ? 1 : 0
  scope                = module.ai_foundry[0].ai_services_id
  role_definition_name = "Cognitive Services OpenAI User"
  principal_id         = module.api_management.identity_principal_id
}

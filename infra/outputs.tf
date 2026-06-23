# =============================================================================
# Root Outputs for Pronghorn Infrastructure
# =============================================================================

# -----------------------------------------------------------------------------
# Logging Outputs
# -----------------------------------------------------------------------------

output "log_analytics_id" {
  description = "Log Analytics workspace ID"
  value       = module.logging.log_analytics_id
}

output "app_insights_connection_string" {
  description = "Application Insights connection string"
  value       = module.logging.app_insights_connection_string
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Container Registry Outputs
# -----------------------------------------------------------------------------

output "container_registry_name" {
  description = "Azure Container Registry name"
  value       = local.acr_name
}

output "container_registry_login_server" {
  description = "Azure Container Registry login server"
  value       = local.acr_login_server
}

output "container_registry_id" {
  description = "Azure Container Registry resource ID"
  value       = local.acr_id
}

output "acr_login_server" {
  description = "DEPRECATED: Use container_registry_login_server instead. Azure Container Registry login server."
  value       = local.acr_login_server
}

# -----------------------------------------------------------------------------
# Resource Group Output
# -----------------------------------------------------------------------------

output "resource_group_name" {
  description = "Name of the resource group"
  value       = azurerm_resource_group.main.name
}

# -----------------------------------------------------------------------------
# Key Vault Outputs
# -----------------------------------------------------------------------------

output "keyvault_uri" {
  description = "Key Vault URI"
  value       = module.keyvault.vault_uri
}

# -----------------------------------------------------------------------------
# Storage Outputs
# -----------------------------------------------------------------------------

output "storage_primary_blob_endpoint" {
  description = "Storage primary blob endpoint"
  value       = module.storage.primary_blob_endpoint
}

output "repo_storage_account_name" {
  description = "Name of the dedicated repo/code-writes storage account (backs the backend repo blob store)"
  value       = module.storage_repo.name
}

output "repo_storage_primary_blob_endpoint" {
  description = "Primary blob endpoint of the dedicated repo/code-writes storage account"
  value       = module.storage_repo.primary_blob_endpoint
}

# -----------------------------------------------------------------------------
# PostgreSQL Outputs
# -----------------------------------------------------------------------------

output "postgresql_server_id" {
  description = "The ID of the PostgreSQL server"
  value       = module.postgresql.server_id
}

output "postgresql_server_name" {
  description = "The name of the PostgreSQL server"
  value       = module.postgresql.server_name
}

output "postgresql_server_fqdn" {
  description = "The fully qualified domain name of the PostgreSQL server"
  value       = module.postgresql.server_fqdn
}

output "postgresql_database_name" {
  description = "The name of the PostgreSQL database"
  value       = module.postgresql.database_name
  sensitive   = true
}

output "postgresql_connection_string" {
  description = "PostgreSQL connection string (without password)"
  value       = module.postgresql.connection_string
  sensitive   = true
}

output "postgresql_azure_portal_url" {
  description = "Azure Portal URL for the PostgreSQL Server"
  value       = module.postgresql.azure_portal_url
}

# -----------------------------------------------------------------------------
# PostgreSQL Generated Applications Outputs
# -----------------------------------------------------------------------------

output "postgresql_genapps_server_id" {
  description = "The ID of the Generated Applications PostgreSQL server"
  value       = module.postgresql_genapps.server_id
}

output "postgresql_genapps_server_name" {
  description = "The name of the Generated Applications PostgreSQL server"
  value       = module.postgresql_genapps.server_name
}

output "postgresql_genapps_server_fqdn" {
  description = "The fully qualified domain name of the Generated Applications PostgreSQL server"
  value       = module.postgresql_genapps.server_fqdn
}

output "postgresql_genapps_connection_string" {
  description = "Generated Applications PostgreSQL connection string (without password)"
  value       = module.postgresql_genapps.connection_string
  sensitive   = true
}

output "postgresql_genapps_azure_portal_url" {
  description = "Azure Portal URL for the Generated Applications PostgreSQL Server"
  value       = module.postgresql_genapps.azure_portal_url
}

# -----------------------------------------------------------------------------
# Container Apps Outputs
# -----------------------------------------------------------------------------

output "container_app_url" {
  description = "Container App URL"
  value       = module.container_apps.app_url
}

output "container_app_fqdn" {
  description = "Container App FQDN"
  value       = module.container_apps.app_fqdn
}

output "api_uami_id" {
  description = "Resource ID of the API container app's user-assigned managed identity"
  value       = azurerm_user_assigned_identity.api.id
}

output "frontend_uami_id" {
  description = "Resource ID of the frontend container app's user-assigned managed identity"
  value       = azurerm_user_assigned_identity.frontend.id
}

# -----------------------------------------------------------------------------
# Workload Environment Outputs
# -----------------------------------------------------------------------------

output "workload_environment_id" {
  description = "Workload Container App Environment ID (for tenant-deployed containers)"
  value       = module.workload_environment.environment_id
}

output "workload_environment_name" {
  description = "Workload Container App Environment name"
  value       = module.workload_environment.environment_name
}

# -----------------------------------------------------------------------------
# Frontend Outputs
# -----------------------------------------------------------------------------

output "frontend_url" {
  description = "Frontend Container App URL"
  value       = module.frontend.app_url
}

output "frontend_app_url" {
  description = "DEPRECATED: Use frontend_url instead. Frontend Container App URL."
  value       = module.frontend.app_url
}

output "frontend_fqdn" {
  description = "Frontend Container App FQDN"
  value       = module.frontend.app_fqdn
}

# -----------------------------------------------------------------------------
# API Management Outputs
# -----------------------------------------------------------------------------

output "apim_gateway_url" {
  description = "API Management gateway URL"
  value       = module.api_management.gateway_url
}

output "api_management_gateway_url" {
  description = "DEPRECATED: Use apim_gateway_url instead. API Management gateway URL."
  value       = module.api_management.gateway_url
}

output "apim_developer_portal_url" {
  description = "API Management developer portal URL"
  value       = module.api_management.developer_portal_url
}

output "apim_openai_url" {
  description = "APIM OpenAI API URL for Foundry models"
  value       = var.enable_ai_foundry ? module.api_management.openai_api_url : null
}

# -----------------------------------------------------------------------------
# Azure AI Foundry Outputs
# -----------------------------------------------------------------------------

output "ai_foundry_endpoint" {
  description = "Azure AI Foundry endpoint for model inference"
  value       = var.enable_ai_foundry ? module.ai_foundry[0].foundry_endpoint : null
}

output "ai_foundry_project_name" {
  description = "Azure AI Foundry project name"
  value       = var.enable_ai_foundry ? module.ai_foundry[0].project_name : null
}

output "ai_foundry_project_endpoint" {
  description = "Azure AI Foundry project endpoint for SDK/API access"
  value       = var.enable_ai_foundry ? module.ai_foundry[0].project_endpoint : null
}

output "ai_foundry_deployed_models" {
  description = "List of deployed AI model names"
  value       = var.enable_ai_foundry ? module.ai_foundry[0].deployed_model_names : []
}

# -----------------------------------------------------------------------------
# Entra ID App Registration Outputs
# -----------------------------------------------------------------------------

output "entra_app_client_id" {
  description = "Entra ID App Registration Client ID (from Terraform module or manual variable)"
  value       = local.effective_client_id
}

output "entra_app_tenant_id" {
  description = "Entra ID Tenant ID (from Terraform module or manual variable)"
  value       = local.effective_tenant_id
}

output "entra_app_object_id" {
  description = "Entra ID App Registration Object ID (only when created by Terraform)"
  value       = var.create_entra_app_registration ? module.entra_app_registration[0].object_id : null
}

output "vite_auth_mode" {
  description = "DEPRECATED: Use frontend_build_env_vars instead."
  value       = var.vite_auth_mode
}

output "vite_github_org" {
  description = "DEPRECATED: Use frontend_build_env_vars instead."
  value       = local.configured_github_org
}

output "vite_use_azure_api" {
  description = "DEPRECATED: Use frontend_build_env_vars instead."
  value       = tostring(var.vite_use_azure_api)
}

output "frontend_build_env_vars" {
  description = "Frontend build-time env vars for `npm run build`. Merges static config from frontend_build_vars with infrastructure-derived values."
  value       = local.frontend_build_environment_variables
}

# -----------------------------------------------------------------------------
# Container App Environment Variables (CI/CD consumption)
# -----------------------------------------------------------------------------

output "api_container_env_vars" {
  description = "API container app env vars for `az containerapp update --set-env-vars`. Merges plain values and secretref: bindings so the workflow never hardcodes env var names."
  sensitive   = true
  value = merge(
    local.api_environment_variables,
    { for k, v in local.api_secret_environment_variables : k => "secretref:${v}" },
    # Override bootstrap values with effective Entra outputs (can't live in
    # the local because module.entra_app_registration → module.frontend →
    # module.container_apps → local.api_environment_variables would cycle).
    # Names are ENTRA_* (not AZURE_*) to avoid @azure/identity SDK conflict —
    # see infra/locals.tf api_environment_variables for full explanation.
    {
      "ENTRA_CLIENT_ID" = local.effective_client_id
      "ENTRA_TENANT_ID" = local.effective_tenant_id
    },
    var.enable_ai_foundry ? { "APIM_OPENAI_URL" = module.api_management.openai_api_url } : {}
  )
}

# -----------------------------------------------------------------------------
# Summary Output
# -----------------------------------------------------------------------------

output "deployment_summary" {
  description = "Summary of the deployed infrastructure"
  sensitive   = true
  value = {
    environment             = var.environment
    resource_group          = var.resource_group_name
    location                = var.location
    postgresql_server       = module.postgresql.server_name
    postgresql_database     = module.postgresql.database_name
    high_availability       = var.enable_high_availability
    container_app_url       = module.container_apps.app_url
    frontend_url            = module.frontend.app_url
    apim_gateway_url        = module.api_management.gateway_url
    acr_login_server        = local.acr_login_server
    keyvault_uri            = module.keyvault.vault_uri
    storage_endpoint        = module.storage.primary_blob_endpoint
    ai_foundry_endpoint     = var.enable_ai_foundry ? module.ai_foundry[0].foundry_endpoint : null
    ai_foundry_project      = var.enable_ai_foundry ? module.ai_foundry[0].project_name : null
    ai_foundry_models       = var.enable_ai_foundry ? module.ai_foundry[0].deployed_model_names : []
    entra_app_client_id     = local.effective_client_id
    entra_app_tenant_id     = local.effective_tenant_id
    entra_app_managed_by_tf = var.create_entra_app_registration
  }
}

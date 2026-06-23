# =============================================================================
# Azure AI Foundry Module - Outputs
# =============================================================================

# -----------------------------------------------------------------------------
# AI Services Account (Foundry Resource) Outputs
# -----------------------------------------------------------------------------

output "ai_services_id" {
  description = "The resource ID of the AI Services account"
  value       = azapi_resource.ai_services.id
}

output "ai_services_name" {
  description = "The name of the AI Services account"
  value       = azapi_resource.ai_services.name
}

output "ai_services_principal_id" {
  description = "The principal ID of the AI Services managed identity"
  value       = try(azapi_resource.ai_services.identity[0].principal_id, null)
}

# -----------------------------------------------------------------------------
# Foundry Project Outputs
# -----------------------------------------------------------------------------

output "project_id" {
  description = "The resource ID of the Foundry Project"
  value       = azapi_resource.project.id
}

output "project_name" {
  description = "The name of the Foundry Project"
  value       = azapi_resource.project.name
}

output "project_principal_id" {
  description = "The principal ID of the Foundry Project managed identity"
  value       = try(azapi_resource.project.identity[0].principal_id, null)
}

# -----------------------------------------------------------------------------
# Endpoint Outputs
# -----------------------------------------------------------------------------

output "foundry_endpoint" {
  description = "The Azure AI Foundry endpoint for model inference"
  value       = "https://${var.ai_services_name}.services.ai.azure.com/"
}

output "project_endpoint" {
  description = "The Foundry Project endpoint for SDK/API access"
  value       = "https://${var.ai_services_name}.services.ai.azure.com/api/projects/${var.project_name}"
}

# -----------------------------------------------------------------------------
# Model Deployment Outputs
# -----------------------------------------------------------------------------

output "model_deployments" {
  description = "Map of model deployment names to their details"
  value = merge(
    {
      for idx, v in azapi_resource.model_deployment_first : var.model_deployments[0].deployment_name => {
        id            = v.id
        name          = v.name
        model_name    = var.model_deployments[0].model_name
        model_version = var.model_deployments[0].model_version
      }
    },
    {
      for k, v in azapi_resource.model_deployment_rest : k => {
        id            = v.id
        name          = v.name
        model_name    = v.name
        model_version = var.model_deployments[index(var.model_deployments[*].deployment_name, k)].model_version
      }
    }
  )
}

output "deployed_model_names" {
  description = "List of deployed model names (use these in API calls)"
  value       = [for d in var.model_deployments : d.deployment_name]
}

# -----------------------------------------------------------------------------
# Connection Information for Applications
# -----------------------------------------------------------------------------

output "connection_info" {
  description = "Connection information for application configuration"
  value = {
    endpoint     = "https://${var.ai_services_name}.services.ai.azure.com/"
    project_name = var.project_name
    api_version  = "2024-12-01-preview"
    deployments  = [for d in var.model_deployments : d.deployment_name]
  }
}

# -----------------------------------------------------------------------------
# Private Endpoint Outputs
# -----------------------------------------------------------------------------

output "private_endpoint_id" {
  description = "The resource ID of the AI Services private endpoint"
  value       = try(azurerm_private_endpoint.ai_services[0].id, null)
}

output "private_ip_address" {
  description = "The private IP address of the AI Services private endpoint"
  value       = try(azurerm_private_endpoint.ai_services[0].private_service_connection[0].private_ip_address, null)
}

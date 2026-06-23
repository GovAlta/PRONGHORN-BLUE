# =============================================================================
# API Management Module Outputs
# =============================================================================

output "id" {
  description = "The ID of the API Management instance"
  value       = azurerm_api_management.main.id
}

output "name" {
  description = "The name of the API Management instance"
  value       = azurerm_api_management.main.name
}

output "gateway_url" {
  description = "The gateway URL of the API Management instance"
  value       = azurerm_api_management.main.gateway_url
}

output "gateway_regional_url" {
  description = "The regional gateway URL"
  value       = azurerm_api_management.main.gateway_regional_url
}

output "developer_portal_url" {
  description = "The developer portal URL"
  value       = azurerm_api_management.main.developer_portal_url
}

output "management_api_url" {
  description = "The management API URL"
  value       = azurerm_api_management.main.management_api_url
}

output "identity_principal_id" {
  description = "The principal ID of the managed identity"
  value       = azurerm_api_management.main.identity[0].principal_id
}

output "identity_tenant_id" {
  description = "The tenant ID of the managed identity"
  value       = azurerm_api_management.main.identity[0].tenant_id
}

output "api_id" {
  description = "The ID of the API"
  value       = var.create_api ? azurerm_api_management_api.main[0].id : null
}

output "api_path" {
  description = "The path of the API"
  value       = var.create_api ? azurerm_api_management_api.main[0].path : null
}

output "openai_api_id" {
  description = "The ID of the OpenAI API"
  value       = var.create_openai_api ? azurerm_api_management_api.openai[0].id : null
}

output "openai_api_url" {
  description = "The full URL for OpenAI API through APIM"
  value       = var.create_openai_api ? "${azurerm_api_management.main.gateway_url}/openai" : null
}

output "management_public_ip_id" {
  description = "The ID of the APIM management public IP (Internal VNet mode only)"
  value       = var.virtual_network_type == "Internal" ? azurerm_public_ip.apim_mgmt[0].id : null
}

output "management_public_ip_address" {
  description = "The APIM management public IP address (Internal VNet mode only)"
  value       = var.virtual_network_type == "Internal" ? azurerm_public_ip.apim_mgmt[0].ip_address : null
}

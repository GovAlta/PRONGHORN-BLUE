# =============================================================================
# Azure Application Gateway Module - Outputs
# =============================================================================

output "id" {
  description = "The ID of the Application Gateway"
  value       = azurerm_application_gateway.this.id
}

output "name" {
  description = "The name of the Application Gateway"
  value       = azurerm_application_gateway.this.name
}

output "frontend_private_ip_address" {
  description = "The private frontend IP address of the Application Gateway"
  value       = azurerm_application_gateway.this.frontend_ip_configuration[0].private_ip_address
}

output "identity_principal_id" {
  description = "The principal ID of the system-assigned managed identity"
  value       = azurerm_application_gateway.this.identity[0].principal_id
}
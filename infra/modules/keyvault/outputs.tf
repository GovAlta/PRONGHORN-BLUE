# =============================================================================
# Key Vault Module Outputs (AVM Wrapper)
# =============================================================================

output "id" {
  description = "The ID of the Key Vault"
  value       = module.keyvault.resource_id
}

output "name" {
  description = "The name of the Key Vault"
  value       = module.keyvault.name
}

output "vault_uri" {
  description = "The URI of the Key Vault"
  value       = module.keyvault.uri
}

output "tenant_id" {
  description = "The tenant ID used by the Key Vault"
  value       = data.azurerm_client_config.current.tenant_id
}

output "secret_ids" {
  description = "Map of secret names to their versioned IDs"
  value       = { for k, v in azurerm_key_vault_secret.secrets : k => v.id }
}

output "secret_versionless_ids" {
  description = "Map of secret names to their versionless IDs (rotation-friendly; preferred for Container App Key Vault references)"
  value       = { for k, v in azurerm_key_vault_secret.secrets : k => v.versionless_id }
}

output "private_endpoint_id" {
  description = "The ID of the private endpoint (if created)"
  value       = var.private_endpoint_subnet_id != null ? module.keyvault.private_endpoints["vault"].id : null
}

output "private_endpoint_ip" {
  description = "The private IP address of the private endpoint (if created)"
  value       = var.private_endpoint_subnet_id != null ? module.keyvault.private_endpoints["vault"].private_service_connection[0].private_ip_address : null
}

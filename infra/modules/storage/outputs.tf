# =============================================================================
# Storage Module Outputs (AVM Wrapper)
# =============================================================================

output "id" {
  description = "The ID of the storage account"
  value       = module.storage_account.resource_id
}

output "name" {
  description = "The name of the storage account"
  value       = module.storage_account.name
}

output "primary_blob_endpoint" {
  description = "The primary blob endpoint"
  value       = data.azurerm_storage_account.main.primary_blob_endpoint
}

output "primary_connection_string" {
  description = "The primary connection string"
  value       = data.azurerm_storage_account.main.primary_connection_string
  sensitive   = true
}

output "primary_access_key" {
  description = "The primary access key"
  value       = data.azurerm_storage_account.main.primary_access_key
  sensitive   = true
}

output "container_names" {
  description = "List of created container names"
  value       = [for c in azurerm_storage_container.containers : c.name]
}

output "private_endpoint_id" {
  description = "The ID of the private endpoint (if created)"
  value       = var.private_endpoint_subnet_id != null ? module.storage_account.private_endpoints["blob"].id : null
}

output "private_endpoint_ip" {
  description = "The private IP address of the private endpoint (if created)"
  value       = null # PE IP not directly available from AVM azapi-based PE; use Azure Portal or DNS lookup
}

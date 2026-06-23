# =============================================================================
# Container Registry Module Outputs (AVM Wrapper)
# =============================================================================

output "id" {
  description = "The ID of the container registry"
  value       = module.acr.resource_id
}

output "name" {
  description = "The name of the container registry"
  value       = module.acr.name
}

output "login_server" {
  description = "The login server URL of the container registry"
  value       = module.acr.resource.login_server
}

output "admin_username" {
  description = "The admin username for the container registry"
  value       = module.acr.resource.admin_username
}

output "admin_password" {
  description = "The admin password for the container registry"
  value       = module.acr.resource.admin_password
  sensitive   = true
}

# =============================================================================
# Container Apps Module Outputs
# =============================================================================

# -----------------------------------------------------------------------------
# Container App Environment Outputs
# -----------------------------------------------------------------------------

output "environment_id" {
  description = "The ID of the Container App Environment"
  value       = local.container_app_environment_id
}

output "environment_name" {
  description = "The name of the Container App Environment"
  value       = var.existing_environment_id != null ? null : module.managed_environment[0].name
}

output "environment_default_domain" {
  description = "The default domain of the Container App Environment"
  value       = var.existing_environment_id != null ? null : module.managed_environment[0].default_domain
}

output "environment_static_ip" {
  description = "The static IP address of the Container App Environment"
  value       = var.existing_environment_id != null ? null : module.managed_environment[0].static_ip_address
}

# -----------------------------------------------------------------------------
# Container App Outputs
# -----------------------------------------------------------------------------

output "app_id" {
  description = "The ID of the Container App"
  value       = module.container_app.resource_id
}

output "app_name" {
  description = "The name of the Container App"
  value       = module.container_app.name
}

output "app_fqdn" {
  description = "The FQDN of the Container App"
  value       = var.enable_ingress ? trimprefix(module.container_app.fqdn_url, "https://") : null
}

output "app_url" {
  description = "The URL of the Container App"
  value       = var.enable_ingress ? module.container_app.fqdn_url : null
}

output "latest_revision_name" {
  description = "The name of the latest revision"
  value       = module.container_app.latest_revision_name
}

output "latest_revision_fqdn" {
  description = "The FQDN of the latest revision"
  value       = trimprefix(module.container_app.latest_revision_fqdn, "https://")
}

output "principal_id" {
  description = "The principal ID of the Container App's system-assigned managed identity"
  value       = module.container_app.identity[0].principal_id
}

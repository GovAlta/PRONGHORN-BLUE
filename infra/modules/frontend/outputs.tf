# =============================================================================
# Frontend Module Outputs
# =============================================================================

output "app_id" {
  description = "The ID of the Frontend Container App"
  value       = module.frontend.resource_id
}

output "app_name" {
  description = "The name of the Frontend Container App"
  value       = module.frontend.name
}

output "app_fqdn" {
  description = "The FQDN of the Frontend Container App"
  value       = trimprefix(module.frontend.fqdn_url, "https://")
}

output "app_url" {
  description = "The URL of the Frontend Container App"
  value       = module.frontend.fqdn_url
}

output "latest_revision_name" {
  description = "The name of the latest revision"
  value       = module.frontend.latest_revision_name
}

output "principal_id" {
  description = "The principal ID of the Frontend Container App's system-assigned managed identity"
  value       = module.frontend.identity[0].principal_id
}

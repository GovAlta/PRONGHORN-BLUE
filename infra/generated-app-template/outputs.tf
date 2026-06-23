output "fqdn" {
  description = "Container app FQDN"
  value       = module.container_app.fqdn
}

output "app_url" {
  description = "Full app URL"
  value       = "https://${module.container_app.fqdn}"
}

output "resource_group" {
  description = "Resource group name"
  value       = module.resource_group.name
}

output "container_app_name" {
  description = "Container app name"
  value       = module.container_app.app_name
}

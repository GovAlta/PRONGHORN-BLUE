output "fqdn" {
  description = "Container app FQDN"
  value       = azurerm_container_app.this.ingress[0].fqdn
}

output "app_id" {
  description = "Container app resource ID"
  value       = azurerm_container_app.this.id
}

output "app_name" {
  description = "Container app name"
  value       = azurerm_container_app.this.name
}

output "uami_id" {
  description = "User-assigned managed identity resource ID"
  value       = azurerm_user_assigned_identity.this.id
}

output "uami_principal_id" {
  description = "User-assigned managed identity principal ID"
  value       = azurerm_user_assigned_identity.this.principal_id
}

# =============================================================================
# Entra ID App Registration Module Outputs
# =============================================================================

output "client_id" {
  description = "The Application (Client) ID of the Entra App Registration"
  value       = azuread_application.this.client_id
}

output "object_id" {
  description = "The Object ID of the Entra App Registration"
  value       = azuread_application.this.object_id
}

output "tenant_id" {
  description = "The Tenant ID where the App Registration was created"
  value       = data.azuread_client_config.current.tenant_id
}

output "service_principal_id" {
  description = "The Object ID of the Service Principal (Enterprise Application)"
  value       = azuread_service_principal.this.object_id
}

output "application_id_uri" {
  description = "The Application ID URI (api://{client-id})"
  value       = var.expose_api_scope ? "api://${azuread_application.this.client_id}" : null
}

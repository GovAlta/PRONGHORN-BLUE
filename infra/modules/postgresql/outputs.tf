# =============================================================================
# PostgreSQL Module Outputs
# =============================================================================

output "server_id" {
  description = "The ID of the PostgreSQL server"
  value       = module.postgresql_server.resource_id
}

output "server_name" {
  description = "The name of the PostgreSQL server"
  value       = module.postgresql_server.name
}

output "server_fqdn" {
  description = "The fully qualified domain name of the PostgreSQL server"
  value       = module.postgresql_server.fqdn
}

output "database_id" {
  description = "The ID of the PostgreSQL database"
  value       = module.postgresql_server.database_resource_ids["main"].resource_id
}

output "database_name" {
  description = "The name of the PostgreSQL database"
  value       = module.postgresql_server.database_name["main"].name
}

output "administrator_login" {
  description = "The administrator login for the PostgreSQL server"
  value       = var.administrator_login
}

output "connection_string" {
  description = "PostgreSQL connection string (without password)"
  value       = "postgresql://${var.administrator_login}@${module.postgresql_server.fqdn}:5432/${var.database_name}?sslmode=require"
  sensitive   = true
}

output "azure_portal_url" {
  description = "Azure Portal URL for the PostgreSQL Server"
  value       = "https://portal.azure.com/#@/resource${module.postgresql_server.resource_id}/overview"
}

output "private_networking_enabled" {
  description = "Whether private networking is enabled"
  value       = local.use_private_networking
}

output "vnet_id" {
  description = "The VNet ID (if using private networking)"
  value       = var.vnet_id
}

output "delegated_subnet_id" {
  description = "The delegated subnet ID (if using private networking)"
  value       = var.delegated_subnet_id
}

output "private_dns_zone_id" {
  description = "The private DNS zone ID (if using private networking)"
  value       = var.private_dns_zone_id
}

output "public_network_access_enabled" {
  description = "Whether public network access is enabled"
  value       = !local.use_private_networking
}

output "private_endpoint_id" {
  description = "The ID of the private endpoint (if created)"
  value       = local.use_private_endpoint && !local.use_private_networking ? module.postgresql_server.private_endpoints["postgresql"].id : null
}

output "private_endpoint_ip" {
  description = "The private IP address of the private endpoint"
  value       = local.use_private_endpoint && !local.use_private_networking ? module.postgresql_server.private_endpoints["postgresql"].private_service_connection[0].private_ip_address : null
}

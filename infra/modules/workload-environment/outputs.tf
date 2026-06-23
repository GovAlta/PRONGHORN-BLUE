# =============================================================================
# Workload Environment Module Outputs
# =============================================================================

output "environment_id" {
  description = "The ID of the workload Container App Environment"
  value       = module.workload_environment.resource_id
}

output "environment_name" {
  description = "The name of the workload Container App Environment"
  value       = module.workload_environment.name
}

output "default_domain" {
  description = "The default domain of the workload Container App Environment"
  value       = module.workload_environment.default_domain
}

output "static_ip" {
  description = "The static IP address of the workload Container App Environment"
  value       = module.workload_environment.static_ip_address
}

# =============================================================================
# Logging Module Outputs (AVM Wrapper)
# =============================================================================

# -----------------------------------------------------------------------------
# Log Analytics Outputs
# -----------------------------------------------------------------------------

output "log_analytics_id" {
  description = "The ID of the Log Analytics workspace"
  value       = module.log_analytics.resource_id
}

output "log_analytics_name" {
  description = "The name of the Log Analytics workspace"
  value       = module.log_analytics.resource.name
}

output "log_analytics_workspace_id" {
  description = "The workspace ID of the Log Analytics workspace"
  value       = module.log_analytics.resource.workspace_id
}

output "log_analytics_primary_shared_key" {
  description = "The primary shared key for Log Analytics"
  value       = module.log_analytics.resource.primary_shared_key
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Application Insights Outputs
# -----------------------------------------------------------------------------

output "app_insights_id" {
  description = "The ID of Application Insights"
  value       = module.app_insights.resource_id
}

output "app_insights_name" {
  description = "The name of Application Insights"
  value       = module.app_insights.name
}

output "app_insights_instrumentation_key" {
  description = "The instrumentation key for Application Insights"
  value       = module.app_insights.resource.instrumentation_key
  sensitive   = true
}

output "app_insights_connection_string" {
  description = "The connection string for Application Insights"
  value       = module.app_insights.resource.connection_string
  sensitive   = true
}

# =============================================================================
# Logging Module (AVM Wrapper)
# =============================================================================
# This module wraps Azure Verified Modules for:
# - Log Analytics Workspace (avm-res-operationalinsights-workspace)
# - Application Insights (avm-res-insights-component)
# =============================================================================

# -----------------------------------------------------------------------------
# Log Analytics Workspace (AVM)
# -----------------------------------------------------------------------------

module "log_analytics" {
  source  = "Azure/avm-res-operationalinsights-workspace/azurerm"
  version = "0.5.1"

  name                = var.log_analytics_name
  location            = var.location
  resource_group_name = var.resource_group_name

  log_analytics_workspace_sku               = var.log_analytics_sku
  log_analytics_workspace_retention_in_days = var.retention_in_days

  enable_telemetry = false
  tags             = local.common_tags
}

# -----------------------------------------------------------------------------
# Application Insights (AVM)
# -----------------------------------------------------------------------------

module "app_insights" {
  source  = "Azure/avm-res-insights-component/azurerm"
  version = "0.3.0"

  name                = var.app_insights_name
  location            = var.location
  resource_group_name = var.resource_group_name
  workspace_id        = module.log_analytics.resource_id
  application_type    = var.application_type

  enable_telemetry = false
  tags             = local.common_tags
}

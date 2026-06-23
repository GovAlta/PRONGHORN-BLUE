# =============================================================================
# Logging Module Variables
# =============================================================================

# -----------------------------------------------------------------------------
# Required Variables
# -----------------------------------------------------------------------------

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "location" {
  description = "Azure region for resources"
  type        = string
}

variable "log_analytics_name" {
  description = "Name of the Log Analytics workspace"
  type        = string
}

variable "app_insights_name" {
  description = "Name of the Application Insights resource"
  type        = string
}

# -----------------------------------------------------------------------------
# Log Analytics Configuration
# -----------------------------------------------------------------------------

variable "log_analytics_sku" {
  description = "SKU for Log Analytics workspace"
  type        = string
  default     = "PerGB2018"
}

variable "retention_in_days" {
  description = "Data retention in days"
  type        = number
  default     = 30
}

# -----------------------------------------------------------------------------
# Application Insights Configuration
# -----------------------------------------------------------------------------

variable "application_type" {
  description = "Application type for Application Insights"
  type        = string
  default     = "web"
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

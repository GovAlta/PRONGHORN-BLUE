# =============================================================================
# Workload Environment Module Variables
# =============================================================================

variable "environment_name" {
  description = "Name of the workload Container App Environment"
  type        = string
}

variable "resource_group_name" {
  description = "Resource group for the workload environment"
  type        = string
}

variable "subscription_id" {
  description = "Azure subscription ID (used to construct stable resource group IDs)"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}

variable "log_analytics_workspace_id" {
  description = "Log Analytics workspace ID for environment logs"
  type        = string
}

variable "infrastructure_subnet_id" {
  description = "Infrastructure subnet ID for VNet integration (requires /21 or larger, delegated to Microsoft.App/environments)"
  type        = string
  default     = null
}

variable "internal_load_balancer_enabled" {
  description = "Enable internal-only load balancer"
  type        = bool
  default     = true
}

variable "private_endpoint_subnet_id" {
  description = "Subnet ID for private endpoint"
  type        = string
  default     = null
}

variable "private_dns_zone_id" {
  description = "Private DNS Zone ID for the environment"
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

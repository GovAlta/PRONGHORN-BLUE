# =============================================================================
# Azure AI Foundry Module - Variables
# =============================================================================

# -----------------------------------------------------------------------------
# Required Variables
# -----------------------------------------------------------------------------

variable "resource_group_name" {
  description = "Name of the resource group where AI Services will be deployed"
  type        = string
}

variable "subscription_id" {
  description = "Azure subscription ID (used to construct stable resource group IDs)"
  type        = string
}

variable "location" {
  description = "Azure region for the AI Services account"
  type        = string
}

variable "ai_services_name" {
  description = "Name of the AI Services account (must be globally unique, lowercase alphanumeric)"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$", var.ai_services_name))
    error_message = "AI Services name must be 3-64 characters, lowercase alphanumeric with hyphens allowed (not at start/end)."
  }
}

# -----------------------------------------------------------------------------
# Project Configuration (NEW Foundry Architecture)
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Name of the Foundry Project (child of AI Services account)"
  type        = string
  default     = "default-project"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$", var.project_name))
    error_message = "Project name must be 3-64 characters, lowercase alphanumeric with hyphens allowed."
  }
}

variable "project_display_name" {
  description = "Display name for the Foundry Project"
  type        = string
  default     = ""
}

variable "project_description" {
  description = "Description for the Foundry Project"
  type        = string
  default     = "Azure AI Foundry Project for AI development"
}

variable "enable_agent_service" {
  description = "Enable the Agent service by creating capability hosts"
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# SKU Configuration
# -----------------------------------------------------------------------------

variable "sku_name" {
  description = "SKU name for the AI Services account (S0 is standard)"
  type        = string
  default     = "S0"

  validation {
    condition     = contains(["F0", "S0"], var.sku_name)
    error_message = "SKU name must be F0 (free) or S0 (standard)."
  }
}

# -----------------------------------------------------------------------------
# Model Deployments
# -----------------------------------------------------------------------------

variable "model_deployments" {
  description = "List of AI model deployments to create"
  type = list(object({
    deployment_name        = string
    model_name             = string
    model_version          = string
    model_format           = optional(string, "OpenAI")
    sku_name               = optional(string, "GlobalStandard")
    sku_capacity           = optional(number, 10)
    rai_policy_name        = optional(string, "Microsoft.Default")
    version_upgrade_option = optional(string, "OnceCurrentVersionExpired")
  }))
  default = []
}

# -----------------------------------------------------------------------------
# Network Configuration
# -----------------------------------------------------------------------------

variable "public_network_access" {
  description = "Enable public network access to the AI Services account"
  type        = bool
  default     = true
}

variable "disable_local_auth" {
  description = "Disable local (key-based) authentication"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Monitoring Configuration
# -----------------------------------------------------------------------------

variable "log_analytics_workspace_id" {
  description = "Log Analytics Workspace ID for diagnostic logs"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Private Endpoint Configuration
# -----------------------------------------------------------------------------

variable "private_endpoint_subnet_id" {
  description = "Subnet ID for AI Services private endpoint. If provided, a private endpoint will be created."
  type        = string
  default     = null
}

variable "private_endpoint_location" {
  description = "Location for the private endpoint (must be the VNet region, may differ from AI Services region)"
  type        = string
  default     = null
}

variable "private_dns_zone_id" {
  description = "DEPRECATED: Use private_dns_zone_ids instead. Single Private DNS Zone ID for backward compatibility."
  type        = string
  default     = null
}

variable "private_dns_zone_ids" {
  description = "List of Private DNS Zone IDs for AI Foundry private endpoint. AIServices typically needs both privatelink.cognitiveservices.azure.com and privatelink.openai.azure.com."
  type        = list(string)
  default     = null
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

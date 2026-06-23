# =============================================================================
# API Management Module Variables
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

variable "apim_name" {
  description = "Name of the API Management instance"
  type        = string
}

variable "publisher_name" {
  description = "Publisher name for APIM"
  type        = string
}

variable "publisher_email" {
  description = "Publisher email for APIM"
  type        = string
}

# -----------------------------------------------------------------------------
# APIM Configuration
# -----------------------------------------------------------------------------

variable "sku_name" {
  description = "SKU for API Management (Consumption_0, Developer_1, Basic_1, Standard_1, Premium_1)"
  type        = string
  default     = "Consumption_0"
}

# -----------------------------------------------------------------------------
# Application Insights Integration
# -----------------------------------------------------------------------------

variable "app_insights_id" {
  description = "Application Insights resource ID for logging"
  type        = string
  default     = null
}

variable "app_insights_instrumentation_key" {
  description = "Application Insights instrumentation key"
  type        = string
  default     = null
  sensitive   = true
}

variable "enable_diagnostics" {
  description = "Enable Application Insights diagnostics"
  type        = bool
  default     = true
}

variable "diagnostics_sampling_percentage" {
  description = "Sampling percentage for diagnostics (0-100)"
  type        = number
  default     = 100
}

variable "diagnostics_verbosity" {
  description = "Verbosity level for diagnostics (verbose, information, error)"
  type        = string
  default     = "information"
}

# -----------------------------------------------------------------------------
# API Configuration
# -----------------------------------------------------------------------------

variable "create_api" {
  description = "Create an API definition"
  type        = bool
  default     = true
}

variable "api_name" {
  description = "Name of the API"
  type        = string
  default     = "api"
}

variable "api_display_name" {
  description = "Display name of the API"
  type        = string
  default     = "API"
}

variable "api_revision" {
  description = "API revision"
  type        = string
  default     = "1"
}

variable "api_path" {
  description = "API path prefix"
  type        = string
  default     = "api"
}

variable "api_protocols" {
  description = "API protocols"
  type        = list(string)
  default     = ["https"]
}

variable "subscription_required" {
  description = "Require subscription key for API"
  type        = bool
  default     = false
}

variable "backend_url" {
  description = "Backend service URL"
  type        = string
  default     = null
}

variable "openapi_spec_url" {
  description = "URL to OpenAPI specification for import"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# API Policy
# -----------------------------------------------------------------------------

variable "api_policy_xml" {
  description = "XML content for API policy (overrides generated policy if set)"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Entra ID (Azure AD) Authentication
# -----------------------------------------------------------------------------

variable "azure_tenant_id" {
  description = "Azure Entra ID tenant ID for JWT validation"
  type        = string
  default     = null
}

variable "azure_client_id" {
  description = "Azure Entra ID application (client) ID for JWT validation audience"
  type        = string
  default     = null
}

variable "enable_entra_auth" {
  description = "Whether Entra ID auth is enabled (plan-time known). Controls policy resource count."
  type        = bool
  default     = false
}

variable "cors_allowed_origins" {
  description = "List of allowed origins for CORS. If empty, CORS policy is not added."
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# VNet Integration
# -----------------------------------------------------------------------------

variable "virtual_network_type" {
  description = "VNet integration type for APIM: None, External, or Internal"
  type        = string
  default     = "None"
  validation {
    condition     = contains(["None", "External", "Internal"], var.virtual_network_type)
    error_message = "virtual_network_type must be None, External, or Internal."
  }
}

variable "subnet_id" {
  description = "Subnet ID for APIM VNet integration (required when virtual_network_type is External or Internal)"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# OpenAI/AI Foundry API Configuration
# -----------------------------------------------------------------------------

variable "create_openai_api" {
  description = "Create an OpenAI API proxy to Azure AI Foundry"
  type        = bool
  default     = false
}

variable "openai_backend_url" {
  description = "Backend URL for Azure OpenAI/AI Foundry endpoint"
  type        = string
  default     = null
}

variable "openai_api_version" {
  description = "Azure OpenAI API version"
  type        = string
  default     = "2025-04-01-preview"
}

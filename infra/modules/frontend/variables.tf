# =============================================================================
# Frontend Module Variables
# =============================================================================

# -----------------------------------------------------------------------------
# Required Variables
# -----------------------------------------------------------------------------

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "location" {
  description = "Azure region for the container app (must be explicit to prevent ForceNew on azapi_resource)"
  type        = string
}

variable "subscription_id" {
  description = "Azure subscription ID (used to construct stable resource group IDs)"
  type        = string
}

variable "container_app_name" {
  description = "Name of the Container App"
  type        = string
}

variable "container_app_environment_id" {
  description = "ID of the Container App Environment"
  type        = string
}

variable "container_image" {
  description = "Container image to deploy"
  type        = string
}

# -----------------------------------------------------------------------------
# Container Configuration
# -----------------------------------------------------------------------------

variable "container_name" {
  description = "Name of the container"
  type        = string
  default     = "frontend"
}

variable "container_cpu" {
  description = "CPU cores allocated to container"
  type        = number
  default     = 0.25
}

variable "container_memory" {
  description = "Memory allocated to container"
  type        = string
  default     = "0.5Gi"
}

variable "target_port" {
  description = "Port the container listens on"
  type        = number
  default     = 80
}

variable "revision_mode" {
  description = "Revision mode (Single or Multiple)"
  type        = string
  default     = "Single"
}

# -----------------------------------------------------------------------------
# Scaling
# -----------------------------------------------------------------------------

variable "min_replicas" {
  description = "Minimum number of replicas"
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "Maximum number of replicas"
  type        = number
  default     = 5
}

# -----------------------------------------------------------------------------
# Environment Variables
# -----------------------------------------------------------------------------

variable "environment_variables" {
  description = "Map of environment variable name to value"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Secrets
# -----------------------------------------------------------------------------

variable "secrets" {
  description = "Map of secret name to value"
  type        = map(string)
  default     = {}
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Container Registry
# -----------------------------------------------------------------------------

variable "registry_server" {
  description = "Container registry server URL"
  type        = string
  default     = null
}

variable "use_managed_identity_for_acr" {
  description = "Use managed identity for ACR authentication instead of admin credentials"
  type        = bool
  default     = false
}

variable "user_assigned_identity_id" {
  description = "Resource ID of a user-assigned managed identity for ACR pull. When set, the container app uses this UAMI for registry auth instead of its system-assigned identity, avoiding the bootstrap race."
  type        = string
  default     = null
}

variable "registry_username" {
  description = "Container registry username (only used when use_managed_identity_for_acr is false)"
  type        = string
  default     = null
}

variable "registry_password_secret_name" {
  description = "Name of secret containing registry password (only used when use_managed_identity_for_acr is false)"
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

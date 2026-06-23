# =============================================================================
# Container Apps Module Variables
# =============================================================================

# -----------------------------------------------------------------------------
# Required Variables
# -----------------------------------------------------------------------------

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "subscription_id" {
  description = "Azure subscription ID (used to construct stable resource group IDs)"
  type        = string
}

variable "location" {
  description = "Azure region for resources"
  type        = string
}

variable "environment_name" {
  description = "Name of the Container App Environment"
  type        = string
}

variable "container_app_name" {
  description = "Name of the Container App"
  type        = string
}

variable "log_analytics_workspace_id" {
  description = "ID of the Log Analytics workspace for monitoring"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Existing Environment (optional)
# -----------------------------------------------------------------------------

variable "existing_environment_id" {
  description = "ID of an existing Container App Environment to use. If provided, a new environment will not be created."
  type        = string
  default     = null
}

variable "environment_resource_group_name" {
  description = "Resource group for the Container App Environment. Defaults to resource_group_name if not specified. Only used when creating a new environment."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Environment Certificates
# -----------------------------------------------------------------------------

variable "certificates" {
  description = "Map of certificate name to certificate configuration for the Container App Environment"
  type = map(object({
    certificate_blob_base64 = string
    certificate_password    = string
  }))
  default = {}
}

# -----------------------------------------------------------------------------
# Environment Private Endpoint
# -----------------------------------------------------------------------------

variable "environment_private_endpoint_subnet_id" {
  description = "Subnet ID for Container App Environment private endpoint. Only used when creating a new environment."
  type        = string
  default     = null
}

variable "environment_private_dns_zone_id" {
  description = "Private DNS Zone ID for Container App Environment. Required when using environment private endpoint."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# VNet Integration
# -----------------------------------------------------------------------------

variable "infrastructure_subnet_id" {
  description = "The ID of the subnet for Container App Environment infrastructure (requires /21 or larger)"
  type        = string
  default     = null
}

variable "internal_load_balancer_enabled" {
  description = "Enable internal load balancer (requires infrastructure_subnet_id)"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Container Configuration
# -----------------------------------------------------------------------------

variable "container_name" {
  description = "Name of the container"
  type        = string
  default     = "app"
}

variable "container_image" {
  description = "Container image to deploy"
  type        = string
}

variable "container_cpu" {
  description = "CPU cores allocated to container"
  type        = number
  default     = 0.5
}

variable "container_memory" {
  description = "Memory allocated to container"
  type        = string
  default     = "1Gi"
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
  default     = 0
}

variable "max_replicas" {
  description = "Maximum number of replicas"
  type        = number
  default     = 10
}

# -----------------------------------------------------------------------------
# Environment Variables
# -----------------------------------------------------------------------------

variable "environment_variables" {
  description = "Map of environment variable name to value"
  type        = map(string)
  default     = {}
}

variable "secret_environment_variables" {
  description = "Map of environment variable name to secret name"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Secrets
# -----------------------------------------------------------------------------

variable "secrets" {
  description = "Map of secret name to value (plaintext secrets stored directly in the Container App)"
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "secret_key_vault_references" {
  description = "Map of secret name to Key Vault secret reference. Each entry becomes a Container App secret backed by Key Vault, resolved at runtime via secret_identity_id."
  type = map(object({
    key_vault_secret_id = string
  }))
  default = {}
}

variable "secret_identity_id" {
  description = "Resource ID of the user-assigned managed identity used to authenticate Key Vault secret references. Required when secret_key_vault_references is set."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Ingress
# -----------------------------------------------------------------------------

variable "enable_ingress" {
  description = "Enable ingress for the container app"
  type        = bool
  default     = true
}

variable "external_ingress" {
  description = "Allow external traffic"
  type        = bool
  default     = true
}

variable "target_port" {
  description = "Port the container listens on"
  type        = number
  default     = 8080
}

variable "ingress_transport" {
  description = "Ingress transport protocol (http, http2, auto)"
  type        = string
  default     = "http"
}

# -----------------------------------------------------------------------------
# Health Probes
# -----------------------------------------------------------------------------

variable "liveness_probe" {
  description = "Liveness probe configuration"
  type = object({
    path             = string
    port             = number
    transport        = string
    interval_seconds = number
  })
  default = null
}

variable "readiness_probe" {
  description = "Readiness probe configuration"
  type = object({
    path             = string
    port             = number
    transport        = string
    interval_seconds = number
  })
  default = null
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
  description = "Resource ID of a user-assigned managed identity for ACR pull. When set, the container app uses this UAMI for registry auth instead of its system-assigned identity, avoiding the bootstrap race where AcrPull can only be granted after the app exists."
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

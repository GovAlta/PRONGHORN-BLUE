variable "app_name" {
  description = "Container app name (max 32 chars, lowercase alphanumeric + hyphens)"
  type        = string

  validation {
    condition     = length(var.app_name) <= 32 && can(regex("^[a-z][a-z0-9-]*$", var.app_name))
    error_message = "App name must be <= 32 chars, lowercase, start with letter, alphanumeric + hyphens only."
  }
}

variable "resource_group_name" {
  description = "Resource group name for the container app"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}

variable "container_app_environment_id" {
  description = "Resource ID of the shared ACA environment"
  type        = string
}

variable "acr_id" {
  description = "Resource ID of the shared ACR (for AcrPull role assignment)"
  type        = string
}

variable "acr_login_server" {
  description = "ACR login server URL (e.g., myacr.azurecr.io)"
  type        = string
}

variable "image_name" {
  description = "Docker image name in ACR (without tag)"
  type        = string
}

variable "image_tag" {
  description = "Docker image tag"
  type        = string
  default     = "latest"
}

variable "image" {
  description = "Full image reference to deploy initially (e.g. a public placeholder). When empty, it is composed from acr_login_server/image_name:image_tag."
  type        = string
  default     = ""
}

variable "target_port" {
  description = "Container port to expose via ingress"
  type        = number
  default     = 80
}

variable "cpu" {
  description = "CPU cores for the container"
  type        = number
  default     = 0.5
}

variable "memory" {
  description = "Memory for the container"
  type        = string
  default     = "1Gi"
}

variable "min_replicas" {
  description = "Minimum number of replicas"
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "Maximum number of replicas"
  type        = number
  default     = 2
}

variable "environment_variables" {
  description = "Map of environment variable name to value"
  type        = map(string)
  default     = {}
}

variable "key_vault_name" {
  description = "Name of the per-deployment Azure Key Vault holding env-var / secret values. When empty, no Key Vault-backed secrets are wired into the container."
  type        = string
  default     = ""
}

variable "key_vault_resource_group" {
  description = "Resource group that contains the per-deployment Key Vault (shared platform resource group)."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Resource tags"
  type        = map(string)
  default     = {}
}

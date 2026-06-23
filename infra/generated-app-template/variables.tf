variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "app_name" {
  description = "Generated app name (final container app name, computed by Pronghorn)"
  type        = string
}

variable "resource_group" {
  description = "Resource group name (computed by Pronghorn; must match DB metadata)"
  type        = string
}

variable "app_id" {
  description = "Unique app identifier (UUID)"
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev, uat, prod)"
  type        = string
  default     = "dev"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "canadacentral"
}

variable "image_name" {
  description = "Docker image name in ACR"
  type        = string
}

variable "image_tag" {
  description = "Docker image tag"
  type        = string
  default     = "latest"
}

variable "image" {
  description = "Fully-qualified image reference built by the deploy workflow (e.g. <acr>/<app>:<run_id>). When empty, the public placeholder is used so the container app can be created before the real image exists."
  type        = string
  default     = ""
}

# Shared resource references (populated by Pronghorn at deploy time)

variable "acr_id" {
  description = "Resource ID of the shared ACR"
  type        = string
}

variable "acr_login_server" {
  description = "ACR login server URL"
  type        = string
}

variable "container_app_environment_id" {
  description = "Resource ID of the shared ACA environment"
  type        = string
}

variable "env_vars" {
  description = "Application environment variables (plaintext, non-secret). User-set env vars + secrets are sourced from the per-deployment Key Vault."
  type        = map(string)
  default     = {}
}

variable "key_vault_name" {
  description = "Name of the per-deployment Azure Key Vault holding env-var / secret values. Created and owned by the Pronghorn backend; Terraform consumes it. When empty, no Key Vault-backed secrets are wired into the container."
  type        = string
  default     = ""
}

variable "key_vault_resource_group" {
  description = "Resource group that contains the per-deployment Key Vault (shared platform resource group)."
  type        = string
  default     = ""
}

variable "compliance_tags" {
  description = "PBMM compliance tags inherited from the platform resource group (e.g. ClientOrganization, CostCenter). Discovered at deploy time."
  type        = map(string)
  default     = {}
}

variable "placeholder_image" {
  description = "Public placeholder image used at create time; the real image is set by the build job after the container app exists."
  type        = string
  default     = "mcr.microsoft.com/k8se/quickstart:latest"
}

variable "target_port" {
  description = "Container port the app listens on (ingress target port)"
  type        = number
  default     = 80
}

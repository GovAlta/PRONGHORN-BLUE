# =============================================================================
# Storage Module Variables
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

variable "storage_account_name" {
  description = "Name of the storage account (must be globally unique, lowercase alphanumeric)"
  type        = string
}

# -----------------------------------------------------------------------------
# Storage Account Configuration
# -----------------------------------------------------------------------------

variable "account_tier" {
  description = "Storage account tier (Standard or Premium)"
  type        = string
  default     = "Standard"
}

variable "replication_type" {
  description = "Storage replication type (LRS, GRS, RAGRS, ZRS)"
  type        = string
  default     = "LRS"
}

variable "min_tls_version" {
  description = "Minimum TLS version"
  type        = string
  default     = "TLS1_2"
}

variable "shared_access_key_enabled" {
  description = "Enable shared access key authentication"
  type        = bool
  default     = true
}

variable "dns_registration_wait_minutes" {
  description = "Minutes to wait after private endpoint creation before performing data-plane operations (e.g. container creation). Required in environments where central Private DNS registration runs on a schedule (e.g. GoA PBMM 15-min auto-registration). Set to 0 to disable the wait."
  type        = number
  default     = 20
}

variable "allow_public_blobs" {
  description = "Allow public access to blobs"
  type        = bool
  default     = false
}

variable "public_network_access_enabled" {
  description = "Enable public network access to storage account. Set to false for Landing Zone deployments with private endpoints."
  type        = bool
  default     = true
}

variable "enable_deployer_blob_access" {
  description = "Grant Storage Blob Data Contributor role to deployer"
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# CORS Configuration
# -----------------------------------------------------------------------------

variable "cors_rules" {
  description = "CORS rules for blob storage"
  type = list(object({
    allowed_headers    = list(string)
    allowed_methods    = list(string)
    allowed_origins    = list(string)
    exposed_headers    = list(string)
    max_age_in_seconds = number
  }))
  default = []
}

# -----------------------------------------------------------------------------
# Containers
# -----------------------------------------------------------------------------

variable "containers" {
  description = "Map of container names to configuration"
  type = map(object({
    access_type = string # private, blob, or container
  }))
  default = {}
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
# Private Endpoint Configuration
# -----------------------------------------------------------------------------

variable "private_endpoint_subnet_id" {
  description = "Subnet ID for Storage private endpoint. If provided, a private endpoint will be created."
  type        = string
  default     = null
}

variable "private_dns_zone_id" {
  description = "Private DNS Zone ID for Storage blob (privatelink.blob.core.windows.net). Required when using private endpoint."
  type        = string
  default     = null
}

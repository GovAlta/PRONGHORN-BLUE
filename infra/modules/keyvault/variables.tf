# =============================================================================
# Key Vault Module Variables
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

variable "key_vault_name" {
  description = "Name of the Key Vault (must be globally unique)"
  type        = string
}

# -----------------------------------------------------------------------------
# Key Vault Configuration
# -----------------------------------------------------------------------------

variable "sku_name" {
  description = "SKU name for Key Vault (standard or premium)"
  type        = string
  default     = "standard"

  validation {
    condition     = contains(["standard", "premium"], var.sku_name)
    error_message = "SKU must be standard or premium."
  }
}

variable "soft_delete_retention_days" {
  description = "Number of days to retain soft-deleted items"
  type        = number
  default     = 7
}

variable "purge_protection_enabled" {
  description = "Enable purge protection"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# RBAC Access (Azure role assignments, data-plane)
# -----------------------------------------------------------------------------

variable "secrets_user_principal_ids" {
  description = "Principal IDs (managed identities / service principals) to grant the 'Key Vault Secrets User' role (read-only secret access). Used so container apps can resolve Key Vault references at runtime."
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# Secrets
# -----------------------------------------------------------------------------

variable "secrets" {
  description = "Map of secrets to create in the Key Vault"
  type        = map(string)
  default     = {}
  sensitive   = true
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
# Network Security
# -----------------------------------------------------------------------------

variable "public_network_access_enabled" {
  description = "Enable public network access to Key Vault"
  type        = bool
  default     = true # Set to false for production with private endpoints
}

variable "network_default_action" {
  description = "Default action for network rules (Allow or Deny)"
  type        = string
  default     = "Allow" # Set to Deny for production

  validation {
    condition     = contains(["Allow", "Deny"], var.network_default_action)
    error_message = "Network default action must be Allow or Deny."
  }
}

variable "allowed_ip_ranges" {
  description = "List of IP ranges allowed to access Key Vault (CIDR notation)"
  type        = list(string)
  default     = []
}

variable "allowed_subnet_ids" {
  description = "List of subnet IDs allowed to access Key Vault"
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# Private Endpoint Configuration
# -----------------------------------------------------------------------------

variable "private_endpoint_subnet_id" {
  description = "Subnet ID for Key Vault private endpoint. If provided, a private endpoint will be created."
  type        = string
  default     = null
}

variable "private_dns_zone_id" {
  description = "Private DNS Zone ID for Key Vault (privatelink.vaultcore.azure.net). Required when using private endpoint."
  type        = string
  default     = null
}

variable "private_endpoint_dns_wait" {
  description = "Configuration for waiting on Azure Policy to attach the DNS zone group to the Key Vault private endpoint. Set enabled=true in PBMM/landing-zone environments where a DeployIfNotExists policy manages the zone group asynchronously, so secret writes do not race ahead of DNS A-record registration."
  type = object({
    enabled  = bool
    timeout  = string
    interval = string
  })
  default = {
    enabled  = false
    timeout  = "10m"
    interval = "10s"
  }
}

# =============================================================================
# Container Registry Module Variables
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

variable "registry_name" {
  description = "Name of the container registry (must be globally unique, alphanumeric only)"
  type        = string
}

# -----------------------------------------------------------------------------
# Registry Configuration
# -----------------------------------------------------------------------------

variable "sku" {
  description = "SKU for the container registry (Basic, Standard, Premium)"
  type        = string
  default     = "Basic"

  validation {
    condition     = contains(["Basic", "Standard", "Premium"], var.sku)
    error_message = "SKU must be Basic, Standard, or Premium."
  }
}

variable "admin_enabled" {
  description = "Enable admin user for the registry. Should be false when using managed identity for ACR pulls."
  type        = bool
  default     = false
}

variable "public_network_access_enabled" {
  description = "Enable public network access to the registry"
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Private Endpoint (optional)
# -----------------------------------------------------------------------------

variable "private_endpoint_subnet_id" {
  description = "Subnet ID for ACR private endpoint. If provided, a private endpoint will be created."
  type        = string
  default     = null
}

variable "private_dns_zone_id" {
  description = "Private DNS Zone ID for ACR (privatelink.azurecr.io). Required when using private endpoint."
  type        = string
  default     = null
}

variable "private_endpoint_location" {
  description = "Location for the private endpoint. Defaults to the registry location if not specified."
  type        = string
  default     = null
}

variable "private_endpoint_resource_group_name" {
  description = "Resource group for the private endpoint. Defaults to the registry resource group if not specified."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Geo-replication (Premium SKU only)
# -----------------------------------------------------------------------------

variable "georeplications" {
  description = "Geo-replication locations for Premium SKU"
  type = list(object({
    location                = string
    zone_redundancy_enabled = bool
  }))
  default = []
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

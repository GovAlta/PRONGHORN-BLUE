# =============================================================================
# PostgreSQL Module Variables
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

variable "server_name" {
  description = "Name of the PostgreSQL Flexible Server"
  type        = string
}

variable "database_name" {
  description = "Name of the PostgreSQL database"
  type        = string
}

variable "administrator_login" {
  description = "Administrator login for PostgreSQL"
  type        = string
}

variable "administrator_password" {
  description = "Break-glass administrator password override. Leave null to use the write-only password sourced from Key Vault (administrator_password_wo). When set, bump administrator_password_wo_version so the change is applied."
  type        = string
  sensitive   = true
  default     = null
}

variable "administrator_password_wo" {
  description = "Write-only administrator password (never stored in Terraform state). Sourced from an ephemeral Key Vault read by the root module."
  type        = string
  sensitive   = true
  ephemeral   = true
  default     = null
}

variable "administrator_password_wo_version" {
  description = "Version integer for the write-only administrator password. Increment to force the server password to be re-sent (rotation / break-glass)."
  type        = number
  default     = 1
}

# -----------------------------------------------------------------------------
# Server Configuration
# -----------------------------------------------------------------------------

variable "postgresql_version" {
  description = "PostgreSQL version"
  type        = string
  default     = "16"
}

variable "sku_name" {
  description = "SKU name for PostgreSQL Flexible Server"
  type        = string
  default     = "B_Standard_B2s"
}

variable "storage_mb" {
  description = "Storage size in MB for PostgreSQL"
  type        = number
  default     = 32768
}

variable "availability_zone" {
  description = "Availability zone for the primary server"
  type        = string
  default     = "2"
}

# -----------------------------------------------------------------------------
# High Availability
# -----------------------------------------------------------------------------

variable "enable_high_availability" {
  description = "Enable zone-redundant high availability"
  type        = bool
  default     = false
}

variable "standby_availability_zone" {
  description = "Availability zone for the standby server"
  type        = string
  default     = "1"
}

# -----------------------------------------------------------------------------
# Backup Configuration
# -----------------------------------------------------------------------------

variable "backup_retention_days" {
  description = "Backup retention days"
  type        = number
  default     = 7
}

variable "geo_redundant_backup_enabled" {
  description = "Enable geo-redundant backup"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Maintenance Window
# -----------------------------------------------------------------------------

variable "maintenance_day" {
  description = "Day of week for maintenance window (0=Sunday, 6=Saturday)"
  type        = number
  default     = 0
}

variable "maintenance_hour" {
  description = "Start hour for maintenance window (0-23 UTC)"
  type        = number
  default     = 2
}

# -----------------------------------------------------------------------------
# Network Configuration
# -----------------------------------------------------------------------------

variable "vnet_id" {
  description = "The resource ID of the VNet (for reference/documentation)"
  type        = string
  default     = null
}

variable "delegated_subnet_id" {
  description = "The resource ID of the delegated subnet where PostgreSQL will be deployed (must be delegated to Microsoft.DBforPostgreSQL/flexibleServers)"
  type        = string
  default     = null
}

variable "private_dns_zone_id" {
  description = "The resource ID of the private DNS zone (e.g., privatelink.postgres.database.azure.com)"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Security Configuration
# -----------------------------------------------------------------------------

variable "require_ssl" {
  description = "Require SSL connections"
  type        = bool
  default     = true
}

variable "enable_connection_throttling" {
  description = "Enable connection throttling"
  type        = bool
  default     = true
}

variable "log_connections" {
  description = "Enable logging of connections"
  type        = bool
  default     = true
}

variable "log_disconnections" {
  description = "Enable logging of disconnections"
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Firewall Configuration
# -----------------------------------------------------------------------------

variable "enable_development_access" {
  description = "Allow all IP addresses (for development only)"
  type        = bool
  default     = false
}

variable "allowed_ip_start" {
  description = "Start IP address for allowed range (set both start and end to enable)"
  type        = string
  default     = null
}

variable "allowed_ip_end" {
  description = "End IP address for allowed range (set both start and end to enable)"
  type        = string
  default     = null
}

variable "custom_firewall_rules" {
  description = "Custom firewall rules as a map of name => {start_ip, end_ip}"
  type = map(object({
    start_ip = string
    end_ip   = string
  }))
  default = {}
}

# -----------------------------------------------------------------------------
# Extensions
# -----------------------------------------------------------------------------

variable "postgresql_extensions" {
  description = "List of PostgreSQL extensions to enable"
  type        = list(string)
  default     = ["UUID-OSSP", "PGCRYPTO"]
}

# -----------------------------------------------------------------------------
# Private Endpoint Configuration
# -----------------------------------------------------------------------------

variable "private_endpoint_subnet_id" {
  description = "Subnet ID for the private endpoint (used when server is NOT VNet-injected via delegated subnet)"
  type        = string
  default     = null
}

variable "pe_private_dns_zone_id" {
  description = "Private DNS zone ID for the private endpoint (privatelink.postgres.database.azure.com)"
  type        = string
  default     = null
}

variable "disable_public_access" {
  description = "Disable public network access when using private endpoint"
  type        = bool
  default     = true
}

variable "private_endpoint_dns_wait" {
  description = "Configuration for waiting for Azure Policy to attach DNS zone group to the PE. Set enabled=true in PBMM/landing-zone environments where platform automation manages DNS zones asynchronously."
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

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

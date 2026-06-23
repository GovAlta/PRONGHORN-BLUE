# =============================================================================
# PostgreSQL Flexible Server Module (AVM Wrapper)
# =============================================================================
# This module wraps Azure Verified Module for PostgreSQL Flexible Server:
# - avm-res-dbforpostgresql-flexibleserver v0.2.2
#
# Features:
# - Database creation
# - Firewall rules (conditional on networking mode)
# - Server configurations (extensions, SSL, logging)
# - Private endpoints with PBMM DNS wait pattern
# - High availability (optional)
# =============================================================================

# -----------------------------------------------------------------------------
# PostgreSQL Flexible Server (AVM)
# -----------------------------------------------------------------------------

module "postgresql_server" {
  source  = "Azure/avm-res-dbforpostgresql-flexibleserver/azurerm"
  version = "0.2.2"

  name                = var.server_name
  location            = var.location
  resource_group_name = var.resource_group_name

  # Authentication — write-only password (administrator_password_wo) is never
  # stored in state; only the integer version is tracked. The break-glass
  # administrator_password override (default null) takes precedence when set.
  administrator_login               = var.administrator_login
  administrator_password_wo         = coalesce(var.administrator_password, var.administrator_password_wo)
  administrator_password_wo_version = var.administrator_password_wo_version

  # Server configuration
  server_version = var.postgresql_version
  sku_name       = var.sku_name
  storage_mb     = var.storage_mb
  zone           = var.availability_zone

  # Network — public access is disabled when:
  #   1. VNet injection is configured (delegated_subnet_id set), OR
  #   2. Private endpoint is configured (private_endpoint_subnet_id set), OR
  #   3. Explicitly disabled via var.disable_public_access
  # In dev (no VNet, no PE, disable_public_access=false) → public access enabled + firewall rules
  # In PBMM (VNet or PE configured) → public access disabled automatically
  public_network_access_enabled = var.disable_public_access ? false : !local.use_private_networking && !local.use_private_endpoint
  delegated_subnet_id           = var.delegated_subnet_id
  private_dns_zone_id           = var.private_dns_zone_id

  # Backup
  backup_retention_days        = var.backup_retention_days
  geo_redundant_backup_enabled = var.geo_redundant_backup_enabled

  # High availability (null disables HA; AVM defaults to ZoneRedundant)
  high_availability = var.enable_high_availability ? {
    mode                      = "ZoneRedundant"
    standby_availability_zone = var.standby_availability_zone
  } : null

  # Maintenance window
  maintenance_window = {
    day_of_week  = tostring(var.maintenance_day)
    start_hour   = var.maintenance_hour
    start_minute = 0
  }

  # Databases
  databases = {
    main = {
      name      = var.database_name
      charset   = "UTF8"
      collation = "en_US.utf8"
    }
  }

  # Firewall rules (empty when using private networking)
  firewall_rules = local.firewall_rules

  # Server configurations
  server_configuration = local.server_configuration

  # Private Endpoints (for PE-only mode, not VNet injection)
  private_endpoints = local.use_private_endpoint && !local.use_private_networking ? {
    postgresql = {
      name                          = "${var.server_name}-pe"
      subnet_resource_id            = var.private_endpoint_subnet_id
      private_dns_zone_resource_ids = var.pe_private_dns_zone_id != null ? [var.pe_private_dns_zone_id] : []
    }
  } : {}

  # GoA PBMM: DNS zone group managed externally by Azure Policy
  private_endpoints_manage_dns_zone_group = false

  enable_telemetry = false
  tags             = local.common_tags
}

# -----------------------------------------------------------------------------
# Wait for Azure Policy to attach DNS zone group to PE (PBMM pattern)
# In GoA landing zones, platform automation asynchronously creates DNS zone
# groups on private endpoints. This null_resource polls until the zone group
# exists, ensuring downstream DNS resolution works.
# -----------------------------------------------------------------------------

resource "null_resource" "wait_for_pe_dns" {
  count = (
    local.use_private_endpoint &&
    !local.use_private_networking &&
    var.private_endpoint_dns_wait.enabled
  ) ? 1 : 0

  triggers = {
    private_endpoint_id = module.postgresql_server.private_endpoints["postgresql"].id
  }

  provisioner "local-exec" {
    interpreter = ["pwsh", "-Command"]
    command     = "& '${path.module}/../../scripts/Wait-ForDnsZoneGroup.ps1' -ResourceGroup '${var.resource_group_name}' -PrivateEndpointName '${var.server_name}-pe' -Timeout '${var.private_endpoint_dns_wait.timeout}' -Interval '${var.private_endpoint_dns_wait.interval}'"
  }
}

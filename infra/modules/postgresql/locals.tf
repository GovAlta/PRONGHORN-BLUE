# =============================================================================
# PostgreSQL Module Local Values
# =============================================================================

locals {
  # Convert extension list to comma-separated string for Azure configuration
  extensions_string = join(",", var.postgresql_extensions)

  # VNet integration is enabled when a delegated subnet is provided
  use_private_networking = var.delegated_subnet_id != null

  # Private endpoint mode (server not VNet-injected, but accessed via PE)
  use_private_endpoint = var.private_endpoint_subnet_id != null

  # Common tags applied to all resources
  common_tags = merge(var.tags, {
    Module = "postgresql"
  })

  # Firewall rules map (empty when using private networking)
  firewall_rules = local.use_private_networking ? {} : merge(
    {
      allow_azure_services = {
        name             = "AllowAzureServices"
        start_ip_address = "0.0.0.0"
        end_ip_address   = "0.0.0.0"
      }
    },
    var.enable_development_access ? {
      allow_all = {
        name             = "AllowDevelopmentAccess"
        start_ip_address = "0.0.0.0"
        end_ip_address   = "255.255.255.255"
      }
    } : {},
    var.allowed_ip_start != null && var.allowed_ip_end != null ? {
      allowed_ip_range = {
        name             = "AllowedIPRange"
        start_ip_address = var.allowed_ip_start
        end_ip_address   = var.allowed_ip_end
      }
    } : {},
    { for k, v in var.custom_firewall_rules : k => {
      name             = k
      start_ip_address = v.start_ip
      end_ip_address   = v.end_ip
    } }
  )

  # Server configurations
  server_configuration = {
    extensions = {
      name   = "azure.extensions"
      config = local.extensions_string
    }
    require_ssl = {
      name   = "require_secure_transport"
      config = var.require_ssl ? "ON" : "OFF"
    }
    connection_throttling = {
      name   = "connection_throttle.enable"
      config = var.enable_connection_throttling ? "ON" : "OFF"
    }
    log_connections = {
      name   = "log_connections"
      config = var.log_connections ? "ON" : "OFF"
    }
    log_disconnections = {
      name   = "log_disconnections"
      config = var.log_disconnections ? "ON" : "OFF"
    }
  }
}

# =============================================================================
# Azure Front Door Module
# =============================================================================
# Deploys Azure Front Door Premium in front of an existing Application Gateway.
# Includes:
#   - Front Door Profile (Premium SKU for WAF + Private Link support)
#   - Endpoint, Origin Group, Origin (pointing to App Gateway)
#   - Route with HTTPS redirect
#   - WAF Policy with managed rule sets (DRS 2.1 + Bot Manager)
#   - Security Policy associating WAF to the endpoint
#   - Diagnostic settings to Log Analytics
# =============================================================================

# -----------------------------------------------------------------------------
# Front Door Profile
# -----------------------------------------------------------------------------

resource "azurerm_cdn_frontdoor_profile" "this" {
  name                = var.frontdoor_name
  resource_group_name = var.resource_group_name
  sku_name            = var.sku_name

  response_timeout_seconds = 60

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Front Door Endpoint
# -----------------------------------------------------------------------------

resource "azurerm_cdn_frontdoor_endpoint" "this" {
  name                     = "${var.frontdoor_name}-endpoint"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Origin Group (with health probe and load balancing)
# -----------------------------------------------------------------------------

resource "azurerm_cdn_frontdoor_origin_group" "appgw" {
  name                     = "${var.frontdoor_name}-appgw-origin-group"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id

  session_affinity_enabled = false

  load_balancing {
    sample_size                        = 4
    successful_samples_required        = 3
    additional_latency_in_milliseconds = 50
  }

  health_probe {
    path                = var.health_probe_path
    protocol            = var.health_probe_protocol
    interval_in_seconds = var.health_probe_interval_in_seconds
    request_type        = var.health_probe_request_type
  }
}

# -----------------------------------------------------------------------------
# Origin (Application Gateway)
# -----------------------------------------------------------------------------

resource "azurerm_cdn_frontdoor_origin" "appgw" {
  name                          = "${var.frontdoor_name}-appgw-origin"
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.appgw.id

  enabled                        = true
  host_name                      = var.app_gateway_fqdn
  origin_host_header             = var.origin_host_header != "" ? var.origin_host_header : (length(var.custom_domains) > 0 ? var.custom_domains[0].host_name : var.app_gateway_fqdn)
  http_port                      = var.app_gateway_http_port
  https_port                     = var.app_gateway_https_port
  certificate_name_check_enabled = true
  priority                       = 1
  weight                         = 1000
}

# =============================================================================
# Custom Domains
# =============================================================================

resource "azurerm_cdn_frontdoor_custom_domain" "this" {
  for_each = { for idx, d in var.custom_domains : replace(d.host_name, ".", "-") => d }

  name                     = replace(each.value.host_name, ".", "-")
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  host_name                = each.value.host_name

  tls {
    certificate_type = each.value.certificate_type
  }
}

# -----------------------------------------------------------------------------
# Route
# -----------------------------------------------------------------------------

resource "azurerm_cdn_frontdoor_route" "default" {
  name                          = "${var.frontdoor_name}-default-route"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.this.id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.appgw.id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.appgw.id]

  cdn_frontdoor_custom_domain_ids = [for d in azurerm_cdn_frontdoor_custom_domain.this : d.id]

  enabled                = true
  forwarding_protocol    = var.forwarding_protocol
  https_redirect_enabled = var.https_redirect_enabled
  patterns_to_match      = var.patterns_to_match
  supported_protocols    = ["Http", "Https"]

  link_to_default_domain = true

  dynamic "cache" {
    for_each = var.enable_caching ? [1] : []
    content {
      query_string_caching_behavior = var.query_string_caching_behavior
      compression_enabled           = true
      content_types_to_compress = [
        "application/javascript",
        "application/json",
        "application/xml",
        "text/css",
        "text/html",
        "text/javascript",
        "text/plain",
      ]
    }
  }
}

# -----------------------------------------------------------------------------
# Custom Domain Route Association
# -----------------------------------------------------------------------------

resource "azurerm_cdn_frontdoor_custom_domain_association" "this" {
  for_each = azurerm_cdn_frontdoor_custom_domain.this

  cdn_frontdoor_custom_domain_id = each.value.id
  cdn_frontdoor_route_ids        = [azurerm_cdn_frontdoor_route.default.id]
}

# =============================================================================
# WAF Policy
# =============================================================================

resource "azurerm_cdn_frontdoor_firewall_policy" "this" {
  count = var.enable_waf_policy ? 1 : 0

  name                = replace("${var.frontdoor_name}wafpolicy", "-", "")
  resource_group_name = var.resource_group_name
  sku_name            = var.sku_name
  mode                = var.waf_mode
  enabled             = true

  dynamic "managed_rule" {
    for_each = var.waf_managed_rulesets
    content {
      type    = managed_rule.value.type
      version = managed_rule.value.version
      action  = managed_rule.value.action
    }
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Security Policy (associates WAF with the endpoint + custom domains)
# -----------------------------------------------------------------------------

resource "azurerm_cdn_frontdoor_security_policy" "this" {
  count = var.enable_waf_policy ? 1 : 0

  name                     = "${var.frontdoor_name}-security-policy"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id

  security_policies {
    firewall {
      cdn_frontdoor_firewall_policy_id = azurerm_cdn_frontdoor_firewall_policy.this[0].id

      association {
        patterns_to_match = ["/*"]

        # Default endpoint domain
        domain {
          cdn_frontdoor_domain_id = azurerm_cdn_frontdoor_endpoint.this.id
        }

        # Custom domains
        dynamic "domain" {
          for_each = azurerm_cdn_frontdoor_custom_domain.this
          content {
            cdn_frontdoor_domain_id = domain.value.id
          }
        }
      }
    }
  }
}

# =============================================================================
# Diagnostic Settings
# =============================================================================

resource "azurerm_monitor_diagnostic_setting" "frontdoor" {
  count = var.enable_diagnostics && var.log_analytics_workspace_id != null ? 1 : 0

  name                       = "${var.frontdoor_name}-diagnostics"
  target_resource_id         = azurerm_cdn_frontdoor_profile.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category_group = "allLogs"
  }
}

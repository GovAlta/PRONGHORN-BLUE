# =============================================================================
# Azure Application Gateway Module
# =============================================================================

resource "azurerm_application_gateway" "this" {
  name                = var.application_gateway_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  sku {
    name     = var.sku_name
    tier     = var.sku_tier
    capacity = var.sku_capacity
  }

  identity {
    type = "SystemAssigned"
  }

  gateway_ip_configuration {
    name      = "appGatewayPrivateFrontendIP"
    subnet_id = var.subnet_id
  }

  frontend_ip_configuration {
    name                          = "appGatewayPrivateFrontendIP"
    subnet_id                     = var.subnet_id
    private_ip_address            = var.frontend_private_ip_address
    private_ip_address_allocation = "Static"
  }

  frontend_port {
    name = "appGatewayFrontendPort"
    port = 80
  }

  frontend_port {
    name = "httpsPort"
    port = 443
  }

  ssl_certificate {
    name                = var.frontend_ssl_certificate_name
    key_vault_secret_id = var.frontend_ssl_certificate_key_vault_secret_id
  }

  ssl_certificate {
    name                = var.api_ssl_certificate_name
    key_vault_secret_id = var.api_ssl_certificate_key_vault_secret_id
  }

  backend_address_pool {
    name  = "aca-frontend-pool"
    fqdns = [var.frontend_backend_fqdn]
  }

  backend_address_pool {
    name  = "aca-backend-pool"
    fqdns = [var.api_backend_fqdn]
  }

  backend_address_pool {
    name  = "apim-backend-pool"
    fqdns = [var.apim_backend_fqdn]
  }

  backend_http_settings {
    name                                = "apim-https"
    port                                = 443
    protocol                            = "Https"
    cookie_based_affinity               = "Disabled"
    host_name                           = coalesce(var.apim_backend_host_name, var.apim_backend_fqdn)
    pick_host_name_from_backend_address = false
    request_timeout                     = 60
    probe_name                          = "apim-health-probe"
  }

  backend_http_settings {
    name                                = "aca-frontend-https"
    port                                = 443
    protocol                            = "Https"
    cookie_based_affinity               = "Disabled"
    host_name                           = coalesce(var.frontend_backend_host_name, var.frontend_backend_fqdn)
    pick_host_name_from_backend_address = false
    request_timeout                     = 20
  }

  backend_http_settings {
    name                                = "aca-api-https"
    port                                = 443
    protocol                            = "Https"
    cookie_based_affinity               = "Disabled"
    host_name                           = coalesce(var.api_backend_host_name, var.api_backend_fqdn)
    pick_host_name_from_backend_address = false
    request_timeout                     = 180
    probe_name                          = "pronghorn-api"
  }

  probe {
    name                                      = "pronghorn-api"
    protocol                                  = "Https"
    host                                      = coalesce(var.api_backend_host_name, var.api_backend_fqdn)
    path                                      = var.api_health_probe_path
    interval                                  = 30
    timeout                                   = 30
    unhealthy_threshold                       = 3
    pick_host_name_from_backend_http_settings = false
    minimum_servers                           = 0

    match {
      status_code = ["200-399"]
    }
  }

  probe {
    name                                      = "apim-health-probe"
    protocol                                  = "Https"
    host                                      = coalesce(var.apim_backend_host_name, var.apim_backend_fqdn)
    path                                      = var.apim_health_probe_path
    interval                                  = 30
    timeout                                   = 30
    unhealthy_threshold                       = 3
    pick_host_name_from_backend_http_settings = false
    minimum_servers                           = 0

    match {
      status_code = ["200-399"]
    }
  }

  http_listener {
    name                           = "pronghorn"
    frontend_ip_configuration_name = "appGatewayPrivateFrontendIP"
    frontend_port_name             = "httpsPort"
    protocol                       = "Https"
    ssl_certificate_name           = var.frontend_ssl_certificate_name
    host_name                      = var.frontend_listener_host_name
    require_sni                    = true
  }

  http_listener {
    name                           = "pronghorn-api"
    frontend_ip_configuration_name = "appGatewayPrivateFrontendIP"
    frontend_port_name             = "httpsPort"
    protocol                       = "Https"
    ssl_certificate_name           = var.api_ssl_certificate_name
    host_name                      = var.api_listener_host_name
    require_sni                    = true
  }

  url_path_map {
    name                               = "pronghorn-api"
    default_backend_address_pool_name  = "apim-backend-pool"
    default_backend_http_settings_name = "apim-https"

    path_rule {
      name                       = "pronghorn-aca"
      paths                      = var.api_path_rule_paths
      backend_address_pool_name  = "aca-backend-pool"
      backend_http_settings_name = "aca-api-https"
    }
  }

  request_routing_rule {
    name               = "pronghorn-api"
    rule_type          = "PathBasedRouting"
    http_listener_name = "pronghorn-api"
    url_path_map_name  = "pronghorn-api"
    priority           = 70
  }

  request_routing_rule {
    name                       = "pronghorn-frontend"
    rule_type                  = "Basic"
    http_listener_name         = "pronghorn"
    backend_address_pool_name  = "aca-frontend-pool"
    backend_http_settings_name = "aca-frontend-https"
    priority                   = 75
  }
}
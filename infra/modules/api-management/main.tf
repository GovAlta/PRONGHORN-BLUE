# =============================================================================
# API Management Module
# =============================================================================
# This module creates Azure API Management with API configuration.
# =============================================================================

# -----------------------------------------------------------------------------
# APIM Management Public IP (required for Internal VNet mode)
# -----------------------------------------------------------------------------

resource "azurerm_public_ip" "apim_mgmt" {
  count               = var.virtual_network_type == "Internal" ? 1 : 0
  name                = "${var.apim_name}-mgmt-pip"
  location            = var.location
  resource_group_name = var.resource_group_name
  allocation_method   = "Static"
  sku                 = "Standard"
  domain_name_label   = var.apim_name

  tags = local.common_tags

  # When APIM (Internal VNet mode) attaches this IP to its managed gateway load
  # balancer, Azure automatically stamps the immutable `ip_tags` value
  # { FirstPartyUsage = "/Unprivileged" }. Because the config does not declare it,
  # every later plan sees config(null) != actual and—`ip_tags` being
  # force-new—tries to destroy/recreate the IP. Azure rejects that delete while
  # the IP is still allocated to APIM (PublicIPAddressCannotBeDeleted). Ignoring
  # the platform-managed tag keeps the IP stable across applies.
  lifecycle {
    ignore_changes = [ip_tags]
  }
}

# -----------------------------------------------------------------------------
# API Management Instance
# -----------------------------------------------------------------------------

resource "azurerm_api_management" "main" {
  name                 = var.apim_name
  location             = var.location
  resource_group_name  = var.resource_group_name
  publisher_name       = var.publisher_name
  publisher_email      = var.publisher_email
  sku_name             = var.sku_name
  virtual_network_type = var.virtual_network_type
  public_ip_address_id = var.virtual_network_type == "Internal" ? azurerm_public_ip.apim_mgmt[0].id : null

  dynamic "virtual_network_configuration" {
    for_each = var.virtual_network_type != "None" && var.subnet_id != null ? [1] : []
    content {
      subnet_id = var.subnet_id
    }
  }

  identity {
    type = "SystemAssigned"
  }

  # Re-enable after successful deploy:
  # lifecycle { prevent_destroy = true }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Application Insights Logger (optional)
# -----------------------------------------------------------------------------

resource "azurerm_api_management_logger" "app_insights" {
  count               = var.enable_diagnostics ? 1 : 0
  name                = "appi-logger"
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  resource_id         = var.app_insights_id

  application_insights {
    instrumentation_key = var.app_insights_instrumentation_key
  }

  lifecycle {
    ignore_changes = [application_insights]
  }
}

# -----------------------------------------------------------------------------
# API Definition
# -----------------------------------------------------------------------------

resource "azurerm_api_management_api" "main" {
  count                 = var.create_api ? 1 : 0
  name                  = var.api_name
  resource_group_name   = var.resource_group_name
  api_management_name   = azurerm_api_management.main.name
  revision              = var.api_revision
  display_name          = var.api_display_name
  path                  = var.api_path
  protocols             = var.api_protocols
  subscription_required = var.subscription_required
  service_url           = var.backend_url

  # OpenAPI import (optional)
  dynamic "import" {
    for_each = var.openapi_spec_url != null ? [1] : []
    content {
      content_format = "openapi+json-link"
      content_value  = var.openapi_spec_url
    }
  }
}

# -----------------------------------------------------------------------------
# API Policy (CORS, JWT validation, rate limiting, etc.)
# -----------------------------------------------------------------------------

resource "azurerm_api_management_api_policy" "main" {
  count               = var.create_api && local.effective_policy_xml != null ? 1 : 0
  api_name            = azurerm_api_management_api.main[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  xml_content         = local.effective_policy_xml

  lifecycle {
    precondition {
      condition     = !var.enable_entra_auth || (var.azure_tenant_id != null && var.azure_tenant_id != "")
      error_message = "azure_tenant_id must be a non-empty string when enable_entra_auth is true."
    }
    precondition {
      condition     = !var.enable_entra_auth || (var.azure_client_id != null && var.azure_client_id != "")
      error_message = "azure_client_id must be a non-empty string when enable_entra_auth is true."
    }
  }
}

# -----------------------------------------------------------------------------
# Wildcard API Operations (pass-through to backend)
# -----------------------------------------------------------------------------

resource "azurerm_api_management_api_operation" "wildcard_get" {
  count               = var.create_api ? 1 : 0
  operation_id        = "wildcard-get"
  api_name            = azurerm_api_management_api.main[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "GET wildcard"
  method              = "GET"
  url_template        = "/*"
}

resource "azurerm_api_management_api_operation" "wildcard_post" {
  count               = var.create_api ? 1 : 0
  operation_id        = "wildcard-post"
  api_name            = azurerm_api_management_api.main[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "POST wildcard"
  method              = "POST"
  url_template        = "/*"
}

resource "azurerm_api_management_api_operation" "wildcard_put" {
  count               = var.create_api ? 1 : 0
  operation_id        = "wildcard-put"
  api_name            = azurerm_api_management_api.main[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "PUT wildcard"
  method              = "PUT"
  url_template        = "/*"
}

resource "azurerm_api_management_api_operation" "wildcard_patch" {
  count               = var.create_api ? 1 : 0
  operation_id        = "wildcard-patch"
  api_name            = azurerm_api_management_api.main[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "PATCH wildcard"
  method              = "PATCH"
  url_template        = "/*"
}

resource "azurerm_api_management_api_operation" "wildcard_delete" {
  count               = var.create_api ? 1 : 0
  operation_id        = "wildcard-delete"
  api_name            = azurerm_api_management_api.main[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "DELETE wildcard"
  method              = "DELETE"
  url_template        = "/*"
}

resource "azurerm_api_management_api_operation" "wildcard_options" {
  count               = var.create_api ? 1 : 0
  operation_id        = "wildcard-options"
  api_name            = azurerm_api_management_api.main[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "OPTIONS wildcard"
  method              = "OPTIONS"
  url_template        = "/*"
}

# -----------------------------------------------------------------------------
# Diagnostic Settings
# -----------------------------------------------------------------------------

resource "azurerm_api_management_diagnostic" "app_insights" {
  count                    = var.enable_diagnostics ? 1 : 0
  identifier               = "applicationinsights"
  resource_group_name      = var.resource_group_name
  api_management_name      = azurerm_api_management.main.name
  api_management_logger_id = azurerm_api_management_logger.app_insights[0].id

  sampling_percentage       = var.diagnostics_sampling_percentage
  always_log_errors         = true
  log_client_ip             = true
  verbosity                 = var.diagnostics_verbosity
  http_correlation_protocol = "W3C"

  frontend_request {
    body_bytes = 32
    headers_to_log = [
      "content-type",
      "accept",
      "origin",
    ]
  }

  frontend_response {
    body_bytes = 32
    headers_to_log = [
      "content-type",
      "content-length",
      "origin",
    ]
  }

  backend_request {
    body_bytes = 32
    headers_to_log = [
      "content-type",
      "accept",
      "origin",
    ]
  }

  backend_response {
    body_bytes = 32
    headers_to_log = [
      "content-type",
      "content-length",
      "origin",
    ]
  }
}

# =============================================================================
# OpenAI API Proxy (for Azure AI Foundry)
# =============================================================================

# -----------------------------------------------------------------------------
# OpenAI API Definition
# -----------------------------------------------------------------------------

resource "azurerm_api_management_api" "openai" {
  count                 = var.create_openai_api ? 1 : 0
  name                  = "openai-api"
  resource_group_name   = var.resource_group_name
  api_management_name   = azurerm_api_management.main.name
  revision              = "1"
  display_name          = "Azure OpenAI API"
  path                  = "openai"
  protocols             = ["https"]
  subscription_required = false # Use Bearer token (Managed Identity) instead of subscription key
  service_url           = var.openai_backend_url
}

# -----------------------------------------------------------------------------
# OpenAI API Policy (Managed Identity Auth to Azure OpenAI)
# -----------------------------------------------------------------------------

resource "azurerm_api_management_api_policy" "openai" {
  count               = var.create_openai_api ? 1 : 0
  api_name            = azurerm_api_management_api.openai[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name

  xml_content = <<XML
<policies>
  <inbound>
    <base />
    <set-query-parameter name="api-version" exists-action="override">
      <value>${var.openai_api_version}</value>
    </set-query-parameter>
    <authentication-managed-identity resource="https://cognitiveservices.azure.com/" />
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
  <on-error>
    <base />
  </on-error>
</policies>
XML
}

# -----------------------------------------------------------------------------
# OpenAI API Operations
# -----------------------------------------------------------------------------

resource "azurerm_api_management_api_operation" "openai_chat_completions" {
  count               = var.create_openai_api ? 1 : 0
  operation_id        = "chat-completions"
  api_name            = azurerm_api_management_api.openai[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "Chat Completions"
  method              = "POST"
  url_template        = "/deployments/{deployment-id}/chat/completions"

  template_parameter {
    name     = "deployment-id"
    required = true
    type     = "string"
  }
}

resource "azurerm_api_management_api_operation" "openai_completions" {
  count               = var.create_openai_api ? 1 : 0
  operation_id        = "completions"
  api_name            = azurerm_api_management_api.openai[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "Completions"
  method              = "POST"
  url_template        = "/deployments/{deployment-id}/completions"

  template_parameter {
    name     = "deployment-id"
    required = true
    type     = "string"
  }
}

resource "azurerm_api_management_api_operation" "openai_embeddings" {
  count               = var.create_openai_api ? 1 : 0
  operation_id        = "embeddings"
  api_name            = azurerm_api_management_api.openai[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "Embeddings"
  method              = "POST"
  url_template        = "/deployments/{deployment-id}/embeddings"

  template_parameter {
    name     = "deployment-id"
    required = true
    type     = "string"
  }
}

resource "azurerm_api_management_api_operation" "openai_images" {
  count               = var.create_openai_api ? 1 : 0
  operation_id        = "images-generations"
  api_name            = azurerm_api_management_api.openai[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "Image Generations"
  method              = "POST"
  url_template        = "/deployments/{deployment-id}/images/generations"

  template_parameter {
    name     = "deployment-id"
    required = true
    type     = "string"
  }
}

resource "azurerm_api_management_api_operation" "openai_images_edits" {
  count               = var.create_openai_api ? 1 : 0
  operation_id        = "images-edits"
  api_name            = azurerm_api_management_api.openai[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "Image Edits"
  method              = "POST"
  url_template        = "/deployments/{deployment-id}/images/edits"

  template_parameter {
    name     = "deployment-id"
    required = true
    type     = "string"
  }
}

resource "azurerm_api_management_api_operation" "openai_models" {
  count               = var.create_openai_api ? 1 : 0
  operation_id        = "list-models"
  api_name            = azurerm_api_management_api.openai[0].name
  api_management_name = azurerm_api_management.main.name
  resource_group_name = var.resource_group_name
  display_name        = "List Models"
  method              = "GET"
  url_template        = "/models"
}

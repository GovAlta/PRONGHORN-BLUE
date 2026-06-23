# =============================================================================
# Entra ID App Registration Module
# =============================================================================
# Creates and configures a Microsoft Entra ID (Azure AD) App Registration
# for SPA authentication using MSAL with Auth Code + PKCE.
#
# This module configures:
# - SPA platform with redirect URIs
# - Required Microsoft Graph delegated permissions (openid, profile, email, User.Read)
# - Optional exposed API scope (access_as_user)
# - No client secret (SPA public client using PKCE)
# - No implicit grant (MSAL v2 uses Auth Code + PKCE)
# =============================================================================

data "azuread_client_config" "current" {}

# Microsoft Graph well-known application ID
# https://learn.microsoft.com/en-us/graph/permissions-reference
locals {
  microsoft_graph_app_id = "00000003-0000-0000-c000-000000000000"

  # Microsoft Graph delegated permission IDs
  # These are fixed GUIDs defined by Microsoft
  graph_permissions = {
    openid    = "37f7f235-527c-4136-accd-4a02d197296e"
    profile   = "14dad69e-099b-42c9-810b-d002981feec1"
    email     = "64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0"
    user_read = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"
  }

  owners = length(var.owners) > 0 ? var.owners : [data.azuread_client_config.current.object_id]
}

# -----------------------------------------------------------------------------
# App Registration
# -----------------------------------------------------------------------------

resource "azuread_application" "this" {
  display_name     = var.application_display_name
  sign_in_audience = var.sign_in_audience
  owners           = local.owners

  # SPA platform configuration (Auth Code + PKCE, NOT implicit grant)
  single_page_application {
    redirect_uris = var.redirect_uris
  }

  # Required Microsoft Graph delegated permissions
  required_resource_access {
    resource_app_id = local.microsoft_graph_app_id

    resource_access {
      id   = local.graph_permissions["openid"]
      type = "Scope"
    }

    resource_access {
      id   = local.graph_permissions["profile"]
      type = "Scope"
    }

    resource_access {
      id   = local.graph_permissions["email"]
      type = "Scope"
    }

    resource_access {
      id   = local.graph_permissions["user_read"]
      type = "Scope"
    }
  }

  # Expose API scope (defined but not actively used by the application)
  dynamic "api" {
    for_each = var.expose_api_scope ? [1] : []
    content {
      oauth2_permission_scope {
        admin_consent_description  = "Allow the application to access the API on behalf of the signed-in user"
        admin_consent_display_name = "Access the API"
        enabled                    = true
        id                         = random_uuid.api_scope_id[0].result
        type                       = "User"
        user_consent_description   = "Allow the application to access the API on your behalf"
        user_consent_display_name  = "Access the API"
        value                      = "access_as_user"
      }
    }
  }

  # Optional claims for ID token
  optional_claims {
    id_token {
      name = "email"
    }
  }
}

resource "random_uuid" "api_scope_id" {
  count = var.expose_api_scope ? 1 : 0
}

# Set the Application ID URI (api://{client-id}) when exposing an API scope
resource "azuread_application_identifier_uri" "this" {
  count          = var.expose_api_scope ? 1 : 0
  application_id = azuread_application.this.id
  identifier_uri = "api://${azuread_application.this.client_id}"
}

# -----------------------------------------------------------------------------
# Service Principal (Enterprise Application)
# -----------------------------------------------------------------------------

resource "azuread_service_principal" "this" {
  client_id = azuread_application.this.client_id
  owners    = local.owners
}

# -----------------------------------------------------------------------------
# Admin Consent for Microsoft Graph permissions
# -----------------------------------------------------------------------------
# Grant admin consent so users are not prompted for individual consent.
# This requires the deploying principal to have sufficient Entra ID permissions.

resource "azuread_service_principal_delegated_permission_grant" "graph_permissions" {
  service_principal_object_id          = azuread_service_principal.this.object_id
  resource_service_principal_object_id = data.azuread_service_principal.microsoft_graph.object_id
  claim_values                         = ["openid", "profile", "email", "User.Read"]
}

data "azuread_service_principal" "microsoft_graph" {
  client_id = local.microsoft_graph_app_id
}

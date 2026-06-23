# =============================================================================
# Entra ID App Registration Module Variables
# =============================================================================

variable "application_display_name" {
  description = "Display name for the Entra ID App Registration"
  type        = string
}

variable "sign_in_audience" {
  description = "Supported account types. Use 'AzureADMyOrg' for single-tenant (recommended for PBMM) or 'AzureADMultipleOrgs' for multi-tenant."
  type        = string
  default     = "AzureADMyOrg"

  validation {
    condition     = contains(["AzureADMyOrg", "AzureADMultipleOrgs"], var.sign_in_audience)
    error_message = "sign_in_audience must be 'AzureADMyOrg' or 'AzureADMultipleOrgs'."
  }
}

variable "redirect_uris" {
  description = "List of redirect URIs for the SPA platform. Should include the frontend app URL and optionally localhost for development."
  type        = list(string)
}

variable "expose_api_scope" {
  description = "Whether to expose the 'access_as_user' API scope. Currently unused by the application but harmless to create."
  type        = bool
  default     = true
}

variable "owners" {
  description = "List of Azure AD Object IDs to set as owners of the app registration. If empty, the current principal is used."
  type        = list(string)
  default     = []
}

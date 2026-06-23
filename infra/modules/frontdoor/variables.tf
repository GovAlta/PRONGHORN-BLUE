# =============================================================================
# Azure Front Door Module - Variables
# =============================================================================

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "location" {
  description = "Azure region for regional resources (Front Door profile is global)"
  type        = string
  default     = "canadacentral"
}

variable "frontdoor_name" {
  description = "Name of the Azure Front Door profile"
  type        = string
}

variable "sku_name" {
  description = "Front Door SKU. Use Premium_AzureFrontDoor for WAF policy support and Private Link."
  type        = string
  default     = "Premium_AzureFrontDoor"

  validation {
    condition     = contains(["Standard_AzureFrontDoor", "Premium_AzureFrontDoor"], var.sku_name)
    error_message = "SKU must be Standard_AzureFrontDoor or Premium_AzureFrontDoor."
  }
}

# -----------------------------------------------------------------------------
# Origin (Application Gateway) Configuration
# -----------------------------------------------------------------------------

variable "app_gateway_fqdn" {
  description = "FQDN or public IP address of the Application Gateway origin (e.g., 4.239.161.4 or appgw.example.com)"
  type        = string
}

variable "app_gateway_http_port" {
  description = "HTTP port on the Application Gateway origin"
  type        = number
  default     = 80
}

variable "app_gateway_https_port" {
  description = "HTTPS port on the Application Gateway origin"
  type        = number
  default     = 443
}

variable "origin_host_header" {
  description = "Host header sent to the Application Gateway. Leave empty to use the origin hostname."
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Health Probe Configuration
# -----------------------------------------------------------------------------

variable "health_probe_path" {
  description = "Path for the health probe on the origin"
  type        = string
  default     = "/"
}

variable "health_probe_protocol" {
  description = "Protocol for health probes (Http or Https)"
  type        = string
  default     = "Https"

  validation {
    condition     = contains(["Http", "Https"], var.health_probe_protocol)
    error_message = "Health probe protocol must be Http or Https."
  }
}

variable "health_probe_interval_in_seconds" {
  description = "Interval in seconds between health probes"
  type        = number
  default     = 100
}

variable "health_probe_request_type" {
  description = "Request type for health probes (GET or HEAD)"
  type        = string
  default     = "HEAD"

  validation {
    condition     = contains(["GET", "HEAD"], var.health_probe_request_type)
    error_message = "Health probe request type must be GET or HEAD."
  }
}

# -----------------------------------------------------------------------------
# WAF Policy Configuration
# -----------------------------------------------------------------------------

variable "enable_waf_policy" {
  description = "Whether to create and associate a WAF policy with Front Door"
  type        = bool
  default     = true
}

variable "waf_mode" {
  description = "WAF policy mode: Detection or Prevention"
  type        = string
  default     = "Prevention"

  validation {
    condition     = contains(["Detection", "Prevention"], var.waf_mode)
    error_message = "WAF mode must be Detection or Prevention."
  }
}

variable "waf_managed_rulesets" {
  description = "List of managed rule sets for WAF. Defaults to DRS 2.1 and BotManager 1.0."
  type = list(object({
    type    = string
    version = string
    action  = optional(string, "Block")
  }))
  default = [
    {
      type    = "Microsoft_DefaultRuleSet"
      version = "2.1"
      action  = "Block"
    },
    {
      type    = "Microsoft_BotManagerRuleSet"
      version = "1.0"
      action  = "Block"
    }
  ]
}

# -----------------------------------------------------------------------------
# Route Configuration
# -----------------------------------------------------------------------------

variable "forwarding_protocol" {
  description = "Protocol used when forwarding to the origin (HttpOnly, HttpsOnly, MatchRequest)"
  type        = string
  default     = "HttpsOnly"

  validation {
    condition     = contains(["HttpOnly", "HttpsOnly", "MatchRequest"], var.forwarding_protocol)
    error_message = "Forwarding protocol must be HttpOnly, HttpsOnly, or MatchRequest."
  }
}

variable "https_redirect_enabled" {
  description = "Whether HTTP requests are automatically redirected to HTTPS"
  type        = bool
  default     = true
}

variable "patterns_to_match" {
  description = "URL patterns to match for routing"
  type        = list(string)
  default     = ["/*"]
}

# -----------------------------------------------------------------------------
# Caching Configuration
# -----------------------------------------------------------------------------

variable "enable_caching" {
  description = "Whether to enable caching on the route"
  type        = bool
  default     = false
}

variable "query_string_caching_behavior" {
  description = "Query string caching behavior (IgnoreQueryString, UseQueryString, IgnoreSpecifiedQueryStrings, IncludeSpecifiedQueryStrings)"
  type        = string
  default     = "IgnoreQueryString"
}

# -----------------------------------------------------------------------------
# Custom Domain Configuration
# -----------------------------------------------------------------------------

variable "custom_domains" {
  description = "List of custom domains to add to Front Door. Each entry needs hostname and optional certificate type."
  type = list(object({
    host_name        = string
    certificate_type = optional(string, "ManagedCertificate")
    tls_version      = optional(string, "TLS12")
  }))
  default = []
}

# -----------------------------------------------------------------------------
# Diagnostics
# -----------------------------------------------------------------------------

variable "log_analytics_workspace_id" {
  description = "Resource ID of the Log Analytics workspace for diagnostic settings"
  type        = string
  default     = null
}

variable "enable_diagnostics" {
  description = "Whether to enable diagnostic settings"
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

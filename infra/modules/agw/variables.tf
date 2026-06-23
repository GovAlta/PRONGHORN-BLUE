# =============================================================================
# Azure Application Gateway Module - Variables
# =============================================================================

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "location" {
  description = "Azure region for the Application Gateway"
  type        = string
}

variable "application_gateway_name" {
  description = "Name of the Application Gateway"
  type        = string
}

variable "subnet_id" {
  description = "Subnet ID for the Application Gateway frontend and gateway IP configuration"
  type        = string
}

variable "frontend_private_ip_address" {
  description = "Static private IP address for the internal frontend"
  type        = string
}

variable "sku_name" {
  description = "Application Gateway SKU name"
  type        = string
  default     = "Standard_v2"
}

variable "sku_tier" {
  description = "Application Gateway SKU tier"
  type        = string
  default     = "Standard_v2"
}

variable "sku_capacity" {
  description = "Instance count for the Application Gateway"
  type        = number
  default     = 2
}

variable "frontend_listener_host_name" {
  description = "Hostname for the frontend HTTPS listener"
  type        = string
  default     = "frontend.pronghorn.internal"
}

variable "api_listener_host_name" {
  description = "Hostname for the API HTTPS listener"
  type        = string
  default     = "api.pronghorn.internal"
}

variable "frontend_ssl_certificate_name" {
  description = "Certificate name for the frontend listener"
  type        = string
  default     = "pronghorn-test-cert"
}

variable "api_ssl_certificate_name" {
  description = "Certificate name for the API listener"
  type        = string
  default     = "api-pronghorn-internal"
}

variable "frontend_ssl_certificate_key_vault_secret_id" {
  description = "Key Vault secret ID for the frontend listener certificate"
  type        = string
}

variable "api_ssl_certificate_key_vault_secret_id" {
  description = "Key Vault secret ID for the API listener certificate"
  type        = string
}

variable "frontend_backend_fqdn" {
  description = "FQDN for the frontend backend pool"
  type        = string
}

variable "frontend_backend_host_name" {
  description = "Optional host header for the frontend backend"
  type        = string
  default     = null
}

variable "api_backend_fqdn" {
  description = "FQDN for the API backend pool"
  type        = string
}

variable "api_backend_host_name" {
  description = "Optional host header for the API backend"
  type        = string
  default     = null
}

variable "apim_backend_fqdn" {
  description = "FQDN for the APIM backend pool"
  type        = string
}

variable "apim_backend_host_name" {
  description = "Optional host header for the APIM backend"
  type        = string
  default     = null
}

variable "api_health_probe_path" {
  description = "Health probe path for the API backend"
  type        = string
  default     = "/api/health"
}

variable "apim_health_probe_path" {
  description = "Health probe path for APIM"
  type        = string
  default     = "/status-0123456789abcdef"
}

variable "api_path_rule_paths" {
  description = "Path patterns routed directly to the API backend"
  type        = list(string)
  default     = ["/ws*"]
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
# =============================================================================
# Azure Front Door Module - Outputs
# =============================================================================

output "profile_id" {
  description = "The resource ID of the Front Door profile"
  value       = azurerm_cdn_frontdoor_profile.this.id
}

output "profile_name" {
  description = "The name of the Front Door profile"
  value       = azurerm_cdn_frontdoor_profile.this.name
}

output "endpoint_id" {
  description = "The resource ID of the Front Door endpoint"
  value       = azurerm_cdn_frontdoor_endpoint.this.id
}

output "endpoint_host_name" {
  description = "The host name of the Front Door endpoint (e.g., <name>.z01.azurefd.net)"
  value       = azurerm_cdn_frontdoor_endpoint.this.host_name
}

output "endpoint_url" {
  description = "The HTTPS URL of the Front Door endpoint"
  value       = "https://${azurerm_cdn_frontdoor_endpoint.this.host_name}"
}

output "waf_policy_id" {
  description = "The resource ID of the WAF policy (if created)"
  value       = var.enable_waf_policy ? azurerm_cdn_frontdoor_firewall_policy.this[0].id : null
}

output "origin_group_id" {
  description = "The resource ID of the origin group"
  value       = azurerm_cdn_frontdoor_origin_group.appgw.id
}

output "frontdoor_id" {
  description = "The Front Door ID (UUID) used for X-Azure-FDID header validation on the backend"
  value       = azurerm_cdn_frontdoor_profile.this.resource_guid
}

output "custom_domain_validation" {
  description = "DNS validation records required for each custom domain"
  value = {
    for key, domain in azurerm_cdn_frontdoor_custom_domain.this : domain.host_name => {
      validation_token = domain.validation_token
      expiration_date  = domain.expiration_date
    }
  }
}

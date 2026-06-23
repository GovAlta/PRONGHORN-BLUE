variable "name" {
  description = "Resource group name (convention: rg-genapp-{app_name}-{env})"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}

variable "tags" {
  description = "Resource tags"
  type        = map(string)
  default     = {}
}

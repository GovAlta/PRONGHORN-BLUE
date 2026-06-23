# API Management Module

This module creates Azure API Management for API gateway functionality.

## Features

- Azure API Management with configurable SKU
- System-assigned managed identity
- Application Insights integration
- API definition with OpenAPI import support
- Custom API policies (CORS, rate limiting, etc.)
- Comprehensive diagnostics logging

## Usage

```hcl
module "api_management" {
  source = "./modules/api-management"

  resource_group_name = "my-resource-group"
  location            = "canadacentral"
  apim_name           = "apim-myapp-dev"
  publisher_name      = "My Organization"
  publisher_email     = "admin@myorg.com"

  # Optional configuration
  sku_name = "Consumption_0"

  # Application Insights integration
  app_insights_id                  = module.logging.app_insights_id
  app_insights_instrumentation_key = module.logging.app_insights_instrumentation_key
  enable_diagnostics               = true

  # API configuration
  create_api        = true
  api_name          = "my-api"
  api_display_name  = "My API"
  api_path          = "api"
  backend_url       = module.container_apps.app_url

  # Import OpenAPI spec
  openapi_spec_url = "https://myapp.com/openapi.json"

  # Custom policy
  api_policy_xml = <<XML
<policies>
  <inbound>
    <base />
    <cors allow-credentials="true">
      <allowed-origins>
        <origin>https://myapp.com</origin>
      </allowed-origins>
      <allowed-methods>
        <method>*</method>
      </allowed-methods>
      <allowed-headers>
        <header>*</header>
      </allowed-headers>
    </cors>
    <rate-limit calls="1000" renewal-period="60" />
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

  tags = {
    Environment = "Development"
  }
}
```

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|----------|
| resource_group_name | Name of the resource group | string | - | yes |
| location | Azure region | string | - | yes |
| apim_name | APIM instance name | string | - | yes |
| publisher_name | Publisher name | string | - | yes |
| publisher_email | Publisher email | string | - | yes |
| sku_name | APIM SKU | string | "Consumption_0" | no |
| app_insights_id | App Insights resource ID | string | null | no |
| app_insights_instrumentation_key | App Insights key | string | null | no |
| enable_diagnostics | Enable diagnostics | bool | true | no |
| diagnostics_sampling_percentage | Sampling % | number | 100 | no |
| diagnostics_verbosity | Verbosity level | string | "information" | no |
| create_api | Create API definition | bool | true | no |
| api_name | API name | string | "api" | no |
| api_display_name | API display name | string | "API" | no |
| api_revision | API revision | string | "1" | no |
| api_path | API path | string | "api" | no |
| api_protocols | API protocols | list(string) | ["https"] | no |
| subscription_required | Require subscription | bool | false | no |
| backend_url | Backend service URL | string | null | no |
| openapi_spec_url | OpenAPI spec URL | string | null | no |
| api_policy_xml | API policy XML | string | null | no |
| tags | Resource tags | map(string) | {} | no |

## Outputs

| Name | Description |
|------|-------------|
| id | APIM instance ID |
| name | APIM instance name |
| gateway_url | Gateway URL |
| gateway_regional_url | Regional gateway URL |
| developer_portal_url | Developer portal URL |
| management_api_url | Management API URL |
| identity_principal_id | Managed identity principal ID |
| identity_tenant_id | Managed identity tenant ID |
| api_id | API ID |
| api_path | API path |

## SKU Options

- **Consumption_0**: Serverless (pay-per-call)
- **Developer_1**: Development/testing
- **Basic_1**: Entry-level production
- **Standard_1**: Production with SLA
- **Premium_1**: Enterprise with multi-region

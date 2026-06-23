# =============================================================================
# API Management Module Local Values
# =============================================================================

locals {
  # Common tags applied to all resources
  common_tags = merge(var.tags, {
    Module = "api-management"
  })

  # Filter out empty/wildcard origins for CORS (wildcard not compatible with credentials)
  cors_origins_filtered = [for o in var.cors_allowed_origins : o if o != "" && o != "*"]

  # Check if Entra ID auth is configured — use plan-time-known variable for count decisions
  enable_entra_auth = var.enable_entra_auth

  # Use custom policy if provided, otherwise use generated policy
  effective_policy_xml = var.api_policy_xml != null ? var.api_policy_xml : (
    local.enable_entra_auth ? local.entra_policy_xml : null
  )
}

# Generate Entra ID policy as a separate local to avoid heredoc issues
locals {
  entra_policy_xml = <<-XML
<policies>
  <inbound>
    <base />
    <cors allow-credentials="true">
      <allowed-origins>
        ${join("\n        ", [for origin in local.cors_origins_filtered : "<origin>${origin}</origin>"])}
      </allowed-origins>
      <allowed-methods>
        <method>*</method>
      </allowed-methods>
      <allowed-headers>
        <header>*</header>
      </allowed-headers>
      <expose-headers>
        <header>*</header>
      </expose-headers>
    </cors>
    <choose>
      <when condition="@(context.Request.Url.Path.Contains("/api-docs") || context.Request.Url.Path.Contains("/openapi.json") || context.Request.Url.Path.Contains("/health"))">
        <!-- Skip JWT validation for public endpoints -->
      </when>
      <otherwise>
        <validate-jwt header-name="Authorization" failed-validation-httpcode="401" require-scheme="Bearer">
          <openid-config url="https://login.microsoftonline.com/${coalesce(var.azure_tenant_id, "organizations")}/v2.0/.well-known/openid-configuration" />
          <audiences>
            <audience>${coalesce(var.azure_client_id, "PLACEHOLDER-CLIENT-ID")}</audience>
          </audiences>
        </validate-jwt>
      </otherwise>
    </choose>
    <set-header name="X-User-Id" exists-action="override">
      <value>@{
        var authHeader = context.Request.Headers.GetValueOrDefault("Authorization", "");
        if (string.IsNullOrEmpty(authHeader)) { return ""; }
        var token = authHeader.Split(' ').Last();
        var jwt = token.AsJwt();
        if (jwt == null) { return ""; }
        return jwt.Claims.GetValueOrDefault("oid", jwt.Claims.GetValueOrDefault("sub", ""));
      }</value>
    </set-header>
    <set-header name="X-User-Email" exists-action="override">
      <value>@{
        var authHeader = context.Request.Headers.GetValueOrDefault("Authorization", "");
        if (string.IsNullOrEmpty(authHeader)) { return ""; }
        var token = authHeader.Split(' ').Last();
        var jwt = token.AsJwt();
        if (jwt == null) { return ""; }
        return jwt.Claims.GetValueOrDefault("preferred_username", jwt.Claims.GetValueOrDefault("email", ""));
      }</value>
    </set-header>
    <set-header name="X-User-Name" exists-action="override">
      <value>@{
        var authHeader = context.Request.Headers.GetValueOrDefault("Authorization", "");
        if (string.IsNullOrEmpty(authHeader)) { return ""; }
        var token = authHeader.Split(' ').Last();
        var jwt = token.AsJwt();
        if (jwt == null) { return ""; }
        return jwt.Claims.GetValueOrDefault("name", "");
      }</value>
    </set-header>
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
  <on-error>
    <base />
    <!-- Return CORS headers on error responses so browsers see the real status code
         instead of a misleading CORS error when JWT validation fails -->
    <set-header name="Access-Control-Allow-Origin" exists-action="override">
      <value>@{
        var origin = context.Request.Headers.GetValueOrDefault("Origin", "");
        var allowed = new [] { ${join(", ", [for origin in local.cors_origins_filtered : "\"${origin}\""])} };
        return Array.Exists(allowed, o => o == origin) ? origin : "";
      }</value>
    </set-header>
    <set-header name="Access-Control-Allow-Credentials" exists-action="override">
      <value>true</value>
    </set-header>
  </on-error>
</policies>
XML
}

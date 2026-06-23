# =============================================================================
# Pronghorn Terraform State Bootstrap Script
# =============================================================================
# Ensures the shared Terraform backend resource group, storage account, and
# blob container exist before Terraform initializes the azurerm backend.
# The script is idempotent and safe to run repeatedly.
# Prerequisite: the executing Azure identity must have Azure RBAC permission
# to manage the target resource group/storage account and Storage Blob Data
# Contributor access on the tfstate storage account for blob operations.
# =============================================================================

param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SubscriptionId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ResourceGroupName,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$StorageAccountName,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ContainerName,

    [Parameter(Mandatory = $false)]
    [string]$StateKey,

    [Parameter(Mandatory = $false)]
    [string]$Location = "canadacentral",

    [Parameter(Mandatory = $false)]
    [string]$TfvarsPath,

    [Parameter(Mandatory = $false)]
    [ValidateRange(10, 1800)]
    [int]$WaitTimeoutSeconds = 300,

    [Parameter(Mandatory = $false)]
    [ValidateRange(1, 300)]
    [int]$PollIntervalSeconds = 10,

    # Resource ID of the subnet that hosts the tfstate private endpoint. When set,
    # the script creates a blob private endpoint and disables public network
    # access on the storage account (PBMM private-endpoint mode). When omitted,
    # the value is resolved from 'storage_private_endpoint_subnet_id' in the
    # tfvars file. In PBMM mode (-SkipSecurityControlTag) a resolvable subnet is
    # mandatory and the script fails fast if none is found.
    [Parameter(Mandatory = $false)]
    [string]$PrivateEndpointSubnetId,

    # Optional resource ID of the central 'privatelink.blob.core.windows.net'
    # private DNS zone. When supplied the script wires an explicit DNS zone group
    # on the private endpoint. When omitted the script relies on Azure Policy
    # (DeployIfNotExists) to attach the central DNS zone group to the endpoint.
    [Parameter(Mandatory = $false)]
    [string]$BlobPrivateDnsZoneId,

    # When set, all private DNS zone group attachment is delegated to the
    # landing-zone Azure Policy (DeployIfNotExists). The script creates the blob
    # private endpoint but wires NO DNS zone group, and defers disabling public
    # network access until AFTER the blob container is created -- so bootstrap
    # never depends on private-endpoint DNS resolution (which policy attaches
    # asynchronously). Use in PBMM/GoA environments where the executing identity
    # has no access to the central DNS subscription. Mirrors the Terraform
    # 'delegate_private_dns_to_policy' toggle.
    [Parameter(Mandatory = $false)]
    [switch]$DelegatePrivateDnsToPolicy,

    [Parameter(Mandatory = $false)]
    [switch]$SkipSecurityControlTag
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Message) Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
function Write-Success { param([string]$Message) Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-Info { param([string]$Message) Write-Host "-> $Message" -ForegroundColor Yellow }
function Write-Failure { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }

function Invoke-AzCli {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & az @Arguments 2>&1
    $exitCode = $LASTEXITCODE

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output   = ($output | Out-String).Trim()
    }
}

function Wait-ForCondition {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,

        [Parameter(Mandatory = $true)]
        [scriptblock]$Condition
    )

    $attempt = 0
    $maxAttempts = [Math]::Ceiling($WaitTimeoutSeconds / $PollIntervalSeconds)
    if ($maxAttempts -lt 1) {
        $maxAttempts = 1
    }

    while ($attempt -lt $maxAttempts) {
        $attempt++
        if (& $Condition) {
            Write-Success $Description
            return
        }

        if ($attempt -lt $maxAttempts) {
            Write-Info "$Description not ready yet; retrying in $PollIntervalSeconds seconds ($attempt/$maxAttempts)"
            Start-Sleep -Seconds $PollIntervalSeconds
        }
    }

    throw "$Description was not ready within $WaitTimeoutSeconds seconds."
}

function Get-StorageAccountProvisioningState {
    $result = Invoke-AzCli -Arguments @(
        "storage", "account", "show",
        "--resource-group", $ResourceGroupName,
        "--name", $StorageAccountName,
        "--query", "provisioningState",
        "-o", "tsv",
        "--only-show-errors"
    )

    if ($result.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.Output)) {
        return $null
    }

    return $result.Output
}

function Get-ContainerExists {
    $result = Invoke-AzCli -Arguments @(
        "storage", "container", "exists",
        "--name", $ContainerName,
        "--account-name", $StorageAccountName,
        "--auth-mode", "login",
        "--query", "exists",
        "-o", "tsv",
        "--only-show-errors"
    )

    if ($result.ExitCode -ne 0) {
        return $null
    }

    switch -Regex ($result.Output) {
        "^true$" { return $true }
        "^false$" { return $false }
        default { return $null }
    }
}

function Set-GitHubVariableFileValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    if (-not [string]::IsNullOrWhiteSpace($FilePath)) {
        Add-Content -Path $FilePath -Value "$Name=$Value"
    }
}

function Resolve-FilePath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return $Path
    }

    return [System.IO.Path]::GetFullPath((Join-Path $PWD.Path $Path))
}

function Get-TerraformVariableDefaultValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$VariablesFileContent,

        [Parameter(Mandatory = $true)]
        [string]$VariableName
    )

    $variablePattern = 'variable\s+"' + [regex]::Escape($VariableName) + '"\s*\{(?<body>.*?)\}'
    $variableMatch = [regex]::Match(
        $VariablesFileContent,
        $variablePattern,
        [System.Text.RegularExpressions.RegexOptions]::Singleline -bor [System.Text.RegularExpressions.RegexOptions]::Multiline
    )
    if (-not $variableMatch.Success) {
        return $null
    }

    $body = $variableMatch.Groups['body'].Value
    $stringDefaultMatch = [regex]::Match($body, '(?m)^\s*default\s*=\s*"(?<value>[^"]*)"')
    if ($stringDefaultMatch.Success) {
        return $stringDefaultMatch.Groups['value'].Value.Trim()
    }

    $rawDefaultMatch = [regex]::Match($body, '(?m)^\s*default\s*=\s*(?<value>[^\r\n#]+)')
    if ($rawDefaultMatch.Success) {
        return $rawDefaultMatch.Groups['value'].Value.Trim()
    }

    return $null
}

function Get-TfvarsScalarValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TfvarsContent,

        [Parameter(Mandatory = $true)]
        [string]$VariableName
    )

    $quotedPattern = '(?m)^\s*' + [regex]::Escape($VariableName) + '\s*=\s*"(?<value>[^"]*)"'
    $quotedMatch = [regex]::Match($TfvarsContent, $quotedPattern)
    if ($quotedMatch.Success) {
        return $quotedMatch.Groups['value'].Value.Trim()
    }

    $rawPattern = '(?m)^\s*' + [regex]::Escape($VariableName) + '\s*=\s*(?<value>[^\r\n#]+)'
    $rawMatch = [regex]::Match($TfvarsContent, $rawPattern)
    if ($rawMatch.Success) {
        return $rawMatch.Groups['value'].Value.Trim()
    }

    return $null
}

function Get-TfvarsMapValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TfvarsContent,

        [Parameter(Mandatory = $true)]
        [string]$VariableName
    )

    $map = [ordered]@{}
    $mapPattern = '(?ms)^\s*' + [regex]::Escape($VariableName) + '\s*=\s*\{(?<body>.*?)\}'
    $mapMatch = [regex]::Match($TfvarsContent, $mapPattern)
    if (-not $mapMatch.Success) {
        return $map
    }

    $entryMatches = [regex]::Matches(
        $mapMatch.Groups['body'].Value,
        '(?m)^\s*(?<key>[A-Za-z0-9_-]+)\s*=\s*(?:"(?<quoted>[^"]*)"|(?<raw>[^\r\n#]+))'
    )
    foreach ($entryMatch in $entryMatches) {
        $value = $entryMatch.Groups['quoted'].Value
        if ([string]::IsNullOrWhiteSpace($value)) {
            $value = $entryMatch.Groups['raw'].Value.Trim()
        }

        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $map[$entryMatch.Groups['key'].Value] = $value
        }
    }

    return $map
}

function ConvertTo-AzTagArguments {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Tags
    )

    $arguments = New-Object System.Collections.Generic.List[string]
    if ($Tags.Count -eq 0) {
        return @()
    }

    $arguments.Add("--tags")
    foreach ($key in ($Tags.Keys | Sort-Object)) {
        $arguments.Add("$key=$($Tags[$key])")
    }

    return $arguments.ToArray()
}

function Get-BootstrapTags {
    $infraRoot = (Get-Item -LiteralPath $PSScriptRoot).Parent.FullName
    $resolvedTfvarsPath = Resolve-FilePath -Path $TfvarsPath

    if ([string]::IsNullOrWhiteSpace($resolvedTfvarsPath) -and -not [string]::IsNullOrWhiteSpace($env:TFVARS_FILE)) {
        $resolvedTfvarsPath = [System.IO.Path]::GetFullPath((Join-Path $infraRoot $env:TFVARS_FILE))
    }

    # Read all variable definition files (supports split variables-*.tf layout)
    $variableFiles = Get-ChildItem -Path $infraRoot -Filter "variables*.tf" -File
    if ($variableFiles.Count -eq 0) {
        throw "Unable to find any Terraform variable files (variables*.tf) in '$infraRoot' for bootstrap tag resolution."
    }
    $variablesFileContent = ($variableFiles | ForEach-Object { Get-Content -Path $_.FullName -Raw }) -join "`n"
    $tfvarsContent = $null
    if (-not [string]::IsNullOrWhiteSpace($resolvedTfvarsPath) -and (Test-Path -LiteralPath $resolvedTfvarsPath)) {
        $tfvarsContent = Get-Content -Path $resolvedTfvarsPath -Raw
        Write-Info "Resolving bootstrap tags from tfvars file '$resolvedTfvarsPath'"
    }
    else {
        Write-Info "No tfvars file found for bootstrap tag resolution; using Terraform defaults"
    }

    $tagVariableMap = [ordered]@{
        Project            = "project_name"
        Environment        = "environment"
        ClientOrganization = "client_organization"
        CostCenter         = "cost_center"
        DataSensitivity    = "data_sensitivity"
        ProjectContact     = "project_contact"
        ProjectName        = "project_name_tag"
        TechnicalContact   = "technical_contact"
    }

    $resourceGroupTags = [ordered]@{
        ManagedBy = "Terraform"
    }

    foreach ($tagName in $tagVariableMap.Keys) {
        $variableName = $tagVariableMap[$tagName]
        $value = $null

        if (-not [string]::IsNullOrWhiteSpace($tfvarsContent)) {
            $value = Get-TfvarsScalarValue -TfvarsContent $tfvarsContent -VariableName $variableName
        }

        if ([string]::IsNullOrWhiteSpace($value)) {
            $value = Get-TerraformVariableDefaultValue -VariablesFileContent $variablesFileContent -VariableName $variableName
        }

        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $resourceGroupTags[$tagName] = $value
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($tfvarsContent)) {
        $extraTags = Get-TfvarsMapValue -TfvarsContent $tfvarsContent -VariableName "extra_tags"
        foreach ($tagKey in $extraTags.Keys) {
            $resourceGroupTags[$tagKey] = $extraTags[$tagKey]
        }
    }

    $storageAccountTags = [ordered]@{}
    foreach ($tagKey in $resourceGroupTags.Keys) {
        $storageAccountTags[$tagKey] = $resourceGroupTags[$tagKey]
    }
    # The SecurityControl=Ignore tag is a dev-only policy exemption that allows the
    # tfstate storage account to keep public network access enabled. PBMM landing
    # zones reach the storage account over private endpoints, so the exemption tag
    # must NOT be applied there (pass -SkipSecurityControlTag from the PBMM workflow).
    if (-not $SkipSecurityControlTag) {
        $storageAccountTags["SecurityControl"] = "Ignore"
    }
    else {
        Write-Info "Skipping SecurityControl=Ignore tag (PBMM private-endpoint mode)"
    }

    return [pscustomobject]@{
        ResourceGroupTags  = $resourceGroupTags
        StorageAccountTags = $storageAccountTags
    }
}

function Get-ResolvedTfvarsContent {
    # Resolves the active tfvars file (explicit -TfvarsPath, else $env:TFVARS_FILE
    # relative to the infra root) and returns its raw content, or $null when no
    # tfvars file can be located.
    $infraRoot = (Get-Item -LiteralPath $PSScriptRoot).Parent.FullName
    $resolvedTfvarsPath = Resolve-FilePath -Path $TfvarsPath

    if ([string]::IsNullOrWhiteSpace($resolvedTfvarsPath) -and -not [string]::IsNullOrWhiteSpace($env:TFVARS_FILE)) {
        $resolvedTfvarsPath = [System.IO.Path]::GetFullPath((Join-Path $infraRoot $env:TFVARS_FILE))
    }

    if (-not [string]::IsNullOrWhiteSpace($resolvedTfvarsPath) -and (Test-Path -LiteralPath $resolvedTfvarsPath)) {
        return Get-Content -Path $resolvedTfvarsPath -Raw
    }

    return $null
}

function Disable-TfStatePublicNetworkAccess {
    # Disables public network access on the tfstate storage account (private
    # endpoint only). PBMM hard requirement -- the account must never be reachable
    # over the public endpoint. The AzureServices bypass is retained so platform
    # services and the DeployIfNotExists DNS policy can still operate.
    Write-Info "Disabling public network access on '$StorageAccountName' (private endpoint only)"
    $lockdownResult = Invoke-AzCli -Arguments @(
        "storage", "account", "update",
        "--resource-group", $ResourceGroupName,
        "--name", $StorageAccountName,
        "--public-network-access", "Disabled",
        "--default-action", "Deny",
        "--bypass", "AzureServices",
        "--only-show-errors"
    )
    if ($lockdownResult.ExitCode -ne 0) {
        throw "Unable to disable public network access on '$StorageAccountName'. $($lockdownResult.Output)"
    }
    Write-Success "Public network access disabled on '$StorageAccountName' (private endpoint only)"
}

function Set-TfStatePrivateNetworking {
    # Ensures the tfstate storage account is reachable only over a private
    # endpoint: creates an idempotent blob private endpoint in the supplied
    # subnet, optionally wires a DNS zone group, then disables public network
    # access. Safe to run repeatedly. When -DeferPublicAccessLockdown is set the
    # public-access lockdown is skipped (the caller performs it later) so that
    # bootstrap blob operations can run before policy-attached DNS is available.
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$SubnetId,

        [Parameter(Mandatory = $false)]
        [string]$DnsZoneId,

        [Parameter(Mandatory = $false)]
        [switch]$DeferPublicAccessLockdown
    )

    $storageAccountIdResult = Invoke-AzCli -Arguments @(
        "storage", "account", "show",
        "--resource-group", $ResourceGroupName,
        "--name", $StorageAccountName,
        "--query", "id",
        "-o", "tsv",
        "--only-show-errors"
    )
    if ($storageAccountIdResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($storageAccountIdResult.Output)) {
        throw "Unable to resolve resource ID for storage account '$StorageAccountName'. $($storageAccountIdResult.Output)"
    }
    $storageAccountId = $storageAccountIdResult.Output

    $privateEndpointName = "$StorageAccountName-blob-pe"
    $connectionName = "$StorageAccountName-blob-conn"

    # 1. Ensure the private endpoint exists (idempotent).
    $privateEndpointShowResult = Invoke-AzCli -Arguments @(
        "network", "private-endpoint", "show",
        "--resource-group", $ResourceGroupName,
        "--name", $privateEndpointName,
        "--query", "id",
        "-o", "tsv",
        "--only-show-errors"
    )
    if ($privateEndpointShowResult.ExitCode -ne 0) {
        Write-Info "Creating blob private endpoint '$privateEndpointName' in the provided subnet"
        $privateEndpointCreateResult = Invoke-AzCli -Arguments @(
            "network", "private-endpoint", "create",
            "--resource-group", $ResourceGroupName,
            "--name", $privateEndpointName,
            "--subnet", $SubnetId,
            "--private-connection-resource-id", $storageAccountId,
            "--group-id", "blob",
            "--connection-name", $connectionName,
            "--only-show-errors"
        )
        if ($privateEndpointCreateResult.ExitCode -ne 0) {
            throw "Unable to create private endpoint '$privateEndpointName'. $($privateEndpointCreateResult.Output)"
        }
        Write-Success "Created blob private endpoint '$privateEndpointName'"
    }
    else {
        Write-Success "Blob private endpoint '$privateEndpointName' already exists"
    }

    # 2. DNS resolution: prefer an explicit zone group; otherwise rely on Azure
    #    Policy (DeployIfNotExists) to attach the central blob DNS zone group.
    if (-not [string]::IsNullOrWhiteSpace($DnsZoneId)) {
        $dnsZoneGroupShowResult = Invoke-AzCli -Arguments @(
            "network", "private-endpoint", "dns-zone-group", "show",
            "--resource-group", $ResourceGroupName,
            "--endpoint-name", $privateEndpointName,
            "--name", "default",
            "--query", "id",
            "-o", "tsv",
            "--only-show-errors"
        )
        if ($dnsZoneGroupShowResult.ExitCode -ne 0) {
            Write-Info "Creating DNS zone group for '$privateEndpointName'"
            $dnsZoneGroupCreateResult = Invoke-AzCli -Arguments @(
                "network", "private-endpoint", "dns-zone-group", "create",
                "--resource-group", $ResourceGroupName,
                "--endpoint-name", $privateEndpointName,
                "--name", "default",
                "--private-dns-zone", $DnsZoneId,
                "--zone-name", "blob",
                "--only-show-errors"
            )
            if ($dnsZoneGroupCreateResult.ExitCode -ne 0) {
                throw "Unable to create DNS zone group for '$privateEndpointName'. $($dnsZoneGroupCreateResult.Output)"
            }
            Write-Success "Created DNS zone group for '$privateEndpointName'"
        }
        else {
            Write-Success "DNS zone group for '$privateEndpointName' already exists"
        }
    }
    else {
        Write-Info "No -BlobPrivateDnsZoneId supplied; relying on Azure Policy to attach the central blob private DNS zone group to '$privateEndpointName'."
    }

    # 3. Disable public network access (private endpoint only). PBMM hard
    #    requirement -- the account must never be reachable over the public
    #    endpoint. When -DeferPublicAccessLockdown is set the caller performs the
    #    lockdown later (after the blob container is created) so bootstrap blob
    #    operations do not depend on policy-attached private-endpoint DNS.
    if ($DeferPublicAccessLockdown) {
        Write-Info "Deferring public network access lockdown on '$StorageAccountName' until after the blob container is created (DNS policy delegation)."
    }
    else {
        Disable-TfStatePublicNetworkAccess
    }
}

Write-Step "Selecting Azure subscription"
$setSubscriptionResult = Invoke-AzCli -Arguments @(
    "account", "set",
    "--subscription", $SubscriptionId,
    "--only-show-errors"
)
if ($setSubscriptionResult.ExitCode -ne 0) {
    throw "Unable to select Azure subscription '$SubscriptionId'. $($setSubscriptionResult.Output)"
}
Write-Success "Using Azure subscription $SubscriptionId"

$bootstrapTags = Get-BootstrapTags
$resourceGroupTags = $bootstrapTags.ResourceGroupTags
$storageAccountTags = $bootstrapTags.StorageAccountTags

Write-Step "Ensuring tfstate resource group exists"
$resourceGroupExistsResult = Invoke-AzCli -Arguments @(
    "group", "exists",
    "--name", $ResourceGroupName,
    "-o", "tsv",
    "--only-show-errors"
)
if ($resourceGroupExistsResult.ExitCode -ne 0) {
    throw "Unable to read Azure resource group '$ResourceGroupName'. $($resourceGroupExistsResult.Output)"
}

if ($resourceGroupExistsResult.Output -ne "true") {
    Write-Info "Creating resource group '$ResourceGroupName' in '$Location' with required tags"
}
else {
    Write-Info "Ensuring resource group '$ResourceGroupName' has required tags"
}

$resourceGroupCreateArguments = @(
    "group", "create",
    "--name", $ResourceGroupName,
    "--location", $Location
) + (ConvertTo-AzTagArguments -Tags $resourceGroupTags) + @(
    "--only-show-errors"
)
$resourceGroupCreateResult = Invoke-AzCli -Arguments $resourceGroupCreateArguments
if ($resourceGroupCreateResult.ExitCode -ne 0) {
    throw "Unable to ensure Azure resource group '$ResourceGroupName'. $($resourceGroupCreateResult.Output)"
}

if ($resourceGroupExistsResult.Output -ne "true") {
    Write-Success "Created resource group '$ResourceGroupName'"
}
else {
    Write-Success "Resource group '$ResourceGroupName' is ready"
}

Write-Step "Ensuring tfstate storage account exists"
$storageAccountShowResult = Invoke-AzCli -Arguments @(
    "storage", "account", "show",
    "--resource-group", $ResourceGroupName,
    "--name", $StorageAccountName,
    "--query", "id",
    "-o", "tsv",
    "--only-show-errors"
)

if ($storageAccountShowResult.ExitCode -ne 0) {
    Write-Info "Creating storage account '$StorageAccountName'"
    $storageAccountCreateResult = Invoke-AzCli -Arguments (@(
            "storage", "account", "create",
            "--resource-group", $ResourceGroupName,
            "--name", $StorageAccountName,
            "--location", $Location,
            "--sku", "Standard_LRS",
            "--kind", "StorageV2",
            "--https-only", "true",
            "--min-tls-version", "TLS1_2",
            "--allow-blob-public-access", "false",
            "--allow-shared-key-access", "false",
            "--only-show-errors"
        ) + (ConvertTo-AzTagArguments -Tags $storageAccountTags))
    if ($storageAccountCreateResult.ExitCode -ne 0) {
        throw "Unable to create storage account '$StorageAccountName'. $($storageAccountCreateResult.Output)"
    }
    Write-Success "Created storage account '$StorageAccountName'"
}
else {
    Write-Success "Storage account '$StorageAccountName' already exists"
}

Write-Step "Waiting for tfstate storage account to finish provisioning"
Wait-ForCondition -Description "Storage account '$StorageAccountName' provisioning" -Condition {
    (Get-StorageAccountProvisioningState) -eq "Succeeded"
}

Write-Step "Ensuring tfstate storage account tags are applied"
$storageAccountTagUpdateResult = Invoke-AzCli -Arguments (@(
        "storage", "account", "update",
        "--resource-group", $ResourceGroupName,
        "--name", $StorageAccountName,
        "--only-show-errors"
    ) + (ConvertTo-AzTagArguments -Tags $storageAccountTags))
if ($storageAccountTagUpdateResult.ExitCode -ne 0) {
    throw "Unable to update tags on storage account '$StorageAccountName'. $($storageAccountTagUpdateResult.Output)"
}
Write-Success "Storage account '$StorageAccountName' tags are ready"

Write-Step "Enforcing private network access on tfstate storage account"
$privateEndpointSubnetId = $PrivateEndpointSubnetId
if ([string]::IsNullOrWhiteSpace($privateEndpointSubnetId)) {
    $tfvarsContentForPrivateEndpoint = Get-ResolvedTfvarsContent
    if (-not [string]::IsNullOrWhiteSpace($tfvarsContentForPrivateEndpoint)) {
        $privateEndpointSubnetId = Get-TfvarsScalarValue -TfvarsContent $tfvarsContentForPrivateEndpoint -VariableName "storage_private_endpoint_subnet_id"
    }
}

if (-not [string]::IsNullOrWhiteSpace($privateEndpointSubnetId)) {
    $effectiveBlobDnsZoneId = $BlobPrivateDnsZoneId
    if ($DelegatePrivateDnsToPolicy) {
        if (-not [string]::IsNullOrWhiteSpace($BlobPrivateDnsZoneId)) {
            Write-Info "Ignoring -BlobPrivateDnsZoneId because -DelegatePrivateDnsToPolicy is set; Azure Policy owns DNS zone group attachment."
        }
        $effectiveBlobDnsZoneId = ""
    }
    Set-TfStatePrivateNetworking -SubnetId $privateEndpointSubnetId -DnsZoneId $effectiveBlobDnsZoneId -DeferPublicAccessLockdown:$DelegatePrivateDnsToPolicy
}
elseif ($SkipSecurityControlTag) {
    throw "PBMM deployments require the tfstate storage account to be private. No private-endpoint subnet was provided via -PrivateEndpointSubnetId and 'storage_private_endpoint_subnet_id' was not found in the tfvars file. Public network access is not permitted in PBMM."
}
else {
    Write-Info "No private-endpoint subnet resolved; leaving public network access unchanged (non-PBMM/dev mode)."
}

Write-Step "Waiting for tfstate blob endpoint to become reachable"
Write-Info "Using Azure AD auth for blob operations; the current identity needs Storage Blob Data Contributor on '$StorageAccountName'."
Wait-ForCondition -Description "Storage account '$StorageAccountName' blob service" -Condition {
    $containerExists = Get-ContainerExists
    return $null -ne $containerExists
}

Write-Step "Ensuring tfstate blob container exists"
$containerExists = Get-ContainerExists
if ($containerExists -eq $true) {
    Write-Success "Blob container '$ContainerName' already exists"
}
else {
    Write-Info "Creating blob container '$ContainerName'"
    $containerCreateResult = Invoke-AzCli -Arguments @(
        "storage", "container", "create",
        "--name", $ContainerName,
        "--account-name", $StorageAccountName,
        "--auth-mode", "login",
        "--public-access", "off",
        "--only-show-errors"
    )
    if ($containerCreateResult.ExitCode -ne 0) {
        throw "Unable to create blob container '$ContainerName'. $($containerCreateResult.Output)"
    }
    Write-Success "Created blob container '$ContainerName'"
}

Write-Step "Waiting for tfstate blob container to be ready"
Wait-ForCondition -Description "Blob container '$ContainerName'" -Condition {
    (Get-ContainerExists) -eq $true
}

# In DNS policy-delegation mode the public-access lockdown was deferred so the
# container could be created over the (still-public) endpoint before Azure Policy
# attaches the private-endpoint DNS zone group. Now that the container exists,
# disable public network access to satisfy the PBMM private-endpoint requirement.
if (-not [string]::IsNullOrWhiteSpace($privateEndpointSubnetId) -and $DelegatePrivateDnsToPolicy) {
    Write-Step "Disabling public network access on tfstate storage account (deferred for DNS policy delegation)"
    Disable-TfStatePublicNetworkAccess
}

Write-Step "Publishing resolved backend values"
Set-GitHubVariableFileValue -FilePath $env:GITHUB_ENV -Name "TFSTATE_RESOURCE_GROUP" -Value $ResourceGroupName
Set-GitHubVariableFileValue -FilePath $env:GITHUB_ENV -Name "TFSTATE_STORAGE_ACCOUNT" -Value $StorageAccountName
Set-GitHubVariableFileValue -FilePath $env:GITHUB_ENV -Name "TFSTATE_CONTAINER" -Value $ContainerName

Set-GitHubVariableFileValue -FilePath $env:GITHUB_OUTPUT -Name "resource_group_name" -Value $ResourceGroupName
Set-GitHubVariableFileValue -FilePath $env:GITHUB_OUTPUT -Name "storage_account_name" -Value $StorageAccountName
Set-GitHubVariableFileValue -FilePath $env:GITHUB_OUTPUT -Name "container_name" -Value $ContainerName

if (-not [string]::IsNullOrWhiteSpace($StateKey)) {
    Set-GitHubVariableFileValue -FilePath $env:GITHUB_ENV -Name "TFSTATE_KEY" -Value $StateKey
    Set-GitHubVariableFileValue -FilePath $env:GITHUB_OUTPUT -Name "key" -Value $StateKey
}

Write-Success "Terraform shared state resources are ready"

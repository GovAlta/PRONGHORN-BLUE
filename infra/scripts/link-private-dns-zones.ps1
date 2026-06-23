# =============================================================================
# Private DNS Zone Linker
# =============================================================================
# Discovers PaaS services in a target resource group, determines the private DNS
# zones required for those services, and links any matching zones from a shared
# private DNS resource group to the target virtual network if the links do not
# already exist.
# =============================================================================

param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$TargetSubscriptionId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$TargetResourceGroupName,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$TargetVnetName,

    [Parameter(Mandatory = $false)]
    [string]$TargetVnetResourceGroupName,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SourceSubscriptionId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SourceResourceGroupName
)

$ErrorActionPreference = "Stop"
$resolvedTargetVnetResourceGroupName = if ([string]::IsNullOrWhiteSpace($TargetVnetResourceGroupName)) {
    $TargetResourceGroupName
} else {
    $TargetVnetResourceGroupName
}

function Write-Step { param([string]$Message) Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
function Write-Success { param([string]$Message) Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-Info { param([string]$Message) Write-Host "-> $Message" -ForegroundColor Yellow }
function Write-Warn { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor DarkYellow }
function Write-Failure { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }

function Invoke-AzJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI command failed: az $($Arguments -join ' ')`n$($output | Out-String)"
    }

    $text = ($output | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }

    return $text | ConvertFrom-Json
}

function Invoke-AzTsv {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI command failed: az $($Arguments -join ' ')`n$($output | Out-String)"
    }

    return ($output | Out-String).Trim()
}

function Add-ZoneCandidate {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.HashSet[string]]$ZoneNames,

        [Parameter(Mandatory = $true)]
        [string]$ZoneName
    )

    if (-not [string]::IsNullOrWhiteSpace($ZoneName)) {
        [void]$ZoneNames.Add($ZoneName.ToLowerInvariant())
    }
}

function Get-ManagedEnvironmentZoneCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ResourceId,

        [Parameter(Mandatory = $true)]
        [string]$SubscriptionId
    )

    $candidates = New-Object System.Collections.Generic.List[string]
    $defaultDomain = Invoke-AzTsv -Arguments @(
        "resource", "show",
        "--ids", $ResourceId,
        "--subscription", $SubscriptionId,
        "--query", "properties.defaultDomain",
        "-o", "tsv"
    )

    if ([string]::IsNullOrWhiteSpace($defaultDomain)) {
        return $candidates
    }

    $candidates.Add($defaultDomain)

    if ($defaultDomain -match "^(?<prefix>.+?)\.(?<region>[^.]+)\.azurecontainerapps\.io$") {
        $candidates.Add("$($Matches.prefix).privatelink.$($Matches.region).azurecontainerapps.io")
    }

    return $candidates
}

function New-LinkName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetResourceGroup,

        [Parameter(Mandatory = $true)]
        [string]$TargetVnetName
    )

    $rawName = "link-$TargetResourceGroup-$TargetVnetName"
    $sanitized = ($rawName.ToLowerInvariant() -replace "[^a-z0-9-]", "-") -replace "-+", "-"
    return $sanitized.Trim('-').Substring(0, [Math]::Min($sanitized.Trim('-').Length, 80))
}

Write-Step "Resolving target virtual network"

$targetVnetId = Invoke-AzTsv -Arguments @(
    "network", "vnet", "show",
    "--subscription", $TargetSubscriptionId,
    "--resource-group", $resolvedTargetVnetResourceGroupName,
    "--name", $TargetVnetName,
    "--query", "id",
    "-o", "tsv"
)

if ([string]::IsNullOrWhiteSpace($targetVnetId)) {
    throw "Virtual network '$TargetVnetName' was not found in resource group '$resolvedTargetVnetResourceGroupName' (subscription '$TargetSubscriptionId')."
}

Write-Success "Target VNet resolved: $targetVnetId"

Write-Step "Discovering target PaaS resources"

$resources = Invoke-AzJson -Arguments @(
    "resource", "list",
    "--subscription", $TargetSubscriptionId,
    "--resource-group", $TargetResourceGroupName,
    "--query", "[].{id:id,name:name,type:type}",
    "-o", "json"
)

$zoneCandidates = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)

foreach ($resource in @($resources)) {
    switch -Regex ($resource.type.ToLowerInvariant()) {
        "^microsoft\.keyvault/vaults$" {
            Add-ZoneCandidate -ZoneNames $zoneCandidates -ZoneName "privatelink.vaultcore.azure.net"
        }
        "^microsoft\.storage/storageaccounts$" {
            Add-ZoneCandidate -ZoneNames $zoneCandidates -ZoneName "privatelink.blob.core.windows.net"
        }
        "^microsoft\.containerregistry/registries$" {
            Add-ZoneCandidate -ZoneNames $zoneCandidates -ZoneName "privatelink.azurecr.io"
        }
        "^microsoft\.cognitiveservices/accounts$" {
            Add-ZoneCandidate -ZoneNames $zoneCandidates -ZoneName "privatelink.cognitiveservices.azure.com"
        }
        "^microsoft\.dbforpostgresql/flexibleservers$" {
            Add-ZoneCandidate -ZoneNames $zoneCandidates -ZoneName "private.postgres.database.azure.com"
            Add-ZoneCandidate -ZoneNames $zoneCandidates -ZoneName "privatelink.postgres.database.azure.com"
        }
        "^microsoft\.app/managedenvironments$" {
            foreach ($candidate in Get-ManagedEnvironmentZoneCandidates -ResourceId $resource.id -SubscriptionId $TargetSubscriptionId) {
                Add-ZoneCandidate -ZoneNames $zoneCandidates -ZoneName $candidate
            }
        }
        "^microsoft\.apimanagement/service$" {
            Add-ZoneCandidate -ZoneNames $zoneCandidates -ZoneName "privatelink.azure-api.net"
        }
    }
}

if ($zoneCandidates.Count -eq 0) {
    Write-Warn "No candidate private DNS zones were inferred from the resources in '$TargetResourceGroupName'."
    exit 0
}

Write-Info "Candidate private DNS zones: $(@($zoneCandidates) -join ', ')"

Write-Step "Loading source private DNS zones"

$sourceZones = Invoke-AzJson -Arguments @(
    "network", "private-dns", "zone", "list",
    "--subscription", $SourceSubscriptionId,
    "--resource-group", $SourceResourceGroupName,
    "--query", "[].{name:name,id:id}",
    "-o", "json"
)

$matchingZones = @($sourceZones | Where-Object { $zoneCandidates.Contains($_.name) })

if ($matchingZones.Count -eq 0) {
    Write-Warn "No matching private DNS zones were found in '$SourceResourceGroupName'."
    exit 0
}

Write-Success "Matching zones found: $($matchingZones.name -join ', ')"

Write-Step "Ensuring VNet links exist"

$linkName = New-LinkName -TargetResourceGroup $TargetResourceGroupName -TargetVnetName $TargetVnetName

foreach ($zone in $matchingZones) {
    $existingLinkName = Invoke-AzTsv -Arguments @(
        "network", "private-dns", "link", "vnet", "list",
        "--subscription", $SourceSubscriptionId,
        "--resource-group", $SourceResourceGroupName,
        "--zone-name", $zone.name,
        "--query", "[?virtualNetwork.id=='$targetVnetId'].name | [0]",
        "-o", "tsv"
    )

    if (-not [string]::IsNullOrWhiteSpace($existingLinkName)) {
        Write-Success "Zone '$($zone.name)' is already linked via '$existingLinkName'."
        continue
    }

    Write-Info "Creating VNet link for zone '$($zone.name)'."
    $null = & az network private-dns link vnet create `
        --subscription $SourceSubscriptionId `
        --resource-group $SourceResourceGroupName `
        --zone-name $zone.name `
        --name $linkName `
        --virtual-network $targetVnetId `
        --registration-enabled false `
        --only-show-errors 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create VNet link for private DNS zone '$($zone.name)'."
    }

    Write-Success "Linked zone '$($zone.name)' to VNet '$TargetVnetName'."
}

Write-Success "Private DNS zone linking completed."

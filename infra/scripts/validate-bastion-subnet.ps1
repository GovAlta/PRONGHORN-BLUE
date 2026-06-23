# =============================================================================
# Shared Network Subnet Validator
# =============================================================================
# Validates that the configured shared-network subnet prefixes are compatible
# with the live target virtual network before Terraform plans or applies changes.
# =============================================================================

param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$TfVarsFile,

    [Parameter(Mandatory = $false)]
    [string]$SubscriptionId,

    [Parameter(Mandatory = $false)]
    [string]$VirtualNetworkResourceGroupName,

    [Parameter(Mandatory = $false)]
    [string]$VirtualNetworkName,

    [Parameter(Mandatory = $false)]
    [string]$BastionSubnetName,

    [Parameter(Mandatory = $false)]
    [string]$BastionSubnetAddressPrefix
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Message) Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
function Write-Success { param([string]$Message) Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-Info { param([string]$Message) Write-Host "-> $Message" -ForegroundColor Yellow }

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

function Get-TfVarsRawValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $pattern = '(?m)^\s*' + [regex]::Escape($Name) + '\s*=\s*(.+?)\s*$'
    $match = [regex]::Match($Content, $pattern)
    if (-not $match.Success) {
        return $null
    }

    return $match.Groups[1].Value.Trim()
}

function Get-TfVarsStringValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $rawValue = Get-TfVarsRawValue -Content $Content -Name $Name
    if ([string]::IsNullOrWhiteSpace($rawValue)) {
        return $null
    }

    if ($rawValue.StartsWith('"') -and $rawValue.EndsWith('"')) {
        return $rawValue.Substring(1, $rawValue.Length - 2)
    }

    return $rawValue
}

function Get-TfVarsBoolValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $rawValue = Get-TfVarsRawValue -Content $Content -Name $Name
    if ([string]::IsNullOrWhiteSpace($rawValue)) {
        return $null
    }

    if ($rawValue -ieq 'true') {
        return $true
    }

    if ($rawValue -ieq 'false') {
        return $false
    }

    throw "The tfvars value for '$Name' must be true or false."
}

function Resolve-ConfigValue {
    param(
        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [string]$ExplicitValue,

        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [string]$TfVarsValue,

        [Parameter(Mandatory = $true)]
        [string]$DefaultValue
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitValue)) {
        return $ExplicitValue
    }

    if (-not [string]::IsNullOrWhiteSpace($TfVarsValue)) {
        return $TfVarsValue
    }

    return $DefaultValue
}

function ConvertTo-Ipv4UInt32 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Address
    )

    $ipAddress = [System.Net.IPAddress]::Parse($Address)
    $bytes = $ipAddress.GetAddressBytes()
    if ($bytes.Length -ne 4) {
        throw "Only IPv4 CIDR prefixes are supported: $Address"
    }

    [array]::Reverse($bytes)
    return [BitConverter]::ToUInt32($bytes, 0)
}

function Get-CidrRange {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Cidr
    )

    $parts = $Cidr.Split('/')
    if ($parts.Count -ne 2) {
        throw "Invalid CIDR prefix: $Cidr"
    }

    $prefixLength = 0
    if (-not [int]::TryParse($parts[1], [ref]$prefixLength)) {
        throw "Invalid CIDR prefix length: $Cidr"
    }

    if ($prefixLength -lt 0 -or $prefixLength -gt 32) {
        throw "CIDR prefix length must be between 0 and 32: $Cidr"
    }

    $ipValue = ConvertTo-Ipv4UInt32 -Address $parts[0]
    $hostBits = 32 - $prefixLength
    $mask = if ($prefixLength -eq 0) {
        [uint32]0
    }
    else {
        [uint32]([math]::Pow(2, 32) - [math]::Pow(2, $hostBits))
    }

    $network = [uint64]([uint32]($ipValue -band $mask))
    $size = [uint64][math]::Pow(2, $hostBits)
    $broadcast = $network + $size - 1

    return [pscustomobject]@{
        Prefix = $Cidr
        Start  = $network
        End    = $broadcast
    }
}

function Test-CidrOverlap {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Left,

        [Parameter(Mandatory = $true)]
        [string]$Right
    )

    $leftRange = Get-CidrRange -Cidr $Left
    $rightRange = Get-CidrRange -Cidr $Right
    return -not ($leftRange.End -lt $rightRange.Start -or $rightRange.End -lt $leftRange.Start)
}

function Test-CidrContained {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Child,

        [Parameter(Mandatory = $true)]
        [string]$Parent
    )

    $childRange = Get-CidrRange -Cidr $Child
    $parentRange = Get-CidrRange -Cidr $Parent
    return $childRange.Start -ge $parentRange.Start -and $childRange.End -le $parentRange.End
}

function Add-PlannedSubnet {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Subnets,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$Prefix,

        [Parameter(Mandatory = $true)]
        [string]$Purpose
    )

    $Subnets.Add([pscustomobject]@{
            Name    = $Name
            Prefix  = $Prefix
            Purpose = $Purpose
        }) | Out-Null
}

function Test-SubnetGroupAgainstVnet {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SubscriptionId,

        [Parameter(Mandatory = $true)]
        [string]$VirtualNetworkResourceGroupName,

        [Parameter(Mandatory = $true)]
        [string]$VirtualNetworkName,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$PlannedSubnets,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if ($PlannedSubnets.Count -eq 0) {
        return
    }

    Write-Step "Resolving target virtual network for $Label"
    $virtualNetwork = Invoke-AzJson -Arguments @(
        'network', 'vnet', 'show',
        '--subscription', $SubscriptionId,
        '--resource-group', $VirtualNetworkResourceGroupName,
        '--name', $VirtualNetworkName,
        '-o', 'json'
    )

    Write-Success "Resolved VNet '$VirtualNetworkName' in resource group '$VirtualNetworkResourceGroupName'."

    $addressSpacePrefixes = @($virtualNetwork.addressSpace.addressPrefixes)
    if ($addressSpacePrefixes.Count -eq 0) {
        throw "The target virtual network '$VirtualNetworkName' does not have any address space prefixes configured."
    }

    $plannedSubnetConflicts = New-Object System.Collections.Generic.List[string]
    for ($index = 0; $index -lt $PlannedSubnets.Count; $index++) {
        for ($comparisonIndex = $index + 1; $comparisonIndex -lt $PlannedSubnets.Count; $comparisonIndex++) {
            $left = $PlannedSubnets[$index]
            $right = $PlannedSubnets[$comparisonIndex]
            if (Test-CidrOverlap -Left $left.Prefix -Right $right.Prefix) {
                $plannedSubnetConflicts.Add("$($left.Purpose) '$($left.Name)' ($($left.Prefix)) overlaps $($right.Purpose) '$($right.Name)' ($($right.Prefix))") | Out-Null
            }
        }
    }

    if ($plannedSubnetConflicts.Count -gt 0) {
        throw "The configured $Label subnet prefixes overlap each other: $($plannedSubnetConflicts -join '; ')."
    }

    foreach ($plannedSubnet in $PlannedSubnets) {
        $containedInVnet = $false
        foreach ($addressSpacePrefix in $addressSpacePrefixes) {
            if (Test-CidrContained -Child $plannedSubnet.Prefix -Parent $addressSpacePrefix) {
                $containedInVnet = $true
                break
            }
        }

        if (-not $containedInVnet) {
            throw "The $($plannedSubnet.Purpose) subnet prefix '$($plannedSubnet.Prefix)' is not contained within the VNet address space(s): $($addressSpacePrefixes -join ', ')."
        }
    }

    $conflictsBySubnet = @{}
    foreach ($plannedSubnet in $PlannedSubnets) {
        $conflictsBySubnet[$plannedSubnet.Name] = New-Object System.Collections.Generic.List[string]
    }

    foreach ($subnet in @($virtualNetwork.subnets)) {
        $subnetPrefixes = @()
        if ($subnet.addressPrefixes) {
            $subnetPrefixes = @($subnet.addressPrefixes)
        }
        elseif ($subnet.addressPrefix) {
            $subnetPrefixes = @($subnet.addressPrefix)
        }

        foreach ($subnetPrefix in $subnetPrefixes) {
            foreach ($plannedSubnet in $PlannedSubnets) {
                if ($subnet.name -eq $plannedSubnet.Name -and $subnetPrefix -eq $plannedSubnet.Prefix) {
                    Write-Success "Existing $($plannedSubnet.Purpose) subnet '$($plannedSubnet.Name)' already uses '$($plannedSubnet.Prefix)'."
                    continue
                }

                if (Test-CidrOverlap -Left $plannedSubnet.Prefix -Right $subnetPrefix) {
                    $conflictsBySubnet[$plannedSubnet.Name].Add("$($subnet.name) ($subnetPrefix)") | Out-Null
                }
            }
        }
    }

    foreach ($plannedSubnet in $PlannedSubnets) {
        $subnetConflicts = $conflictsBySubnet[$plannedSubnet.Name]
        if ($subnetConflicts.Count -gt 0) {
            throw "The $($plannedSubnet.Purpose) subnet prefix '$($plannedSubnet.Prefix)' overlaps existing subnet(s): $($subnetConflicts -join ', ')."
        }
    }

    Write-Info "VNet address space(s): $($addressSpacePrefixes -join ', ')"
    Write-Info "Validated $Label subnets: $((@($PlannedSubnets | ForEach-Object { "$($_.Purpose): $($_.Name) [$($_.Prefix)]" })) -join '; ')"
    Write-Success "Configured $Label subnet prefixes do not overlap any existing subnet in '$VirtualNetworkName'."
}

if (-not (Test-Path $TfVarsFile)) {
    throw "Terraform variables file was not found: $TfVarsFile"
}

$tfVarsContent = Get-Content -Path $TfVarsFile -Raw
$archetype = Get-TfVarsStringValue -Content $tfVarsContent -Name 'archetype'
if ([string]::IsNullOrWhiteSpace($archetype)) {
    $archetype = 'online'
}

$enableBastionHost = Get-TfVarsBoolValue -Content $tfVarsContent -Name 'enable_bastion_host'
if ($null -eq $enableBastionHost) {
    # Bastion validation is opt-in. PBMM/corp landing zones consume
    # platform-provided subnets by ID and never have Terraform create an
    # AzureBastionSubnet, so validating one against the live VNet (where the
    # platform may already own that address range) produces false conflicts.
    # Only validate the managed Bastion subnet when a deployment explicitly
    # sets enable_bastion_host = true in tfvars.
    $enableBastionHost = $false
}

if (-not $enableBastionHost -and $archetype -ne 'corp' -and [string]::IsNullOrWhiteSpace((Get-TfVarsStringValue -Content $tfVarsContent -Name 'application_private_endpoint_virtual_network_name'))) {
    Write-Success "No managed subnets are enabled in tfvars. Skipping subnet validation."
    exit 0
}

$resolvedSubscriptionId = if (-not [string]::IsNullOrWhiteSpace($SubscriptionId)) {
    $SubscriptionId
}
else {
    Get-TfVarsStringValue -Content $tfVarsContent -Name 'subscription_id'
}

if ([string]::IsNullOrWhiteSpace($resolvedSubscriptionId)) {
    throw "subscription_id must be provided either in tfvars or as a script parameter."
}

$resolvedVnetResourceGroupName = Resolve-ConfigValue -ExplicitValue $VirtualNetworkResourceGroupName -TfVarsValue (Get-TfVarsStringValue -Content $tfVarsContent -Name 'corp_network_resource_group_name') -DefaultValue 'networking'
$resolvedVnetName = Resolve-ConfigValue -ExplicitValue $VirtualNetworkName -TfVarsValue (Get-TfVarsStringValue -Content $tfVarsContent -Name 'corp_network_virtual_network_name') -DefaultValue 'vnet'
$resolvedBastionSubnetName = Resolve-ConfigValue -ExplicitValue $BastionSubnetName -TfVarsValue (Get-TfVarsStringValue -Content $tfVarsContent -Name 'bastion_subnet_name') -DefaultValue 'AzureBastionSubnet'
$resolvedBastionSubnetAddressPrefix = Resolve-ConfigValue -ExplicitValue $BastionSubnetAddressPrefix -TfVarsValue (Get-TfVarsStringValue -Content $tfVarsContent -Name 'bastion_subnet_address_prefix') -DefaultValue '10.2.8.0/26'
$resolvedCorpAppGatewaySubnetName = Resolve-ConfigValue -ExplicitValue $null -TfVarsValue (Get-TfVarsStringValue -Content $tfVarsContent -Name 'corp_app_gateway_subnet_name') -DefaultValue 'appGateway'
$corpAppGatewaySubnetAddressPrefix = Get-TfVarsStringValue -Content $tfVarsContent -Name 'corp_app_gateway_subnet_address_prefix'
$resolvedCorpPrivateEndpointSubnetName = Resolve-ConfigValue -ExplicitValue $null -TfVarsValue (Get-TfVarsStringValue -Content $tfVarsContent -Name 'corp_private_endpoint_subnet_name') -DefaultValue 'privateEndpoint'
$corpPrivateEndpointSubnetAddressPrefix = Get-TfVarsStringValue -Content $tfVarsContent -Name 'corp_private_endpoint_subnet_address_prefix'

$applicationPrivateEndpointVirtualNetworkResourceGroupName = Get-TfVarsStringValue -Content $tfVarsContent -Name 'application_private_endpoint_virtual_network_resource_group_name'
$applicationPrivateEndpointVirtualNetworkName = Get-TfVarsStringValue -Content $tfVarsContent -Name 'application_private_endpoint_virtual_network_name'
$applicationPrivateEndpointSubnetName = Resolve-ConfigValue -ExplicitValue $null -TfVarsValue (Get-TfVarsStringValue -Content $tfVarsContent -Name 'application_private_endpoint_subnet_name') -DefaultValue 'privateEndpoint'
$applicationPrivateEndpointSubnetAddressPrefix = Get-TfVarsStringValue -Content $tfVarsContent -Name 'application_private_endpoint_subnet_address_prefix'

$plannedSubnets = New-Object System.Collections.Generic.List[object]
$plannedApplicationPrivateEndpointSubnets = New-Object System.Collections.Generic.List[object]

if ($enableBastionHost) {
    Add-PlannedSubnet -Subnets $plannedSubnets -Name $resolvedBastionSubnetName -Prefix $resolvedBastionSubnetAddressPrefix -Purpose 'Azure Bastion'
}

if ($archetype -eq 'corp') {
    # In corp/PBMM landing zones the platform team typically pre-creates the
    # application gateway and private endpoint subnets and Pronghorn consumes
    # them by subnet ID. Only validate these managed subnets when an address
    # prefix is explicitly configured in tfvars (i.e. Pronghorn is creating
    # them); otherwise there is nothing for this script to manage.
    if (-not [string]::IsNullOrWhiteSpace($corpAppGatewaySubnetAddressPrefix)) {
        Add-PlannedSubnet -Subnets $plannedSubnets -Name $resolvedCorpAppGatewaySubnetName -Prefix $corpAppGatewaySubnetAddressPrefix -Purpose 'corp Application Gateway'
    }

    if (-not [string]::IsNullOrWhiteSpace($corpPrivateEndpointSubnetAddressPrefix)) {
        Add-PlannedSubnet -Subnets $plannedSubnets -Name $resolvedCorpPrivateEndpointSubnetName -Prefix $corpPrivateEndpointSubnetAddressPrefix -Purpose 'corp private endpoint'
    }
}

if (-not [string]::IsNullOrWhiteSpace($applicationPrivateEndpointVirtualNetworkName)) {
    if ([string]::IsNullOrWhiteSpace($applicationPrivateEndpointVirtualNetworkResourceGroupName) -or [string]::IsNullOrWhiteSpace($applicationPrivateEndpointSubnetAddressPrefix)) {
        throw "application_private_endpoint_virtual_network_resource_group_name and application_private_endpoint_subnet_address_prefix must be set when application_private_endpoint_virtual_network_name is configured."
    }

    Add-PlannedSubnet -Subnets $plannedApplicationPrivateEndpointSubnets -Name $applicationPrivateEndpointSubnetName -Prefix $applicationPrivateEndpointSubnetAddressPrefix -Purpose 'application private endpoint'
}

if ($plannedSubnets.Count -eq 0 -and $plannedApplicationPrivateEndpointSubnets.Count -eq 0) {
    Write-Success "No managed subnets are enabled in tfvars. Skipping subnet validation."
    exit 0
}

$maskBits = [int]($resolvedBastionSubnetAddressPrefix.Split('/')[1])
if ($enableBastionHost -and $maskBits -gt 26) {
    throw "Azure Bastion requires $resolvedBastionSubnetAddressPrefix to use a prefix length of /26 or less (for example /26, /25, or /24)."
}

if ($plannedSubnets.Count -gt 0 -and $plannedApplicationPrivateEndpointSubnets.Count -gt 0 -and $resolvedVnetResourceGroupName -eq $applicationPrivateEndpointVirtualNetworkResourceGroupName -and $resolvedVnetName -eq $applicationPrivateEndpointVirtualNetworkName) {
    foreach ($applicationSubnet in $plannedApplicationPrivateEndpointSubnets) {
        Add-PlannedSubnet -Subnets $plannedSubnets -Name $applicationSubnet.Name -Prefix $applicationSubnet.Prefix -Purpose $applicationSubnet.Purpose
    }
    $plannedApplicationPrivateEndpointSubnets = New-Object System.Collections.Generic.List[object]
}

Test-SubnetGroupAgainstVnet -SubscriptionId $resolvedSubscriptionId -VirtualNetworkResourceGroupName $resolvedVnetResourceGroupName -VirtualNetworkName $resolvedVnetName -PlannedSubnets $plannedSubnets -Label 'shared-network'

if ($plannedApplicationPrivateEndpointSubnets.Count -gt 0) {
    Test-SubnetGroupAgainstVnet -SubscriptionId $resolvedSubscriptionId -VirtualNetworkResourceGroupName $applicationPrivateEndpointVirtualNetworkResourceGroupName -VirtualNetworkName $applicationPrivateEndpointVirtualNetworkName -PlannedSubnets $plannedApplicationPrivateEndpointSubnets -Label 'application private endpoint'
}

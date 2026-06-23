<#
.SYNOPSIS
    Creates the dedicated, isolated subnets required for a clean parallel Pronghorn
    PBMM deployment in the pubsec landing-zone VNet, mirroring the proven networking
    pattern of the existing deployment (NSG + shared route table associations).

.DESCRIPTION
    The pubsec (Canadian Public Sector) Azure Landing Zone applies governance policies,
    but none of them DENY creation of Microsoft.Network subnets or NSGs:
      - "Block Azure RM Resource Creation" only blocks Classic resource types.
      - "MCAPSGov Deny Policies" only restricts VM SKUs / AKS / OpenAI / SQL / KeyVault HSM.
      - NSG/UDR association policies are Audit/Modify (non-blocking, auto-remediating).

    This script therefore creates the subnets imperatively (the pbmm.tfvars consumes
    existing subnet IDs rather than creating them), attaching:
      - the SAME shared route table ("RouteTable") used by the existing egress subnets,
        so outbound traffic is force-tunnelled through the hub firewall (PBMM compliant);
      - the SAME analogous NSGs already approved for the existing deployment;
      - the correct service delegations for Container Apps and PostgreSQL Flexible Server.

    Private DNS resolution and hub peering are VNet-scoped and are inherited automatically,
    so private endpoints created later in the new PE subnet will resolve and route correctly.

    The script is idempotent: existing subnets (matched by name) are left untouched, and a
    final summary prints the resulting subnet resource IDs mapped to their pbmm.tfvars keys.

.PARAMETER SubscriptionId
    The subscription that hosts the workload VNet. Defaults to the discovered workload sub.

.PARAMETER ResourceGroup
    Resource group containing the VNet, NSGs, and route table. Defaults to "networking".

.PARAMETER VnetName
    The VNet to add subnets to. Defaults to "vnet".

.PARAMETER Prefix
    Short name prefix for the new subnets, used to keep them clearly isolated from the
    existing deployment (e.g. "pghpbmm" -> "pghpbmm-aca-platform").

.PARAMETER DryRun
    When set, prints the planned actions without creating any resources.

.EXAMPLE
    ./New-PbmmSubnets.ps1 -DryRun

.EXAMPLE
    ./New-PbmmSubnets.ps1 -Prefix pghpbmm
#>
[CmdletBinding()]
param(
  [Parameter()]
  [string]$SubscriptionId = '00000000-0000-0000-0000-000000000000',

  [Parameter()]
  [string]$ResourceGroup = 'networking',

  [Parameter()]
  [string]$VnetName = 'vnet',

  [Parameter()]
  [ValidatePattern('^[a-z0-9]{3,12}$')]
  [string]$Prefix = 'pghpbmm',

  [Parameter()]
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# --- Shared networking resource IDs (discovered from the existing, working deployment) ---
$nsgBase = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Network/networkSecurityGroups"
$routeTable = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Network/routeTables/RouteTable"

# --- Subnet plan ---------------------------------------------------------------------------
# Address space: existing subnets occupy 10.2.1.0/25 .. 10.2.9.0/25.
# New subnets are carved from the free, non-overlapping 10.2.10.0+ range as contiguous /25s.
# Sizing/NSG/UDR/delegation mirror the existing deployment's proven pattern.
$subnets = @(
  [pscustomobject]@{
    Name                 = "$Prefix-aca-platform"
    Prefix               = '10.2.10.0/25'
    Delegation           = 'Microsoft.App/environments'
    Nsg                  = "$nsgBase/webNsg"
    RouteTable           = $routeTable
    DisablePeNetPolicies = $false
    TfvarsKey            = 'container_apps_subnet_id'
  },
  [pscustomobject]@{
    Name                 = "$Prefix-aca-workload"
    Prefix               = '10.2.11.0/25'
    Delegation           = 'Microsoft.App/environments'
    Nsg                  = "$nsgBase/appManagementNsg"
    RouteTable           = $routeTable
    DisablePeNetPolicies = $false
    TfvarsKey            = 'workload_aca_subnet_id'
  },
  [pscustomobject]@{
    Name                 = "$Prefix-data"
    Prefix               = '10.2.12.0/25'
    Delegation           = 'Microsoft.DBforPostgreSQL/flexibleServers'
    Nsg                  = "$nsgBase/dataNsg"
    RouteTable           = $routeTable
    DisablePeNetPolicies = $false
    TfvarsKey            = 'delegated_subnet_id'
  },
  [pscustomobject]@{
    Name                 = "$Prefix-pe"
    Prefix               = '10.2.13.0/25'
    Delegation           = $null
    Nsg                  = "$nsgBase/vnet-PrivateEndpoint-nsg-canadacentral"
    RouteTable           = $null
    DisablePeNetPolicies = $true
    TfvarsKey            = '*_private_endpoint_subnet_id'
  },
  [pscustomobject]@{
    Name                 = "$Prefix-apim"
    Prefix               = '10.2.14.0/25'
    Delegation           = $null
    Nsg                  = "$nsgBase/apim-integration-nsg"
    RouteTable           = $null
    DisablePeNetPolicies = $false
    TfvarsKey            = 'apim_subnet_id'
  },
  [pscustomobject]@{
    Name                 = "$Prefix-acr-agents"
    Prefix               = '10.2.15.0/25'
    Delegation           = $null
    Nsg                  = "$nsgBase/vnet-AcrAgentPool-nsg-canadacentral"
    RouteTable           = $routeTable
    DisablePeNetPolicies = $false
    TfvarsKey            = 'acr_agent_pool_subnet_id'
  }
)

Write-Host "Setting subscription context: $SubscriptionId" -ForegroundColor Cyan
az account set --subscription $SubscriptionId | Out-Null

# Snapshot existing subnets for idempotency / overlap awareness.
$existing = az network vnet subnet list `
  --resource-group $ResourceGroup `
  --vnet-name $VnetName `
  --query "[].name" -o tsv

$results = New-Object System.Collections.Generic.List[object]

foreach ($s in $subnets) {
  if ($existing -contains $s.Name) {
    Write-Host "[skip] Subnet '$($s.Name)' already exists." -ForegroundColor Yellow
    $id = az network vnet subnet show --resource-group $ResourceGroup --vnet-name $VnetName --name $s.Name --query id -o tsv
    $results.Add([pscustomobject]@{ TfvarsKey = $s.TfvarsKey; Name = $s.Name; Prefix = $s.Prefix; Id = $id })
    continue
  }

  $createArgs = @(
    'network', 'vnet', 'subnet', 'create',
    '--resource-group', $ResourceGroup,
    '--vnet-name', $VnetName,
    '--name', $s.Name,
    '--address-prefixes', $s.Prefix,
    '--network-security-group', $s.Nsg
  )
  if ($s.Delegation) { $createArgs += @('--delegations', $s.Delegation) }
  if ($s.RouteTable) { $createArgs += @('--route-table', $s.RouteTable) }
  if ($s.DisablePeNetPolicies) { $createArgs += @('--disable-private-endpoint-network-policies', 'true') }

  if ($DryRun) {
    Write-Host "[dry-run] Would create '$($s.Name)' ($($s.Prefix))" -ForegroundColor DarkGray
    Write-Host "          delegation=$($s.Delegation)  udr=$([bool]$s.RouteTable)  nsg=$(Split-Path $s.Nsg -Leaf)" -ForegroundColor DarkGray
    $results.Add([pscustomobject]@{ TfvarsKey = $s.TfvarsKey; Name = $s.Name; Prefix = $s.Prefix; Id = '(dry-run)' })
    continue
  }

  Write-Host "[create] Subnet '$($s.Name)' ($($s.Prefix))..." -ForegroundColor Green
  $id = az @createArgs --query id -o tsv
  $results.Add([pscustomobject]@{ TfvarsKey = $s.TfvarsKey; Name = $s.Name; Prefix = $s.Prefix; Id = $id })
}

Write-Host "`n=== Subnet IDs for pbmm.tfvars ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize TfvarsKey, Name, Prefix, Id

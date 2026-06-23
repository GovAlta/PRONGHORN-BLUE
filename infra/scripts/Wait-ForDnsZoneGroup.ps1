<#
.SYNOPSIS
    Waits for Azure Policy to attach a DNS zone group to a private endpoint.

.DESCRIPTION
    In PBMM / GoA landing-zone environments, Azure Policy asynchronously creates
    Private DNS Zone Groups on private endpoints. This script polls until the
    zone group is attached, or times out.

    Adapted from bcgov/ai-hub-tracking wait-for-dns-zone.sh.

.PARAMETER ResourceGroup
    Resource group containing the private endpoint.

.PARAMETER PrivateEndpointName
    Name of the private endpoint to check.

.PARAMETER Subscription
    Optional Azure subscription ID.

.PARAMETER Timeout
    Timeout duration string (e.g., '10m', '600', '1h'). Default: 10m.

.PARAMETER Interval
    Poll interval string (e.g., '10s', '30', '1m'). Default: 10s.

.EXAMPLE
    .\Wait-ForDnsZoneGroup.ps1 -ResourceGroup "my-rg" -PrivateEndpointName "my-pe" -Timeout "10m"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ResourceGroup,

    [Parameter(Mandatory)]
    [string]$PrivateEndpointName,

    [string]$Subscription = "",

    [string]$Timeout = "10m",

    [string]$Interval = "10s"
)

$ErrorActionPreference = 'Stop'

function ConvertTo-Seconds {
    param([string]$Duration)
    if ($Duration -match '^\d+$') { return [int]$Duration }
    if ($Duration -match '^(\d+)s$') { return [int]$Matches[1] }
    if ($Duration -match '^(\d+)m$') { return [int]$Matches[1] * 60 }
    if ($Duration -match '^(\d+)h$') { return [int]$Matches[1] * 3600 }
    if ($Duration -match '^(\d+)d$') { return [int]$Matches[1] * 86400 }
    throw "Unsupported duration '$Duration'. Use e.g. 15s, 10m, 1h, or raw seconds."
}

$timeoutSec = ConvertTo-Seconds $Timeout
$intervalSec = ConvertTo-Seconds $Interval

if ($intervalSec -le 0) { throw "Interval must be > 0 seconds." }
if ($timeoutSec -le 0) { throw "Timeout must be > 0 seconds." }

Write-Host "Waiting for Azure Policy to attach DNS zone group to PE '$PrivateEndpointName' (rg='$ResourceGroup')..."
Write-Host "Timeout: $Timeout ($timeoutSec seconds), interval: $Interval ($intervalSec seconds)"

$subArgs = @()
if ($Subscription) { $subArgs += @('--subscription', $Subscription) }

$elapsed = 0
while ($true) {
    try {
        $count = az network private-endpoint dns-zone-group list `
            --resource-group $ResourceGroup `
            --endpoint-name $PrivateEndpointName `
            @subArgs `
            --query "length(@)" `
            --only-show-errors `
            -o tsv 2>$null

        if ($count -and [int]$count -gt 0) {
            Write-Host "DNS zone group found on PE '$PrivateEndpointName'."
            exit 0
        }
    }
    catch {
        # az CLI error (PE not ready yet, etc.) — keep polling
    }

    if ($elapsed -ge $timeoutSec) {
        Write-Error "Timed out waiting for DNS zone group on PE '$PrivateEndpointName' (rg='$ResourceGroup') after $Timeout."
        exit 1
    }

    Start-Sleep -Seconds $intervalSec
    $elapsed += $intervalSec
    Write-Host "  Waiting... ($elapsed/$timeoutSec seconds)"
}

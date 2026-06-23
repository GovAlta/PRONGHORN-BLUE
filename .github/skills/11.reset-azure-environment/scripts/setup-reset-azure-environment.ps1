<#
.SYNOPSIS
    Wrapper entrypoint for Pronghorn Azure environment reset automation.

.DESCRIPTION
    Calls Manage-ResetAzureEnvironment.ps1 and forwards all supported parameters.

.PARAMETER Action
    Action to execute: remove-app-registration, remove-resource-group, update-env-files, all.

.EXAMPLE
    .\setup-reset-azure-environment.ps1 -Action all -ResourceGroupName "pronghorn-blue" -AppDisplayName "pronghorn-app"
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('remove-app-registration', 'remove-resource-group', 'update-env-files', 'all')]
    [string]$Action = 'all',

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$ResourceGroupName = 'pronghorn-blue',

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$AppDisplayName = 'pronghorn-app',

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'Manage-ResetAzureEnvironment.ps1'
if (-not (Test-Path $scriptPath)) {
    throw "Missing script: $scriptPath"
}

& $scriptPath `
    -Action $Action `
    -ResourceGroupName $ResourceGroupName `
    -AppDisplayName $AppDisplayName `
    -RepoRoot $RepoRoot `
    -WhatIf:$WhatIfPreference

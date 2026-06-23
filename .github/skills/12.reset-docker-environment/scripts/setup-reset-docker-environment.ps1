<#
.SYNOPSIS
    Wrapper entrypoint for Pronghorn Docker environment reset automation.

.DESCRIPTION
    Calls Manage-ResetDockerEnvironment.ps1 and forwards supported parameters.

.PARAMETER Action
    Action to execute: reset-containers, list-containers, all.

.EXAMPLE
    .\setup-reset-docker-environment.ps1 -Action all
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('reset-containers', 'list-containers', 'all')]
    [string]$Action = 'all',

    [Parameter(Mandatory = $false)]
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'Manage-ResetDockerEnvironment.ps1'
if (-not (Test-Path $scriptPath)) {
    throw "Missing script: $scriptPath"
}

& $scriptPath `
    -Action $Action `
    -RepoRoot $RepoRoot `
    -WhatIf:$WhatIfPreference

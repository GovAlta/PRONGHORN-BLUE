<#
.SYNOPSIS
    Wrapper entrypoint for step 9 local AI model deployment automation.

.DESCRIPTION
    Calls Manage-AIModelsFromLocal.ps1 and forwards all supported parameters.

.PARAMETER Action
    Action to execute: list-models, check-prereqs, deploy-terraform, configure-api-env, all.

.EXAMPLE
    .\setup-ai-models-from-local.ps1 -Action list-models
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('list-models', 'check-prereqs', 'deploy-terraform', 'configure-api-env', 'all')]
    [string]$Action = 'all',

    [Parameter(Mandatory = $false)]
    [string]$SubscriptionId,

    [Parameter(Mandatory = $false)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory = $false)]
    [string]$AIServicesName,

    [Parameter(Mandatory = $false)]
    [string]$TfvarsPath = 'infra/params/dev.tfvars',

    [Parameter(Mandatory = $false)]
    [switch]$AutoApprove,

    [Parameter(Mandatory = $false)]
    [string]$FoundryEndpoint,

    [Parameter(Mandatory = $false)]
    [string]$FoundryApiKey,

    [Parameter(Mandatory = $false)]
    [string]$ApimOpenAiUrl
)

$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'Manage-AIModelsFromLocal.ps1'
if (-not (Test-Path $scriptPath)) {
    throw "Missing script: $scriptPath"
}

& $scriptPath `
    -Action $Action `
    -SubscriptionId $SubscriptionId `
    -ResourceGroupName $ResourceGroupName `
    -AIServicesName $AIServicesName `
    -TfvarsPath $TfvarsPath `
    -AutoApprove:$AutoApprove `
    -FoundryEndpoint $FoundryEndpoint `
    -FoundryApiKey $FoundryApiKey `
    -ApimOpenAiUrl $ApimOpenAiUrl

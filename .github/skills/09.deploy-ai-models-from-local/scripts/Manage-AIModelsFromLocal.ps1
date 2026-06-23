<#
.SYNOPSIS
    Automates local Azure AI Foundry model deployment workflow for sections 9.1, 9.2, 9.3, and 9.6.

.DESCRIPTION
    Provides a scoped automation entrypoint for:
    - 9.1 Available Models (display model catalog from infra/config/ai-models.json)
    - 9.2 Prerequisites (Azure CLI/login/provider checks)
    - 9.3 Terraform deployment (init/plan/apply)
    - 9.6 API environment configuration (FOUNDRY_* and APIM_OPENAI_URL)

    This script intentionally excludes other section 9 subsections.

.PARAMETER Action
    Action to execute: list-models, check-prereqs, deploy-terraform, configure-api-env, all.

.PARAMETER SubscriptionId
    Optional Azure subscription ID to set before Azure operations.

.PARAMETER ResourceGroupName
    Optional resource group name used to infer AI endpoint/key for API env configuration.

.PARAMETER AIServicesName
    Optional Azure AI Services account name used to infer endpoint/key for API env configuration.

.PARAMETER TfvarsPath
    Optional terraform tfvars path. Defaults to infra/params/dev.tfvars.

.PARAMETER AutoApprove
    If provided with deploy-terraform or all, runs terraform apply with auto-approve.

.PARAMETER FoundryEndpoint
    Optional explicit FOUNDRY_ENDPOINT value. Overrides discovered value.

.PARAMETER FoundryApiKey
    Optional explicit FOUNDRY_API_KEY value. Overrides discovered value.

.PARAMETER ApimOpenAiUrl
    Optional explicit APIM_OPENAI_URL value.

.EXAMPLE
    .\Manage-AIModelsFromLocal.ps1 -Action list-models

.EXAMPLE
    .\Manage-AIModelsFromLocal.ps1 -Action check-prereqs -SubscriptionId "00000000-0000-0000-0000-000000000000"

.EXAMPLE
    .\Manage-AIModelsFromLocal.ps1 -Action deploy-terraform -TfvarsPath "infra/params/dev.tfvars" -AutoApprove

.EXAMPLE
    .\Manage-AIModelsFromLocal.ps1 -Action configure-api-env -ResourceGroupName "pronghorn-blue" -AIServicesName "ai-pronghorn-dev"
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

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Get-RepoRoot {
    $resolved = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')
    return $resolved.Path
}

function Test-CommandAvailable {
    param([Parameter(Mandatory = $true)][string]$CommandName)

    return [bool](Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Invoke-ExternalCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $false)][string[]]$Arguments = @(),
        [Parameter(Mandatory = $false)][string]$WorkingDirectory
    )

    if ($WorkingDirectory) {
        Push-Location $WorkingDirectory
    }

    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: $FilePath $($Arguments -join ' ')"
        }
    }
    finally {
        if ($WorkingDirectory) {
            Pop-Location
        }
    }
}

function Test-AzurePrerequisites {
    param([string]$OptionalSubscriptionId)

    if (-not (Test-CommandAvailable -CommandName 'az')) {
        throw "Azure CLI is required. Install from https://learn.microsoft.com/cli/azure/install-azure-cli"
    }

    $null = az account show --query id -o tsv 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI is not authenticated. Run: az login"
    }

    if ($OptionalSubscriptionId) {
        Invoke-ExternalCommand -FilePath 'az' -Arguments @('account', 'set', '--subscription', $OptionalSubscriptionId)
        Write-Success "Active subscription set to $OptionalSubscriptionId"
    }

    $providers = @('Microsoft.CognitiveServices', 'Microsoft.Web')
    foreach ($provider in $providers) {
        $state = az provider show --namespace $provider --query registrationState -o tsv 2>$null
        if (-not $state) {
            throw "Unable to query provider state for $provider"
        }

        if ($state -ne 'Registered') {
            Write-Warn "$provider is $state. Registering now..."
            Invoke-ExternalCommand -FilePath 'az' -Arguments @('provider', 'register', '--namespace', $provider)
            Write-Success "$provider registration requested"
        }
        else {
            Write-Success "$provider is Registered: $provider"
        }
    }
}

function Show-AvailableModels {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    $modelsPath = Join-Path $RepoRoot 'infra/config/ai-models.json'
    if (-not (Test-Path $modelsPath)) {
        throw "Model config not found: $modelsPath"
    }

    $rawConfig = Get-Content -Path $modelsPath -Raw
    if ([string]::IsNullOrWhiteSpace($rawConfig)) {
        throw "Model config file is empty: $modelsPath"
    }

    $parsedConfig = $rawConfig | ConvertFrom-Json

    $modelItems = @()
    if ($parsedConfig.defaultModels -and $parsedConfig.defaultModels.Count -gt 0) {
        $modelItems = $parsedConfig.defaultModels
    }
    elseif ($parsedConfig.models -and $parsedConfig.models.Count -gt 0) {
        $modelItems = $parsedConfig.models
    }
    else {
        throw "No models defined under defaultModels or models in $modelsPath"
    }

    $table = $modelItems | Select-Object @{
        Name = 'Model'
        Expression = { if ($_.name) { $_.name } else { $_.modelName } }
    }, @{
        Name = 'DeploymentName'
        Expression = { $_.deploymentName }
    }, @{
        Name = 'Category'
        Expression = {
            if ($_.category) { $_.category }
            elseif ($_.modelFormat) { $_.modelFormat }
            else { '' }
        }
    }, @{
        Name = 'Capabilities'
        Expression = {
            if ($_.capabilities) { ($_.capabilities -join ',') }
            elseif ($_.description) { $_.description }
            else { '' }
        }
    }

    Write-Host ''
    $table | Format-Table -AutoSize | Out-String | Write-Host
    Write-Success 'Displayed available models (section 9.1)'
}

function Invoke-TerraformDeployment {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$Tfvars,
        [Parameter(Mandatory = $true)][bool]$ShouldAutoApprove
    )

    if (-not (Test-CommandAvailable -CommandName 'terraform')) {
        throw "Terraform is required. Install from https://developer.hashicorp.com/terraform/install"
    }

    $infraPath = Join-Path $RepoRoot 'infra'
    if (-not (Test-Path $infraPath)) {
        throw "Infra folder not found: $infraPath"
    }

    $resolvedTfvars = if ([System.IO.Path]::IsPathRooted($Tfvars)) { $Tfvars } else { Join-Path $RepoRoot $Tfvars }
    if (-not (Test-Path $resolvedTfvars)) {
        throw "tfvars file not found: $resolvedTfvars"
    }

    $resolvedApimPublisherEmail = $env:TF_VAR_apim_publisher_email
    if (-not $resolvedApimPublisherEmail -and (Test-CommandAvailable -CommandName 'az')) {
        $azAccountEmail = az account show --query user.name -o tsv 2>$null
        if ($LASTEXITCODE -eq 0 -and $azAccountEmail -match '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
            $resolvedApimPublisherEmail = $azAccountEmail
        }
    }

    if (-not $resolvedApimPublisherEmail) {
        $resolvedApimPublisherEmail = 'pronghorn-dev@local.invalid'
        Write-Warn 'Could not infer Azure account email; using fallback APIM publisher email.'
    }

    $apimPublisherEmailVar = "-var=apim_publisher_email=$resolvedApimPublisherEmail"
    Write-Info "Using APIM publisher email: $resolvedApimPublisherEmail"

    $planArguments = @('plan', "-var-file=$resolvedTfvars", $apimPublisherEmailVar)
    $applyArguments = if ($ShouldAutoApprove) {
        @('apply', '-auto-approve', "-var-file=$resolvedTfvars", $apimPublisherEmailVar)
    }
    else {
        @('apply', "-var-file=$resolvedTfvars", $apimPublisherEmailVar)
    }

    Write-Info 'Running terraform init'
    Invoke-ExternalCommand -FilePath 'terraform' -Arguments @('init') -WorkingDirectory $infraPath

    Write-Info "Running terraform plan -var-file=$resolvedTfvars"
    Invoke-ExternalCommand -FilePath 'terraform' -Arguments $planArguments -WorkingDirectory $infraPath

    if ($ShouldAutoApprove) {
        Write-Info "Running terraform apply -auto-approve -var-file=$resolvedTfvars"
        Invoke-ExternalCommand -FilePath 'terraform' -Arguments $applyArguments -WorkingDirectory $infraPath
    }
    else {
        Write-Info "Running terraform apply -var-file=$resolvedTfvars"
        Invoke-ExternalCommand -FilePath 'terraform' -Arguments $applyArguments -WorkingDirectory $infraPath
    }

    Write-Success 'Terraform deployment completed (section 9.3)'
}

function Get-EnvDictionary {
    param([Parameter(Mandatory = $true)][string]$EnvPath)

    $envMap = @{}
    if (-not (Test-Path $EnvPath)) {
        return $envMap
    }

    $lines = Get-Content -Path $EnvPath
    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) {
            continue
        }

        $separatorIndex = $line.IndexOf('=')
        if ($separatorIndex -lt 1) {
            continue
        }

        $key = $line.Substring(0, $separatorIndex).Trim()
        $value = $line.Substring($separatorIndex + 1)
        $envMap[$key] = $value
    }

    return $envMap
}

function Set-EnvDictionaryValue {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Map,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Key)) {
        throw 'Environment key cannot be empty.'
    }

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }

    $Map[$Key] = $Value
}

function Write-EnvDictionary {
    param(
        [Parameter(Mandatory = $true)][string]$EnvPath,
        [Parameter(Mandatory = $true)][hashtable]$Map
    )

    $orderedKeys = $Map.Keys | Sort-Object
    $content = ($orderedKeys | ForEach-Object { "$_=$($Map[$_])" }) -join [Environment]::NewLine

    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($EnvPath, $content + [Environment]::NewLine, $utf8NoBom)
}

function Resolve-FoundrySettings {
    param(
        [string]$OptionalEndpoint,
        [string]$OptionalApiKey,
        [string]$OptionalApimUrl,
        [string]$OptionalResourceGroup,
        [string]$OptionalAIServicesName
    )

    $resolvedEndpoint = $OptionalEndpoint
    $resolvedApiKey = $OptionalApiKey
    $resolvedApimUrl = $OptionalApimUrl

    if (($resolvedEndpoint -and $resolvedApiKey) -or (-not $OptionalResourceGroup -or -not $OptionalAIServicesName)) {
        return @{
            Endpoint = $resolvedEndpoint
            ApiKey = $resolvedApiKey
            ApimUrl = $resolvedApimUrl
        }
    }

    if (-not (Test-CommandAvailable -CommandName 'az')) {
        throw 'Azure CLI is required to infer Foundry endpoint/key. Provide explicit parameters or install Azure CLI.'
    }

    if (-not $resolvedEndpoint) {
        $resolvedEndpoint = az cognitiveservices account show --resource-group $OptionalResourceGroup --name $OptionalAIServicesName --query properties.endpoint -o tsv
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolvedEndpoint)) {
            throw 'Failed to infer FOUNDRY_ENDPOINT from Azure CLI.'
        }
    }

    if (-not $resolvedApiKey) {
        $resolvedApiKey = az cognitiveservices account keys list --resource-group $OptionalResourceGroup --name $OptionalAIServicesName --query key1 -o tsv
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolvedApiKey)) {
            throw 'Failed to infer FOUNDRY_API_KEY from Azure CLI.'
        }
    }

    return @{
        Endpoint = $resolvedEndpoint
        ApiKey = $resolvedApiKey
        ApimUrl = $resolvedApimUrl
    }
}

function Configure-ApiEnvironment {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [string]$OptionalEndpoint,
        [string]$OptionalApiKey,
        [string]$OptionalApimUrl,
        [string]$OptionalResourceGroup,
        [string]$OptionalAIServicesName
    )

    $resolved = Resolve-FoundrySettings `
        -OptionalEndpoint $OptionalEndpoint `
        -OptionalApiKey $OptionalApiKey `
        -OptionalApimUrl $OptionalApimUrl `
        -OptionalResourceGroup $OptionalResourceGroup `
        -OptionalAIServicesName $OptionalAIServicesName

    if (-not $resolved.Endpoint -or -not $resolved.ApiKey) {
        throw 'Could not resolve required Foundry values. Provide -FoundryEndpoint and -FoundryApiKey or provide -ResourceGroupName and -AIServicesName.'
    }

    $apiEnvPath = Join-Path $RepoRoot 'app/backend/.env'
    $envMap = Get-EnvDictionary -EnvPath $apiEnvPath

    Set-EnvDictionaryValue -Map $envMap -Key 'FOUNDRY_ENDPOINT' -Value $resolved.Endpoint
    Set-EnvDictionaryValue -Map $envMap -Key 'FOUNDRY_API_KEY' -Value $resolved.ApiKey

    if (-not [string]::IsNullOrWhiteSpace($resolved.ApimUrl)) {
        Set-EnvDictionaryValue -Map $envMap -Key 'APIM_OPENAI_URL' -Value $resolved.ApimUrl
    }

    Write-EnvDictionary -EnvPath $apiEnvPath -Map $envMap
    Write-Success "Updated API environment: $apiEnvPath (section 9.6)"
}

$repoRoot = Get-RepoRoot

switch ($Action) {
    'list-models' {
        Show-AvailableModels -RepoRoot $repoRoot
    }
    'check-prereqs' {
        Test-AzurePrerequisites -OptionalSubscriptionId $SubscriptionId
        Write-Success 'Prerequisites completed (section 9.2)'
    }
    'deploy-terraform' {
        Test-AzurePrerequisites -OptionalSubscriptionId $SubscriptionId
        Invoke-TerraformDeployment -RepoRoot $repoRoot -Tfvars $TfvarsPath -ShouldAutoApprove:$AutoApprove
    }
    'configure-api-env' {
        Configure-ApiEnvironment `
            -RepoRoot $repoRoot `
            -OptionalEndpoint $FoundryEndpoint `
            -OptionalApiKey $FoundryApiKey `
            -OptionalApimUrl $ApimOpenAiUrl `
            -OptionalResourceGroup $ResourceGroupName `
            -OptionalAIServicesName $AIServicesName
    }
    'all' {
        Show-AvailableModels -RepoRoot $repoRoot
        Test-AzurePrerequisites -OptionalSubscriptionId $SubscriptionId
        Invoke-TerraformDeployment -RepoRoot $repoRoot -Tfvars $TfvarsPath -ShouldAutoApprove:$AutoApprove
        Configure-ApiEnvironment `
            -RepoRoot $repoRoot `
            -OptionalEndpoint $FoundryEndpoint `
            -OptionalApiKey $FoundryApiKey `
            -OptionalApimUrl $ApimOpenAiUrl `
            -OptionalResourceGroup $ResourceGroupName `
            -OptionalAIServicesName $AIServicesName
    }
    default {
        throw "Unsupported action: $Action"
    }
}

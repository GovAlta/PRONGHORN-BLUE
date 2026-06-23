<#
.SYNOPSIS
    Deploys AI models to Azure AI Foundry (Microsoft Foundry - New Architecture).

.DESCRIPTION
    This script deploys AI models to an existing Azure AI Foundry (AI Services) instance.
    It can be used for model deployments that are not managed by Terraform, or for
    ad-hoc model deployment and testing.

    Prerequisites:
    - Azure CLI installed and logged in (az login)
    - Azure subscription access with Cognitive Services Contributor role
    - Existing AI Services account created via Terraform

.PARAMETER ResourceGroupName
    The name of the resource group containing the AI Services account.

.PARAMETER AIServicesName
    The name of the Azure AI Services account.

.PARAMETER ModelsConfigPath
    Optional. Path to a JSON file containing model configurations. 
    If not provided, uses default models defined in this script.

.PARAMETER DeployModel
    Specific model deployment name to deploy. If not specified, deploys all models.

.PARAMETER ListModels
    List all current model deployments without making changes.

.PARAMETER DeleteModel
    Delete a specific model deployment by name.

.EXAMPLE
    .\Deploy-AIModels.ps1 -ResourceGroupName "rg-pronghorn-dev" -AIServicesName "ai-pronghorn-abc123"
    
.EXAMPLE
    .\Deploy-AIModels.ps1 -ResourceGroupName "rg-pronghorn-dev" -AIServicesName "ai-pronghorn-abc123" -ListModels
    
.EXAMPLE
    .\Deploy-AIModels.ps1 -ResourceGroupName "rg-pronghorn-dev" -AIServicesName "ai-pronghorn-abc123" -DeployModel "gpt-4-1"

.NOTES
    Author: Pronghorn Team
    Version: 1.0.0
    Requires: Azure CLI 2.50+, PowerShell 7+
#>

[CmdletBinding(DefaultParameterSetName = 'Deploy')]
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory = $true)]
    [string]$AIServicesName,

    [Parameter(Mandatory = $false)]
    [string]$ModelsConfigPath,

    [Parameter(ParameterSetName = 'Deploy', Mandatory = $false)]
    [string]$DeployModel,

    [Parameter(ParameterSetName = 'List', Mandatory = $true)]
    [switch]$ListModels,

    [Parameter(ParameterSetName = 'Delete', Mandatory = $true)]
    [string]$DeleteModel
)

# =============================================================================
# Configuration
# =============================================================================

$ErrorActionPreference = "Stop"
$ApiVersion = "2024-06-01-preview"

# Default model configurations (used if ModelsConfigPath not provided)
$DefaultModels = @(
    @{
        deploymentName     = "gpt-4-1"
        modelName          = "gpt-4.1"
        modelVersion       = "2025-04-14"
        modelFormat        = "OpenAI"
        skuName            = "GlobalStandard"
        skuCapacity        = 20  # 20K TPM
        raiPolicyName      = "Microsoft.Default"
        versionUpgradeOption = "OnceCurrentVersionExpired"
    },
    @{
        deploymentName     = "gpt-4-1-mini"
        modelName          = "gpt-4.1-mini"
        modelVersion       = "2025-04-14"
        modelFormat        = "OpenAI"
        skuName            = "GlobalStandard"
        skuCapacity        = 50  # 50K TPM
        raiPolicyName      = "Microsoft.Default"
        versionUpgradeOption = "OnceCurrentVersionExpired"
    },
    @{
        deploymentName     = "o3"
        modelName          = "o3"
        modelVersion       = "2025-04-16"
        modelFormat        = "OpenAI"
        skuName            = "GlobalStandard"
        skuCapacity        = 10  # 10K TPM
        raiPolicyName      = "Microsoft.Default"
        versionUpgradeOption = "OnceCurrentVersionExpired"
    },
    @{
        deploymentName     = "o4-mini"
        modelName          = "o4-mini"
        modelVersion       = "2025-04-16"
        modelFormat        = "OpenAI"
        skuName            = "GlobalStandard"
        skuCapacity        = 20  # 20K TPM
        raiPolicyName      = "Microsoft.Default"
        versionUpgradeOption = "OnceCurrentVersionExpired"
    },
    @{
        deploymentName     = "gpt-4o"
        modelName          = "gpt-4o"
        modelVersion       = "2024-11-20"
        modelFormat        = "OpenAI"
        skuName            = "GlobalStandard"
        skuCapacity        = 30  # 30K TPM
        raiPolicyName      = "Microsoft.Default"
        versionUpgradeOption = "OnceCurrentVersionExpired"
    },
    @{
        deploymentName     = "gpt-4o-mini"
        modelName          = "gpt-4o-mini"
        modelVersion       = "2024-07-18"
        modelFormat        = "OpenAI"
        skuName            = "GlobalStandard"
        skuCapacity        = 100  # 100K TPM (cost-effective, higher capacity)
        raiPolicyName      = "Microsoft.Default"
        versionUpgradeOption = "OnceCurrentVersionExpired"
    }
)

# =============================================================================
# Helper Functions
# =============================================================================

function Write-Step {
    param([string]$Message)
    Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-Warning {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

function Write-Error {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
}

function Test-AzureCLI {
    try {
        $null = az --version 2>&1
        return $true
    }
    catch {
        return $false
    }
}

function Get-AzureAccessToken {
    $token = az account get-access-token --resource "https://cognitiveservices.azure.com" --query accessToken -o tsv
    if (-not $token) {
        throw "Failed to get Azure access token. Please run 'az login' first."
    }
    return $token
}

function Get-AIServicesResourceId {
    $resourceId = az cognitiveservices account show `
        --resource-group $ResourceGroupName `
        --name $AIServicesName `
        --query id -o tsv 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to find AI Services account '$AIServicesName' in resource group '$ResourceGroupName'"
    }
    return $resourceId
}

function Get-ExistingDeployments {
    $deployments = az cognitiveservices account deployment list `
        --resource-group $ResourceGroupName `
        --name $AIServicesName `
        --output json 2>&1 | ConvertFrom-Json

    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not list existing deployments. Assuming none exist."
        return @()
    }
    return $deployments
}

function Deploy-Model {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Model
    )

    $deploymentName = $Model.deploymentName
    Write-Host "`nDeploying model: $deploymentName" -ForegroundColor Yellow
    Write-Host "  Model: $($Model.modelName) v$($Model.modelVersion)"
    Write-Host "  SKU: $($Model.skuName) ($($Model.skuCapacity)K TPM)"

    # Check if deployment already exists
    $existingDeployments = Get-ExistingDeployments
    $existing = $existingDeployments | Where-Object { $_.name -eq $deploymentName }

    if ($existing) {
        Write-Warning "  Deployment '$deploymentName' already exists. Skipping."
        return $true
    }

    # Create deployment using Azure CLI
    try {
        $result = az cognitiveservices account deployment create `
            --resource-group $ResourceGroupName `
            --name $AIServicesName `
            --deployment-name $deploymentName `
            --model-name $Model.modelName `
            --model-version $Model.modelVersion `
            --model-format $Model.modelFormat `
            --sku-name $Model.skuName `
            --sku-capacity $Model.skuCapacity `
            --output json 2>&1

        if ($LASTEXITCODE -ne 0) {
            Write-Error "  Failed to deploy: $result"
            return $false
        }

        Write-Success "  Deployed successfully!"
        return $true
    }
    catch {
        Write-Error "  Exception during deployment: $_"
        return $false
    }
}

function Remove-ModelDeployment {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DeploymentName
    )

    Write-Host "`nDeleting deployment: $DeploymentName" -ForegroundColor Yellow

    try {
        $result = az cognitiveservices account deployment delete `
            --resource-group $ResourceGroupName `
            --name $AIServicesName `
            --deployment-name $DeploymentName `
            --output json 2>&1

        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to delete: $result"
            return $false
        }

        Write-Success "Deleted successfully!"
        return $true
    }
    catch {
        Write-Error "Exception during deletion: $_"
        return $false
    }
}

# =============================================================================
# Main Script
# =============================================================================

Write-Step "Azure AI Foundry Model Deployment"
Write-Host "Resource Group: $ResourceGroupName"
Write-Host "AI Services: $AIServicesName"

# Check Azure CLI
if (-not (Test-AzureCLI)) {
    throw "Azure CLI is not installed or not in PATH. Please install Azure CLI and run 'az login'."
}

# Verify logged in
Write-Step "Verifying Azure Authentication"
$account = az account show --output json 2>&1 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) {
    throw "Not logged in to Azure. Please run 'az login' first."
}
Write-Success "Logged in as: $($account.user.name)"
Write-Host "Subscription: $($account.name) ($($account.id))"

# Verify AI Services account exists
Write-Step "Verifying AI Services Account"
$resourceId = Get-AIServicesResourceId
Write-Success "Found AI Services: $AIServicesName"

# Load model configurations
$models = $DefaultModels
if ($ModelsConfigPath -and (Test-Path $ModelsConfigPath)) {
    Write-Step "Loading Model Configuration from File"
    $models = Get-Content $ModelsConfigPath | ConvertFrom-Json
    Write-Success "Loaded $($models.Count) model configurations"
}

# Execute based on parameter set
switch ($PSCmdlet.ParameterSetName) {
    'List' {
        Write-Step "Current Model Deployments"
        $deployments = Get-ExistingDeployments
        
        if ($deployments.Count -eq 0) {
            Write-Host "No model deployments found."
        }
        else {
            Write-Host "`nDeployment Name          Model                    Version      SKU          Capacity"
            Write-Host "------------------------ ------------------------ ------------ ------------ --------"
            foreach ($d in $deployments) {
                $modelName = $d.properties.model.name
                $modelVersion = $d.properties.model.version
                $skuName = $d.sku.name
                $capacity = $d.sku.capacity
                Write-Host ("{0,-24} {1,-24} {2,-12} {3,-12} {4}" -f $d.name, $modelName, $modelVersion, $skuName, $capacity)
            }
        }
    }
    'Delete' {
        Write-Step "Deleting Model Deployment"
        $success = Remove-ModelDeployment -DeploymentName $DeleteModel
        if (-not $success) {
            exit 1
        }
    }
    'Deploy' {
        Write-Step "Deploying AI Models"
        
        # Filter to specific model if requested
        if ($DeployModel) {
            $models = $models | Where-Object { $_.deploymentName -eq $DeployModel }
            if ($models.Count -eq 0) {
                throw "Model deployment '$DeployModel' not found in configuration."
            }
        }

        Write-Host "Models to deploy: $($models.Count)"
        
        $successCount = 0
        $failCount = 0
        
        foreach ($model in $models) {
            # Convert PSCustomObject to hashtable if needed
            if ($model -is [PSCustomObject]) {
                $modelHash = @{}
                $model.PSObject.Properties | ForEach-Object { $modelHash[$_.Name] = $_.Value }
                $model = $modelHash
            }
            
            $success = Deploy-Model -Model $model
            if ($success) { $successCount++ } else { $failCount++ }
            
            # Small delay between deployments to avoid rate limiting
            Start-Sleep -Seconds 2
        }
        
        Write-Step "Deployment Summary"
        Write-Success "Successful: $successCount"
        if ($failCount -gt 0) {
            Write-Error "Failed: $failCount"
        }
    }
}

# Show endpoints
Write-Step "AI Foundry Endpoints"
Write-Host "Foundry API:     https://$AIServicesName.services.ai.azure.com/"
Write-Host "OpenAI API:      https://$AIServicesName.openai.azure.com/"
Write-Host "Cognitive API:   https://$AIServicesName.cognitiveservices.azure.com/"
Write-Host "`nAPI Version: $ApiVersion"

Write-Host "`n✓ Done!" -ForegroundColor Green

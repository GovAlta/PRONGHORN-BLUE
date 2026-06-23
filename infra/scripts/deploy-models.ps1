<#
.SYNOPSIS
    Deploy AI models to Azure AI Foundry

.DESCRIPTION
    This script deploys AI models to the Azure AI Foundry (AI Services) account.
    Models are deployed as MaaS (Models as a Service) using the GlobalStandard SKU.
    
    NOTE: In Canada Central, OpenAI GPT models (gpt-4o, gpt-4.1, etc.) are not available
    with Standard/GlobalStandard SKU due to regional restrictions. This script deploys
    alternative models from the Azure AI model catalog.

.PARAMETER ResourceGroup
    The Azure resource group name

.PARAMETER AccountName
    The AI Services account name

.PARAMETER Environment
    Environment name (dev, prod) - used to auto-detect account name if not specified

.EXAMPLE
    .\deploy-models.ps1 -ResourceGroup "pronghorn-blue" -AccountName "ai-pronghorn-ekapfa"

.EXAMPLE
    .\deploy-models.ps1 -ResourceGroup "pronghorn-blue" -Environment "dev"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory = $false)]
    [string]$AccountName,

    [Parameter(Mandatory = $false)]
    [ValidateSet("dev", "prod")]
    [string]$Environment = "dev"
)

# If account name not provided, try to find it from Terraform outputs
if (-not $AccountName) {
    Write-Host "Account name not provided, attempting to find from Terraform state..." -ForegroundColor Yellow
    try {
        Push-Location (Join-Path $PSScriptRoot "..")
        $tfOutput = terraform output -json | ConvertFrom-Json
        $AccountName = $tfOutput.ai_foundry_account_name.value
        Pop-Location
        Write-Host "Found account: $AccountName" -ForegroundColor Green
    }
    catch {
        Write-Error "Could not determine account name. Please provide -AccountName parameter."
        exit 1
    }
}

# Model definitions - these are MaaS models available in Canada Central
$models = @(
    @{
        DeploymentName = "grok-3-mini"
        ModelName      = "grok-3-mini"
        ModelVersion   = "1"
        ModelFormat    = "xAI"
        SkuName        = "GlobalStandard"
        SkuCapacity    = 10
        Description    = "Fast, lightweight model with agent support"
    },
    @{
        DeploymentName = "deepseek-v3"
        ModelName      = "DeepSeek-V3.2"
        ModelVersion   = "1"
        ModelFormat    = "DeepSeek"
        SkuName        = "GlobalStandard"
        SkuCapacity    = 500
        Description    = "Powerful reasoning model with agent support"
    },
    @{
        DeploymentName = "llama-4-scout"
        ModelName      = "Llama-4-Scout-17B-16E-Instruct"
        ModelVersion   = "1"
        ModelFormat    = "Meta"
        SkuName        = "GlobalStandard"
        SkuCapacity    = 1
        Description    = "Meta Llama 4 Scout model for chat"
    }
)

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Azure AI Foundry Model Deployment Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Resource Group: $ResourceGroup"
Write-Host "Account Name:   $AccountName"
Write-Host "Environment:    $Environment"
Write-Host ""

# Check if account exists
Write-Host "Verifying AI Services account..." -ForegroundColor Yellow
$accountCheck = az cognitiveservices account show --resource-group $ResourceGroup --name $AccountName 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "AI Services account '$AccountName' not found in resource group '$ResourceGroup'"
    exit 1
}
Write-Host "Account verified!" -ForegroundColor Green

# List existing deployments
Write-Host "`nChecking existing deployments..." -ForegroundColor Yellow
$existingDeployments = az cognitiveservices account deployment list `
    --resource-group $ResourceGroup `
    --name $AccountName `
    --query "[].name" -o json | ConvertFrom-Json

Write-Host "Existing deployments: $($existingDeployments -join ', ')" -ForegroundColor Gray

# Deploy each model
foreach ($model in $models) {
    Write-Host "`n----------------------------------------" -ForegroundColor DarkGray
    Write-Host "Model: $($model.DeploymentName)" -ForegroundColor White
    Write-Host "Description: $($model.Description)" -ForegroundColor Gray
    
    if ($existingDeployments -contains $model.DeploymentName) {
        Write-Host "Status: Already deployed - skipping" -ForegroundColor Yellow
        continue
    }
    
    Write-Host "Deploying..." -ForegroundColor Cyan
    
    $result = az cognitiveservices account deployment create `
        --resource-group $ResourceGroup `
        --name $AccountName `
        --deployment-name $model.DeploymentName `
        --model-name $model.ModelName `
        --model-version $model.ModelVersion `
        --model-format $model.ModelFormat `
        --sku-name $model.SkuName `
        --sku-capacity $model.SkuCapacity 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Status: Deployed successfully!" -ForegroundColor Green
    }
    else {
        Write-Host "Status: FAILED" -ForegroundColor Red
        Write-Host "Error: $result" -ForegroundColor Red
    }
}

# Final summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Deployment Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$finalDeployments = az cognitiveservices account deployment list `
    --resource-group $ResourceGroup `
    --name $AccountName `
    --query "[].{Name:name, Model:properties.model.name, SKU:sku.name, Capacity:sku.capacity}" `
    -o table 2>&1

Write-Host $finalDeployments

# Get endpoint info
Write-Host "`n----------------------------------------" -ForegroundColor DarkGray
Write-Host "Endpoint Information" -ForegroundColor White
$endpoint = az cognitiveservices account show `
    --resource-group $ResourceGroup `
    --name $AccountName `
    --query "properties.endpoint" -o tsv

Write-Host "AI Services Endpoint: $endpoint"
Write-Host "AI Model Inference:   https://$AccountName.services.ai.azure.com/models"
Write-Host ""
Write-Host "Note: Use Entra ID authentication (local auth is disabled)" -ForegroundColor Yellow

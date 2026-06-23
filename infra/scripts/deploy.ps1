# =============================================================================
# Pronghorn Deployment Script
# =============================================================================
# This script deploys the Pronghorn infrastructure and applications in the 
# correct order:
#   1. Deploy core infrastructure (ACR, networking, databases, etc.)
#   2. Build and push container images to ACR
#   3. Deploy Container Apps with the built images
#
# Usage:
#   .\deploy.ps1 -Environment dev [-SkipInfra] [-SkipBuild] [-SkipContainerApps]
#
# Prerequisites:
#   - Azure CLI installed and logged in
#   - Terraform installed
#   - Node.js installed (for frontend build)
# =============================================================================

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("dev", "test", "prod")]
    [string]$Environment,
    
    [switch]$SkipInfra,
    [switch]$SkipBuild,
    [switch]$SkipContainerApps,
    [switch]$Plan,
    
    [string]$PostgresPassword,
    [string]$JwtSecret,
    [string]$ApimPublisherEmail
)

$ErrorActionPreference = "Stop"

# Configuration
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InfraDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent $InfraDir
$TfVarsFile = Join-Path $InfraDir "params\$Environment.tfvars"

# Colors for output
function Write-Step { param($msg) Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Info { param($msg) Write-Host "-> $msg" -ForegroundColor Yellow }
function Write-Error { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red }

# =============================================================================
# STEP 1: Validate Prerequisites
# =============================================================================
Write-Step "Validating Prerequisites"

# Check Azure CLI
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Error "Azure CLI is not installed. Please install it first."
    exit 1
}
Write-Success "Azure CLI found"

# Check Terraform
if (-not (Get-Command terraform -ErrorAction SilentlyContinue)) {
    Write-Error "Terraform is not installed. Please install it first."
    exit 1
}
Write-Success "Terraform found"

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not installed. Please install it first."
    exit 1
}
Write-Success "Node.js found"

# Check tfvars file exists
if (-not (Test-Path $TfVarsFile)) {
    Write-Error "Terraform variables file not found: $TfVarsFile"
    exit 1
}
Write-Success "Found tfvars: $TfVarsFile"

# Check Azure login
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Error "Not logged into Azure. Run 'az login' first."
    exit 1
}
Write-Success "Logged in as: $($account.user.name)"

if (-not $ApimPublisherEmail -and $account.user.name -match '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
    $ApimPublisherEmail = $account.user.name
}

if (-not $ApimPublisherEmail) {
    $ApimPublisherEmail = "pronghorn-dev@local.invalid"
    Write-Info "Using fallback APIM publisher email: $ApimPublisherEmail"
} else {
    Write-Info "Using APIM publisher email: $ApimPublisherEmail"
}

# =============================================================================
# STEP 2: Deploy Core Infrastructure (ACR, Networking, DB, etc.)
# =============================================================================
if (-not $SkipInfra) {
    Write-Step "Deploying Core Infrastructure"
    
    Set-Location $InfraDir
    
    # Initialize Terraform
    Write-Info "Initializing Terraform..."
    terraform init
    if ($LASTEXITCODE -ne 0) { exit 1 }
    
    # Build variable arguments
    $tfArgs = @(
        "-var-file=$TfVarsFile",
        "-var=apim_publisher_email=$ApimPublisherEmail"
    )
    
    if ($PostgresPassword) {
        $tfArgs += "-var=administrator_password=$PostgresPassword"
    }
    if ($JwtSecret) {
        $tfArgs += "-var=jwt_secret=$JwtSecret"
    }
    
    # Target only infrastructure components (not container apps)
    $infraTargets = @(
        "-target=random_string.suffix",
        "-target=azurerm_resource_group.main",
        "-target=module.logging",
        "-target=module.container_registry",
        "-target=module.keyvault",
        "-target=module.storage",
        "-target=module.postgresql"
    )
    
    if ($Plan) {
        Write-Info "Planning infrastructure..."
        terraform plan @tfArgs @infraTargets
    } else {
        Write-Info "Applying infrastructure..."
        terraform apply @tfArgs @infraTargets -auto-approve
        if ($LASTEXITCODE -ne 0) { 
            Write-Error "Infrastructure deployment failed"
            exit 1 
        }
        Write-Success "Core infrastructure deployed"
    }
    
    Set-Location $RootDir
}

# =============================================================================
# STEP 3: Get ACR Details from Terraform Output
# =============================================================================
Write-Step "Getting ACR Details"

Set-Location $InfraDir
$acrName = terraform output -raw container_registry_name 2>$null
$acrLoginServer = terraform output -raw container_registry_login_server 2>$null
$resourceGroup = terraform output -raw resource_group_name 2>$null

if (-not $acrLoginServer) {
    Write-Error "Could not get ACR details from Terraform. Make sure infrastructure is deployed."
    exit 1
}

Write-Success "ACR Name: $acrName"
Write-Success "ACR Login Server: $acrLoginServer"
Write-Success "Resource Group: $resourceGroup"

Set-Location $RootDir

# =============================================================================
# STEP 4: Build and Push Container Images
# =============================================================================
if (-not $SkipBuild) {
    Write-Step "Building and Pushing Container Images"
    
    # Login to ACR first
    Write-Info "Logging into ACR..."
    az acr login --name $acrName
    if ($LASTEXITCODE -ne 0) { 
        Write-Error "ACR login failed"
        exit 1 
    }
    Write-Success "Logged into ACR"
    
    # Build Frontend App
    Write-Info "Building frontend app..."
    Set-Location $RootDir
    npm run build
    if ($LASTEXITCODE -ne 0) { 
        Write-Error "Frontend build failed"
        exit 1 
    }
    Write-Success "Frontend built successfully"
    
    # Build Frontend Docker Image Locally (uses cache, much faster!)
    Write-Info "Building frontend Docker image locally..."
    $frontendImage = "$acrLoginServer/pronghorn-frontend:latest"
    docker build -t $frontendImage -f Dockerfile .
    if ($LASTEXITCODE -ne 0) { 
        Write-Error "Frontend Docker build failed"
        exit 1 
    }
    Write-Success "Frontend image built locally"
    
    # Push Frontend Image to ACR (only pushes changed layers)
    Write-Info "Pushing frontend image to ACR..."
    docker push $frontendImage
    if ($LASTEXITCODE -ne 0) { 
        Write-Error "Frontend image push failed"
        exit 1 
    }
    Write-Success "Frontend image pushed: $frontendImage"
    
    # Build API (compile TypeScript)
    Write-Info "Building API..."
    Set-Location "$RootDir\api"
    npm run build
    if ($LASTEXITCODE -ne 0) { 
        Write-Error "API build failed"
        exit 1 
    }
    Write-Success "API built successfully"
    
    # Build API Docker Image Locally
    Write-Info "Building API Docker image locally..."
    $apiImage = "$acrLoginServer/pronghorn-api:latest"
    docker build -t $apiImage -f Dockerfile .
    if ($LASTEXITCODE -ne 0) { 
        Write-Error "API Docker build failed"
        exit 1 
    }
    Write-Success "API image built locally"
    
    # Push API Image to ACR
    Write-Info "Pushing API image to ACR..."
    docker push $apiImage
    if ($LASTEXITCODE -ne 0) { 
        Write-Error "API image push failed"
        exit 1 
    }
    Write-Success "API image pushed: $apiImage"
    
    Set-Location $RootDir
}

# =============================================================================
# STEP 5: Deploy Container Apps
# =============================================================================
if (-not $SkipContainerApps) {
    Write-Step "Deploying Container Apps"
    
    Set-Location $InfraDir
    
    # Build variable arguments with correct image names
    $tfArgs = @(
        "-var-file=$TfVarsFile",
        "-var=apim_publisher_email=$ApimPublisherEmail",
        "-var=container_image=${acrLoginServer}/pronghorn-api:latest",
        "-var=frontend_container_image=${acrLoginServer}/pronghorn-frontend:latest"
    )
    
    if ($PostgresPassword) {
        $tfArgs += "-var=administrator_password=$PostgresPassword"
    }
    if ($JwtSecret) {
        $tfArgs += "-var=jwt_secret=$JwtSecret"
    }
    
    if ($Plan) {
        Write-Info "Planning Container Apps deployment..."
        terraform plan @tfArgs
    } else {
        Write-Info "Applying full infrastructure with Container Apps..."
        terraform apply @tfArgs -auto-approve
        if ($LASTEXITCODE -ne 0) { 
            Write-Error "Container Apps deployment failed"
            exit 1 
        }
        Write-Success "Container Apps deployed"
    }
    
    # Get outputs
    Write-Step "Deployment Complete!"
    
    $apiUrl = terraform output -raw container_app_url 2>$null
    $frontendUrl = terraform output -raw frontend_app_url 2>$null
    $apimUrl = terraform output -raw api_management_gateway_url 2>$null
    
    Write-Host "`nDeployed Resources:" -ForegroundColor Cyan
    Write-Host "  Frontend URL: $frontendUrl" -ForegroundColor Green
    Write-Host "  API URL:      $apiUrl" -ForegroundColor Green
    Write-Host "  APIM URL:     $apimUrl" -ForegroundColor Green
    
    Set-Location $RootDir
}

Write-Host "`n[OK] Deployment completed successfully!" -ForegroundColor Green

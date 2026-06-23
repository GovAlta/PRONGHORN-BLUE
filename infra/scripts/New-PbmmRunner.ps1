<#
.SYNOPSIS
    Provisions a self-hosted GitHub Actions runner on a Linux VM inside a PBMM VNet.

.DESCRIPTION
    Creates an Ubuntu 22.04 virtual machine in a delegated runner subnet of the
    Government of Canada PBMM (Protected B, Medium/Medium) Azure Landing Zone and
    registers it as a self-hosted GitHub Actions runner.

    A PBMM deployment reaches the Terraform state storage account, Azure Container
    Registry, Key Vault, and PostgreSQL servers exclusively over private endpoints.
    GitHub-hosted runners cannot reach those private endpoints, so the deploy-to-pbmm
    workflow runs on a self-hosted runner that lives inside the VNet. This script
    stands up that runner.

    The VM is provisioned WITHOUT a public IP address (private-only, reachable via
    Azure Bastion or the hub network). A cloud-init payload installs the Azure CLI,
    Terraform, Docker, Node.js, PowerShell, and git, then downloads, configures, and
    starts the GitHub Actions runner as a systemd service under a non-root user.

    The script is idempotent: re-running it with the same VM name detects the existing
    VM and skips creation. Obtain a fresh runner registration token before each run
    (it expires roughly one hour after generation).

.PARAMETER SubscriptionId
    Azure subscription ID that hosts the runner VM (the workload subscription).

.PARAMETER ResourceGroupName
    Resource group to create (if missing) and place the runner VM in.

.PARAMETER SubnetId
    Full resource ID of the runner subnet inside the PBMM VNet. The subnet must have
    outbound internet egress (via firewall/NAT) so the runner can reach GitHub.

.PARAMETER GitHubRepoUrl
    HTTPS URL of the GitHub repository the runner registers against,
    e.g. https://github.com/your-org/pronghorn

.PARAMETER RunnerToken
    Runner registration token from GitHub
    (Settings -> Actions -> Runners -> New self-hosted runner). Short-lived.

.PARAMETER Location
    Azure region for the VM. Defaults to canadacentral.

.PARAMETER VmName
    Name of the runner VM. Defaults to pronghorn-pbmm-runner.

.PARAMETER VmSize
    VM size. Defaults to Standard_D4s_v3 (4 vCPU / 16 GiB) for production builds.

.PARAMETER AdminUsername
    Local admin username on the VM. Defaults to azureuser.

.PARAMETER RunnerLabels
    Comma-separated runner labels. Defaults to self-hosted,linux,pbmm. The
    deploy-to-pbmm workflow targets runs-on: [self-hosted, linux, pbmm].

.PARAMETER RunnerGroup
    GitHub runner group. Defaults to Default.

.PARAMETER RunnerVersion
    GitHub Actions runner release version (without the leading v). Defaults to 2.319.1.

.PARAMETER Tags
    Optional hashtable of Azure resource tags to apply to the VM and resource group.

.EXAMPLE
    ./New-PbmmRunner.ps1 `
        -SubscriptionId "00000000-0000-0000-0000-000000000000" `
        -ResourceGroupName "pronghorn-prod-runners-rg" `
        -SubnetId "/subscriptions/.../subnets/github-runners" `
        -GitHubRepoUrl "https://github.com/your-org/pronghorn" `
        -RunnerToken "ABCDEF..."

    Provisions a private runner VM in canadacentral and registers it against the repo.

.NOTES
    Prerequisites:
      - Azure CLI (az) installed and authenticated (az login) into the PBMM tenant.
      - The executing identity has Contributor on the target resource group/subscription.
      - The runner subnet allows outbound egress to github.com and the GitHub runner
        download endpoints (objects.githubusercontent.com).
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ResourceGroupName,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SubnetId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://github\.com/.+/.+')]
  [string]$GitHubRepoUrl,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$RunnerToken,

  [Parameter(Mandatory = $false)]
  [ValidateNotNullOrEmpty()]
  [string]$Location = "canadacentral",

  [Parameter(Mandatory = $false)]
  [ValidateNotNullOrEmpty()]
  [string]$VmName = "pronghorn-pbmm-runner",

  [Parameter(Mandatory = $false)]
  [ValidateNotNullOrEmpty()]
  [string]$VmSize = "Standard_D4s_v3",

  [Parameter(Mandatory = $false)]
  [ValidateNotNullOrEmpty()]
  [string]$AdminUsername = "azureuser",

  [Parameter(Mandatory = $false)]
  [ValidateNotNullOrEmpty()]
  [string]$RunnerLabels = "self-hosted,linux,pbmm",

  [Parameter(Mandatory = $false)]
  [ValidateNotNullOrEmpty()]
  [string]$RunnerGroup = "Default",

  [Parameter(Mandatory = $false)]
  [ValidateNotNullOrEmpty()]
  [string]$RunnerVersion = "2.319.1",

  [Parameter(Mandatory = $false)]
  [hashtable]$Tags = @{}
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Message) Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
function Write-Success { param([string]$Message) Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-Info { param([string]$Message) Write-Host "-> $Message" -ForegroundColor Yellow }

function ConvertTo-TagArguments {
  param([hashtable]$TagMap)

  if (-not $TagMap -or $TagMap.Count -eq 0) {
    return @()
  }

  $arguments = New-Object System.Collections.Generic.List[string]
  $arguments.Add("--tags")
  foreach ($key in ($TagMap.Keys | Sort-Object)) {
    $arguments.Add("$key=$($TagMap[$key])")
  }
  return $arguments.ToArray()
}

# -----------------------------------------------------------------------------
# Select the target subscription
# -----------------------------------------------------------------------------
Write-Step "Selecting Azure subscription"
az account set --subscription $SubscriptionId --only-show-errors
if ($LASTEXITCODE -ne 0) {
  throw "Unable to select Azure subscription '$SubscriptionId'. Run 'az login' first."
}
Write-Success "Using subscription $SubscriptionId"

# -----------------------------------------------------------------------------
# Ensure the resource group exists
# -----------------------------------------------------------------------------
Write-Step "Ensuring resource group '$ResourceGroupName'"
$rgExists = az group exists --name $ResourceGroupName --only-show-errors
if ($rgExists -ne "true") {
  $rgArgs = @("group", "create", "--name", $ResourceGroupName, "--location", $Location) +
  (ConvertTo-TagArguments -TagMap $Tags) + @("--only-show-errors")
  az @rgArgs | Out-Null
  Write-Success "Created resource group '$ResourceGroupName'"
}
else {
  Write-Info "Resource group '$ResourceGroupName' already exists"
}

# -----------------------------------------------------------------------------
# Idempotency: skip if the VM already exists
# -----------------------------------------------------------------------------
Write-Step "Checking for existing runner VM '$VmName'"
$existingVm = az vm show --resource-group $ResourceGroupName --name $VmName --only-show-errors 2>$null
if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($existingVm)) {
  Write-Info "VM '$VmName' already exists in '$ResourceGroupName'. Skipping creation."
  Write-Info "To re-register the runner, SSH into the VM and re-run ./config.sh."
  return
}

# -----------------------------------------------------------------------------
# Build the cloud-init payload that installs tooling and registers the runner
# -----------------------------------------------------------------------------
Write-Step "Building cloud-init payload"

# Parse owner/repo from the repository URL for logging only; config.sh consumes the URL.
$repoPath = ($GitHubRepoUrl -replace '^https://github\.com/', '').TrimEnd('/')
Write-Info "Runner will register against repository '$repoPath'"

$cloudInit = @"
#cloud-config
package_update: true
package_upgrade: false
packages:
  - curl
  - jq
  - git
  - unzip
  - apt-transport-https
  - ca-certificates
  - gnupg
  - lsb-release

runcmd:
  # --- Docker (for local image inspection; ACR builds use the agent pool) ---
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  - chmod a+r /etc/apt/keyrings/docker.gpg
  - echo "deb [arch=`$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu `$(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update -y
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  # --- Azure CLI ---
  - curl -sL https://aka.ms/InstallAzureCLIDeb | bash
  # --- Terraform ---
  - curl -fsSL https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
  - echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com `$(lsb_release -cs) main" > /etc/apt/sources.list.d/hashicorp.list
  - apt-get update -y
  - apt-get install -y terraform
  # --- Node.js 20 LTS ---
  - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  - apt-get install -y nodejs
  # --- PowerShell (for the repo's .ps1 deployment scripts) ---
  - curl -fsSL https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb -o /tmp/packages-microsoft-prod.deb
  - dpkg -i /tmp/packages-microsoft-prod.deb
  - apt-get update -y
  - apt-get install -y powershell
  # --- Create the runner user and allow it to use Docker ---
  - useradd -m -s /bin/bash actions-runner || true
  - usermod -aG docker actions-runner
  # --- Download and install the GitHub Actions runner ---
  - su - actions-runner -c "mkdir -p /home/actions-runner/runner"
  - su - actions-runner -c "cd /home/actions-runner/runner && curl -o actions-runner.tar.gz -L https://github.com/actions/runner/releases/download/v${RunnerVersion}/actions-runner-linux-x64-${RunnerVersion}.tar.gz"
  - su - actions-runner -c "cd /home/actions-runner/runner && tar xzf actions-runner.tar.gz && rm actions-runner.tar.gz"
  - su - actions-runner -c "cd /home/actions-runner/runner && ./config.sh --url ${GitHubRepoUrl} --token ${RunnerToken} --name ${VmName} --labels ${RunnerLabels} --runnergroup '${RunnerGroup}' --unattended --replace"
  # --- Install and start the runner as a systemd service (runs as actions-runner) ---
  - cd /home/actions-runner/runner && ./svc.sh install actions-runner
  - cd /home/actions-runner/runner && ./svc.sh start
"@

$cloudInitPath = Join-Path ([System.IO.Path]::GetTempPath()) "pbmm-runner-cloud-init-$([System.Guid]::NewGuid().ToString('N')).yml"
Set-Content -Path $cloudInitPath -Value $cloudInit -Encoding utf8
Write-Success "Cloud-init payload written to $cloudInitPath"

# -----------------------------------------------------------------------------
# Create the VM (private only: no public IP, system-assigned identity)
# -----------------------------------------------------------------------------
Write-Step "Creating runner VM '$VmName' (private, no public IP)"
try {
  $vmArgs = @(
    "vm", "create",
    "--resource-group", $ResourceGroupName,
    "--name", $VmName,
    "--image", "Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest",
    "--size", $VmSize,
    "--admin-username", $AdminUsername,
    "--generate-ssh-keys",
    "--subnet", $SubnetId,
    "--public-ip-address", '""',
    "--nsg", '""',
    "--assign-identity",
    "--custom-data", $cloudInitPath,
    "--only-show-errors"
  ) + (ConvertTo-TagArguments -TagMap $Tags)

  az @vmArgs | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "az vm create failed for '$VmName'."
  }
  Write-Success "VM '$VmName' created"
}
finally {
  Remove-Item -Path $cloudInitPath -Force -ErrorAction SilentlyContinue
}

# -----------------------------------------------------------------------------
# Report status and next steps
# -----------------------------------------------------------------------------
$privateIp = az vm show --resource-group $ResourceGroupName --name $VmName --show-details `
  --query "privateIps" -o tsv --only-show-errors

Write-Step "Runner provisioning started"
Write-Success "VM '$VmName' is provisioning in '$ResourceGroupName' (private IP: $privateIp)"
Write-Host ""
Write-Info "Cloud-init installs tooling and registers the runner in the background (5-10 min)."
Write-Info "Verify the runner appears Online at: ${GitHubRepoUrl}/settings/actions/runners"
Write-Info "Workflows that target 'runs-on: [self-hosted, linux, pbmm]' will then dispatch here."

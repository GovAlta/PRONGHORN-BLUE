param(
    [ValidateSet("dev", "test", "uat", "prod")]
    [string]$Environment = "dev",
    [ValidateSet("online", "corp")]
    [string]$Archetype = "online",
    [string]$SourceRef,
    [string]$SnapshotId,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [string]$ManifestPath,
    [string]$TerraformOutputsPath,
    [string]$FrontendImage,
    [string]$ApiImage,
    [string]$FrontendRevision,
    [string]$ApiRevision,
    [string]$AiDeploymentsPath
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\rollback-helpers.ps1"

$manifest = Get-RollbackComponentManifest -ManifestPath $(if ($ManifestPath) { $ManifestPath } else { Get-RollbackManifestPath -BaseDir $PSScriptRoot })
$snapshotIdentifier = if ($SnapshotId) { $SnapshotId } else { "${Environment}-$(Get-Date -Format 'yyyyMMdd-HHmmss')" }
$terraformOutputs = if ($TerraformOutputsPath -and (Test-Path -LiteralPath $TerraformOutputsPath)) { Read-JsonArtifact -Path $TerraformOutputsPath } else { @{} }
$aiDeployments = if ($AiDeploymentsPath -and (Test-Path -LiteralPath $AiDeploymentsPath)) { Read-JsonArtifact -Path $AiDeploymentsPath } else { @() }

$outputMap = @{}
foreach ($property in $terraformOutputs.PSObject.Properties) {
    $value = $property.Value
    if ($null -ne $value -and $value.PSObject.Properties.Name -contains "value") {
        $outputMap[$property.Name] = $value.value
    }
    else {
        $outputMap[$property.Name] = $value
    }
}

$componentSets = @()
foreach ($component in $manifest.componentSets) {
    $componentSets += [pscustomobject]@{
        componentSetId = $component.id
        displayName    = $component.displayName
        category       = $component.category
        owner          = $component.owner
        destructive    = $component.destructive
        resources      = $component.resources
    }
}

$snapshot = [pscustomobject]@{
    snapshotId        = $snapshotIdentifier
    environment       = $Environment
    archetype         = $Archetype
    sourceRef         = if ($SourceRef) { $SourceRef } else { $env:GITHUB_SHA }
    createdAt         = (Get-Date).ToString("o")
    terraformStateKey = [Environment]::GetEnvironmentVariable("TFSTATE_KEY")
    componentSets     = $componentSets
    runtimeArtifacts  = [pscustomobject]@{
        frontend = [pscustomobject]@{
            image    = $FrontendImage
            revision = $FrontendRevision
        }
        api      = [pscustomobject]@{
            image    = $ApiImage
            revision = $ApiRevision
        }
    }
    aiDeployments     = @($aiDeployments)
    outputs           = [pscustomobject]$outputMap
}

Write-JsonArtifact -Path $OutputPath -Data $snapshot
$snapshot | ConvertTo-Json -Depth 20

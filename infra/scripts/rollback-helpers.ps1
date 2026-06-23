Set-StrictMode -Version Latest

function Get-RollbackManifestPath {
    param([string]$BaseDir = $PSScriptRoot)

    $infraDir = Split-Path -Parent $BaseDir
    return Join-Path $infraDir "config\rollback-component-sets.json"
}

function Read-JsonArtifact {
    param([Parameter(Mandatory=$true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "JSON artifact not found: $Path"
    }

    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 50
}

function Write-JsonArtifact {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)]$Data
    )

    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    $Data | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $Path
}

function Get-RollbackComponentManifest {
    param([string]$ManifestPath = (Get-RollbackManifestPath))

    return Read-JsonArtifact -Path $ManifestPath
}

function Split-RollbackScopes {
    param([Parameter(Mandatory=$false)]$RollbackScopes)

    if ($null -eq $RollbackScopes) {
        return @()
    }

    $values = @()
    foreach ($entry in @($RollbackScopes)) {
        if ($null -eq $entry) {
            continue
        }

        foreach ($scope in ($entry.ToString() -split ',')) {
            $trimmed = $scope.Trim().ToLowerInvariant()
            if (-not [string]::IsNullOrWhiteSpace($trimmed)) {
                $values += $trimmed
            }
        }
    }

    return [string[]]@($values | Select-Object -Unique)
}

function ConvertTo-NormalizedRollbackScopes {
    param(
        [Parameter(Mandatory=$true)]$RollbackScopes,
        [Parameter(Mandatory=$true)]$Manifest
    )

    $rawScopes = [string[]]@(Split-RollbackScopes -RollbackScopes $RollbackScopes)
    $validScopes = [string[]]@($Manifest.componentSets | ForEach-Object { $_.id })
    $invalidScopes = [string[]]@($rawScopes | Where-Object { $_ -notin $validScopes })

    if (@($invalidScopes).Count -gt 0) {
        throw "Unknown rollback scopes: $($invalidScopes -join ', ')"
    }

    return [string[]]@($rawScopes)
}

function Resolve-RollbackComponentSets {
    param(
        [Parameter(Mandatory=$true)]$Manifest,
        [Parameter(Mandatory=$true)][string[]]$SelectedScopes
    )

    return @($Manifest.componentSets | Where-Object { $_.id -in $SelectedScopes })
}

function Test-RollbackHasDestructiveScope {
    param([Parameter(Mandatory=$true)]$ComponentSets)

    return (@($ComponentSets | Where-Object { $_.destructive }).Count -gt 0)
}

function Get-RollbackDependencyOrder {
    param([Parameter(Mandatory=$true)]$ComponentSets)

    $componentArray = @($ComponentSets)
    $selected = @{}
    foreach ($component in $componentArray) {
        $selected[$component.id] = $component
    }

    $remaining = @($componentArray)
    $ordered = @()

    while ($remaining.Count -gt 0) {
        $progress = $false
        $nextRemaining = @()
        $orderedIds = @($ordered | ForEach-Object { $_.id })

        foreach ($component in $remaining) {
            $dependencies = @($component.rollbackAfter | Where-Object { $_ -in $selected.Keys })
            $unresolved = @($dependencies | Where-Object { $_ -notin $orderedIds })

            if ($unresolved.Count -eq 0) {
                $ordered += $component
                $orderedIds += $component.id
                $progress = $true
            } else {
                $nextRemaining += $component
            }
        }

        if (-not $progress) {
            throw "Rollback scope dependency cycle detected for scopes: $((@($remaining | ForEach-Object { $_.id }) -join ', '))"
        }

        $remaining = @($nextRemaining)
    }

    return @($ordered)
}

function New-RollbackPreflightCheck {
    param(
        [Parameter(Mandatory=$true)][string]$CheckType,
        [Parameter(Mandatory=$true)][string]$Status,
        [Parameter(Mandatory=$true)][string]$Details,
        [string]$Scope = "global"
    )

    return [pscustomobject]@{
        checkId    = [guid]::NewGuid().ToString()
        scope      = $Scope
        checkType  = $CheckType
        status     = $Status
        details    = $Details
    }
}

function Get-RollbackScopeMap {
    param([Parameter(Mandatory=$true)]$Manifest)

    $map = @{}
    foreach ($component in $Manifest.componentSets) {
        $map[$component.id] = $component
    }

    return $map
}

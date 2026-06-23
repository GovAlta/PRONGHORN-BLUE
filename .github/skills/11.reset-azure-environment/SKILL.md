---
name: 11.reset-azure-environment
description: Removes pronghorn-app app registration and pronghorn-blue resource group, then marks relevant .env values as reset/removed.
argument-hint: "Use this skill to remove Azure app/resource group and update local env values with reset markers."
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Skill: Reset Azure Environment

This skill follows the same wrapper-first automation pattern used in previous local setup skills.

Scope:
- Remove Entra app registration: `pronghorn-app`
- Remove Azure resource group: `pronghorn-blue`
- Update relevant `.env*` values by appending `(reset/removed)`

---

## Prerequisites

- Azure CLI installed.
- `az login` completed.
- Permissions to delete app registrations and resource groups.

---

## Automated Setup (Recommended)

Use wrapper entrypoints. These wrappers call internal scripts and keep usage consistent.

- Windows/PowerShell wrapper: `setup-reset-azure-environment.ps1`
- Linux/macOS bash wrapper: `setup-reset-azure-environment.sh`

Maintainer note:
- Entry points are wrapper scripts.
- Internal implementation scripts are:
	- `Manage-ResetAzureEnvironment.ps1`
	- `manage-reset-azure-environment.sh`

### PowerShell wrapper

```powershell
Set-Location .github/skills/11.reset-azure-environment/scripts
.\setup-reset-azure-environment.ps1 -Action all
```

### bash wrapper

```bash
cd .github/skills/11.reset-azure-environment/scripts
bash ./setup-reset-azure-environment.sh all
```

---

## Actions

### 1) Remove App Registration

```powershell
Set-Location .github/skills/11.reset-azure-environment/scripts
.\setup-reset-azure-environment.ps1 -Action remove-app-registration -AppDisplayName "pronghorn-app"
```

```bash
cd .github/skills/11.reset-azure-environment/scripts
bash ./setup-reset-azure-environment.sh remove-app-registration --app-display-name "pronghorn-app"
```

### 2) Remove Resource Group

```powershell
Set-Location .github/skills/11.reset-azure-environment/scripts
.\setup-reset-azure-environment.ps1 -Action remove-resource-group -ResourceGroupName "pronghorn-blue"
```

```bash
cd .github/skills/11.reset-azure-environment/scripts
bash ./setup-reset-azure-environment.sh remove-resource-group --resource-group "pronghorn-blue"
```

### 3) Update Relevant .env Values

Appends `(reset/removed)` to actual values for keys like:
- `FOUNDRY_ENDPOINT`, `FOUNDRY_API_KEY`, `APIM_OPENAI_URL`
- `VITE_AZURE_CLIENT_ID`, `VITE_AZURE_TENANT_ID`, `VITE_AZURE_REDIRECT_URI`
- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_OAUTH_CLIENT_ID`
- `VITE_API_BASE_URL`, `API_BASE_URL`, `FRONTEND_URL`

```powershell
Set-Location .github/skills/11.reset-azure-environment/scripts
.\setup-reset-azure-environment.ps1 -Action update-env-files
```

```bash
cd .github/skills/11.reset-azure-environment/scripts
bash ./setup-reset-azure-environment.sh update-env-files
```

---

## One-Command Flow

Runs all reset operations in order:
1) remove app registration
2) remove resource group
3) update relevant `.env*` values

```powershell
Set-Location .github/skills/11.reset-azure-environment/scripts
.\setup-reset-azure-environment.ps1 -Action all -AppDisplayName "pronghorn-app" -ResourceGroupName "pronghorn-blue"
```

```bash
cd .github/skills/11.reset-azure-environment/scripts
bash ./setup-reset-azure-environment.sh all --app-display-name "pronghorn-app" --resource-group "pronghorn-blue"
```

---

## Validation

- App registration removed:

```bash
az ad app list --display-name "pronghorn-app" --query "length(@)" -o tsv
# Expected: 0
```

- Resource group removed:

```bash
az group exists --name "pronghorn-blue"
# Expected: false
```

- Relevant env values marked:

```bash
grep -R "reset/removed" .env* app/backend/.env* 2>/dev/null
```

---

## Safety Note

These operations are destructive for cloud resources. Use PowerShell `-WhatIf` on the manager script before execution when needed.

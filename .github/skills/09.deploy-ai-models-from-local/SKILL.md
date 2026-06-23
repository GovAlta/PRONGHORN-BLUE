---
name: 09.deploy-ai-models-from-local
description: Automates local Azure AI Foundry model deployment workflow for only sections 9.1, 9.2, 9.3, and 9.6 of LOCAL_DEVELOPMENT.md.
argument-hint: "Use this skill to list available models, validate Azure prerequisites, deploy models via Terraform, and configure API Foundry env vars."
compatibility:
  - linux
  - macos
  - windows
license: MIT
user-invokable: true
---

# Skill: Azure AI Foundry — Model Deployment (Scoped)

This skill follows the same wrapper-first automation pattern used in previous local setup skills.

Scope is intentionally limited to:

- **9.1 Available Models**
- **9.2 Prerequisites**
- **9.3 Deploy AI Models with Terraform**
- **9.6 Configure the API to Use AI Models**

No other section 9 subsections are implemented by this skill.

---

## Prerequisites

- Azure CLI installed.
- Terraform installed.
- Access to Azure subscription/resource group with AI Services permissions.
- `infra/params/dev.tfvars` exists (copy from `tfvars.example` and fill in your values if not already created).

---

## Automated Setup (Recommended)

Use wrapper entrypoints. These wrappers call internal scripts and keep usage consistent.

- Windows/PowerShell wrapper: `setup-ai-models-from-local.ps1`
- Linux/macOS bash wrapper: `setup-ai-models-from-local.sh`

Maintainer note:

- Entry points are wrapper scripts.
- Internal implementation scripts are:
  - `Manage-AIModelsFromLocal.ps1`
  - `manage-ai-models-from-local.sh`

### PowerShell wrapper

```powershell
Set-Location .github/skills/09.deploy-ai-models-from-local/scripts
.\setup-ai-models-from-local.ps1 -Action list-models
```

### bash wrapper

```bash
cd .github/skills/09.deploy-ai-models-from-local/scripts
bash ./setup-ai-models-from-local.sh list-models
```

---

## 9.1 Available Models

List model definitions from `infra/config/ai-models.json`:

```powershell
Set-Location .github/skills/09.deploy-ai-models-from-local/scripts
.\setup-ai-models-from-local.ps1 -Action list-models
```

```bash
cd .github/skills/09.deploy-ai-models-from-local/scripts
bash ./setup-ai-models-from-local.sh list-models
```

---

## 9.2 Prerequisites

Checks and enforces prerequisites:

- `az` exists
- authenticated session (`az login` required if missing)
- optional subscription selection
- provider registration checks:
  - `Microsoft.CognitiveServices`
  - `Microsoft.AppService`

### Run checks

```powershell
Set-Location .github/skills/09.deploy-ai-models-from-local/scripts
.\setup-ai-models-from-local.ps1 -Action check-prereqs -SubscriptionId "<subscription-id>"
```

```bash
cd .github/skills/09.deploy-ai-models-from-local/scripts
bash ./setup-ai-models-from-local.sh check-prereqs --subscription-id "<subscription-id>"
```

---

## 9.3 Deploy AI Models with Terraform

Runs Terraform workflow in `infra/`:

- `terraform init`
- `terraform plan -var-file=<tfvars>`
- `terraform apply -var-file=<tfvars>`

### Deploy with confirmation prompt

```powershell
Set-Location .github/skills/09.deploy-ai-models-from-local/scripts
.\setup-ai-models-from-local.ps1 -Action deploy-terraform -TfvarsPath "infra/params/dev.tfvars"
```

```bash
cd .github/skills/09.deploy-ai-models-from-local/scripts
bash ./setup-ai-models-from-local.sh deploy-terraform --tfvars-path "infra/params/dev.tfvars"
```

### Deploy with auto-approve

```powershell
Set-Location .github/skills/09.deploy-ai-models-from-local/scripts
.\setup-ai-models-from-local.ps1 -Action deploy-terraform -TfvarsPath "infra/params/dev.tfvars" -AutoApprove
```

```bash
cd .github/skills/09.deploy-ai-models-from-local/scripts
bash ./setup-ai-models-from-local.sh deploy-terraform --tfvars-path "infra/params/dev.tfvars" --auto-approve
```

---

## 9.6 Configure the API to Use AI Models

Updates `app/backend/.env` values:

- `FOUNDRY_ENDPOINT`
- `FOUNDRY_API_KEY`
- `APIM_OPENAI_URL` (optional)

You can provide values explicitly, or infer endpoint/key from Azure using resource group + AI Services account name.

### Option A: Explicit values

```powershell
Set-Location .github/skills/09.deploy-ai-models-from-local/scripts
.\setup-ai-models-from-local.ps1 -Action configure-api-env `
  -FoundryEndpoint "https://ai-pronghorn-dev.services.ai.azure.com/" `
  -FoundryApiKey "<foundry-api-key>" `
  -ApimOpenAiUrl "https://apim-pronghorn-xxx.azure-api.net/openai"
```

```bash
cd .github/skills/09.deploy-ai-models-from-local/scripts
bash ./setup-ai-models-from-local.sh configure-api-env \
  --foundry-endpoint "https://ai-pronghorn-dev.services.ai.azure.com/" \
  --foundry-api-key "<foundry-api-key>" \
  --apim-openai-url "https://apim-pronghorn-xxx.azure-api.net/openai"
```

### Option B: Infer endpoint/key from Azure account

```powershell
Set-Location .github/skills/09.deploy-ai-models-from-local/scripts
.\setup-ai-models-from-local.ps1 -Action configure-api-env `
  -ResourceGroupName "pronghorn-blue" `
  -AIServicesName "ai-pronghorn-dev" `
  -ApimOpenAiUrl "https://apim-pronghorn-xxx.azure-api.net/openai"
```

```bash
cd .github/skills/09.deploy-ai-models-from-local/scripts
bash ./setup-ai-models-from-local.sh configure-api-env \
  --resource-group "pronghorn-blue" \
  --ai-services-name "ai-pronghorn-dev" \
  --apim-openai-url "https://apim-pronghorn-xxx.azure-api.net/openai"
```

---

## One-Command Scoped Flow

Run all supported subsections in order: `9.1 -> 9.2 -> 9.3 -> 9.6`.

```powershell
Set-Location .github/skills/09.deploy-ai-models-from-local/scripts
.\setup-ai-models-from-local.ps1 -Action all -SubscriptionId "<subscription-id>" -TfvarsPath "infra/params/dev.tfvars"
```

```bash
cd .github/skills/09.deploy-ai-models-from-local/scripts
bash ./setup-ai-models-from-local.sh all --subscription-id "<subscription-id>" --tfvars-path "infra/params/dev.tfvars"
```

---

## Validation

After successful run:

- Terraform apply completes without errors.
- `app/backend/.env` contains non-empty `FOUNDRY_ENDPOINT` and `FOUNDRY_API_KEY`.
- API can read Foundry configuration on startup.

---

## Related Resources

- [LOCAL_DEVELOPMENT.md § 9.1](../../../LOCAL_DEVELOPMENT.md#91-available-models)
- [LOCAL_DEVELOPMENT.md § 9.2](../../../LOCAL_DEVELOPMENT.md#92-prerequisites)
- [LOCAL_DEVELOPMENT.md § 9.3](../../../LOCAL_DEVELOPMENT.md#93-deploy-ai-models-with-terraform)
- [LOCAL_DEVELOPMENT.md § 9.6](../../../LOCAL_DEVELOPMENT.md#96-configure-the-api-to-use-ai-models)

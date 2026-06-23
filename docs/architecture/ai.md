# AI Architecture

> Part of the [Pronghorn Architecture Documentation](../README.md)

Pronghorn uses **Azure AI Foundry** as its sole AI model provider. All AI calls are routed through Azure API Management (APIM), which authenticates to AI Foundry using its system-assigned managed identity — no API keys are stored or managed by application code.

---

## 1. Request Flow

```
Frontend (React)
    │
    │  POST /api/v1/chat/stream/foundry
    │  { model: "gpt-4.1", messages: [...] }
    │
    ▼
Backend (Express.js)
    │
    │  1. getModelConfig(model)       ← app/backend/src/config/aiModels.ts
    │  2. buildEndpointUrl(model)     ← constructs: APIM_OPENAI_URL/deployments/{id}/chat/completions
    │  3. getAzureToken()             ← acquires Azure AD token for cognitiveservices.azure.com scope
    │
    ▼
Azure API Management (APIM)
    │
    │  Inbound policy:
    │  - Strips incoming auth
    │  - Authenticates via Managed Identity to AI Foundry
    │  - Routes to AI Services endpoint
    │
    ▼
Azure AI Foundry (AI Services Account)
    │
    │  OpenAI-compatible chat completions API
    │  Deployment: gpt-4-1 → gpt-4.1 model
    │
    ▼
Streamed SSE response back through the chain
```

### Authentication Chain

| Hop | Mechanism | Detail |
|-----|-----------|--------|
| Frontend → Backend | Bearer JWT (MSAL ID token) | See [Authentication](auth.md) |
| Backend → APIM | Azure AD token | `getAzureTokenForScope(AzureScope.CognitiveServices)` |
| APIM → AI Foundry | System-assigned Managed Identity | `Cognitive Services OpenAI User` role assignment |

### Key Environment Variables

| Variable | Layer | Purpose |
|----------|-------|---------|
| `APIM_OPENAI_URL` | Backend | APIM OpenAI proxy base URL (e.g., `https://<apim>.azure-api.net/openai`) |
| `VITE_API_BASE_URL` | Frontend | Backend API base URL (frontend never calls AI Foundry directly) |

---

## 2. Model Configuration Pattern

Model configuration is maintained in **three layers** that must be kept in sync. The code files are the source of truth — not this document.

### Configuration Files

| File | Purpose | When to Edit |
|------|---------|-------------|
| `app/backend/src/config/aiModels.ts` | Backend model catalog — deployment IDs, token limits, capabilities, endpoint URL construction | Adding/changing a model the API serves |
| `app/frontend/src/config/aiModels.ts` | Frontend model catalog — display names, descriptions, capabilities shown in UI model selector | Adding/changing a model visible to users |
| `infra/config/ai-models.json` | Terraform-managed deployments — the base set of models provisioned by IaC | Adding a model to automated infrastructure |
| `infra/params/dev.tfvars` | Per-environment deployment list with SKU capacity | Adjusting capacity or enabling/disabling models per environment |

### How They Relate

```
infra/config/ai-models.json          ← defines which models Terraform deploys
infra/params/dev.tfvars              ← per-env capacity overrides
        │
        │  terraform apply → creates Azure AI Foundry deployments
        │
        ▼
app/backend/src/config/aiModels.ts   ← backend must know the deployment IDs to build URLs
app/frontend/src/config/aiModels.ts  ← frontend must know model capabilities for UI
```

> **Important:** Models can also be deployed manually via the Azure portal or `Deploy-AIModels.ps1` script — these won't appear in `ai-models.json` but still need entries in the application config files to be usable.

### Model Config Interface

Each model in the application config defines:

```typescript
interface AIModelConfig {
  id: string;                    // Code identifier (e.g., 'gpt-4.1')
  displayName: string;           // UI display name
  provider: 'azure-foundry';     // Only provider — all models go through Foundry
  providerModelId: string;       // Upstream model name (e.g., 'gpt-4.1')
  foundryDeploymentId: string;   // Azure deployment name (e.g., 'gpt-4-1')
  capabilities: ModelCapability[];// 'chat' | 'vision' | 'code' | 'reasoning' | 'image-gen' | ...
  maxInputTokens: number;        // Context window
  maxOutputTokens: number;       // Max output
  supportsThinking: boolean;     // Uses max_completion_tokens instead of max_tokens
  defaultThinkingBudget?: number; // Default reasoning token budget
  enabled: boolean;              // Active for use
  isDefault?: boolean;           // Default for new projects
  apiVersion?: string;           // Override API version (some models need specific versions)
}
```

### Thinking Models

Models with `supportsThinking: true` (o3, o4-mini, phi-4-reasoning, etc.) require different API parameters:
- Use `max_completion_tokens` instead of `max_tokens`
- Accept a `defaultThinkingBudget` that controls reasoning token allocation
- The chat route handler checks `modelConfig.supportsThinking` and adjusts the request body accordingly

---

## 3. Application Integration

### Backend Chat Route (`routes/chat.ts`)

The primary AI endpoint is `POST /api/v1/chat/stream/foundry`:

1. Receives model ID, messages, and optional project context from the frontend
2. Resolves model config via `getModelConfig(model)`
3. Builds the APIM endpoint URL via `buildEndpointUrl(model)`
4. Acquires an Azure AD token scoped to `https://cognitiveservices.azure.com/`
5. Streams the OpenAI-compatible SSE response back to the client

### Backend RPC Functions (`routes/functions.ts`)

Many RPC functions (summarization, specifications, code generation, audit analysis) also call AI models. They follow the same pattern: `getDefaultModel()` or `getModelConfig(id)` → `buildEndpointUrl()` → Azure AD token → fetch.

### Frontend Model Selection

The frontend `aiModels.ts` exports helpers for the UI:

- `getModelSelectOptions()` — returns options for model selector dropdowns
- `getModelConfig(id)` — retrieves full config for display/validation
- `getEnabledModels()` — filters to active models only

The frontend **never calls AI Foundry directly**. All AI requests go through the backend API.

### Image Generation

Image models use a separate config (`IMAGE_MODELS` in `aiModels.ts`) and a different APIM route (`/bfl/providers/blackforestlabs/v1/...`). The `buildImageEndpointUrl()` function constructs the appropriate path.

---

## 4. Infrastructure

### Terraform Module (`infra/modules/ai-foundry/`)

The module creates:

| Resource | Type | Purpose |
|----------|------|---------|
| AI Services Account | `Microsoft.CognitiveServices/accounts` | Parent resource (kind: `AIServices`, `allowProjectManagement: true`) |
| Foundry Project | `.../accounts/projects` | Organizes AI development work |
| Account Capability Host | `.../accounts/capabilityHosts` | Enables Agent service (optional) |
| Project Capability Host | `.../accounts/projects/capabilityHosts` | Enables Agent service at project level |
| Model Deployments | `.../accounts/deployments` | Individual model deployments with SKU capacity |
| Private Endpoint | `azurerm_private_endpoint` | Optional — for PBMM/enterprise networking |

> **Sequential deployment constraint:** Azure Cognitive Services only allows one deployment operation at a time per account (409 `RequestConflict`). The Terraform module handles this by deploying the first model separately, then the rest with a `depends_on` on the first.

### tfvars Configuration

```hcl
# Enable AI Foundry
enable_ai_foundry                = true
ai_foundry_location              = "canadaeast"   # May differ from main location
ai_foundry_project_name          = "pronghorn-dev"
ai_foundry_enable_agent_service  = true
ai_foundry_sku                   = "S0"
ai_foundry_public_network_access = true
ai_foundry_disable_local_auth    = true

# Model deployments
ai_model_deployments = [
  {
    deployment_name = "gpt-4-1"
    model_name      = "gpt-4.1"
    model_version   = "2025-04-14"
    sku_name        = "GlobalStandard"
    sku_capacity    = 20             # 20K tokens per minute
  },
  # ... additional models
]
```

### Private Endpoints (PBMM)

For enterprise deployments with private networking:

```hcl
ai_foundry_public_network_access = false
ai_foundry_private_endpoint_subnet_id = "/subscriptions/.../subnets/private-endpoints"
ai_foundry_private_dns_zone_ids = [
  "privatelink.cognitiveservices.azure.com",
  "privatelink.openai.azure.com"
]
```

The private endpoint can be in a different region than the AI Services account (e.g., PE in `canadacentral` connecting to AI Foundry in `canadaeast`).

### APIM OpenAI Proxy

APIM acts as the gateway to AI Foundry with:

- **Managed Identity authentication** — `<authentication-managed-identity resource="https://cognitiveservices.azure.com/" />`
- **OpenAI-compatible routing** — the `/openai/deployments/{id}/chat/completions` path structure
- **BFL routing** — separate path for Black Forest Labs image models via `/bfl/...`

The APIM system identity is granted the `Cognitive Services OpenAI User` role on the AI Services account.


---

## 5. Adding a New Model

### Step 1: Deploy to Azure AI Foundry

Either add to `infra/params/dev.tfvars` and run `terraform apply`, or deploy manually via the Azure portal / CLI / `Deploy-AIModels.ps1`.

### Step 2: Add to Backend Config

Add an entry to `AI_MODELS` in `app/backend/src/config/aiModels.ts`:

```typescript
{
  id: "new-model-id",
  displayName: "New Model",
  description: "Description for logging",
  provider: "azure-foundry",
  providerModelId: "new-model",           // Upstream model name
  foundryDeploymentId: "new-model-id",    // Must match Azure deployment name
  capabilities: ["chat", "code"],
  maxInputTokens: 128000,
  maxOutputTokens: 16384,
  defaultOutputTokens: 4096,
  supportsThinking: false,                // true for reasoning models
  enabled: true,
}
```

### Step 3: Add to Frontend Config

Add the same entry to `AI_MODELS` in `app/frontend/src/config/aiModels.ts` (with `displayName`, `description`, and `costPerMInputTokens`/`costPerMOutputTokens` for UI display).

### Step 4: Add to Terraform (Optional)

If the model should be IaC-managed, add to `infra/config/ai-models.json` and the relevant `params/*.tfvars`.

### Step 5: Test

Verify the model works via the chat interface or API:

```bash
curl -X POST http://localhost:8080/api/v1/chat/stream/foundry \
  -H "Content-Type: application/json" \
  -d '{"model":"new-model-id","messages":[{"role":"user","content":"Hello"}]}'
```

---

## 6. Operational Notes

### Region Availability

The AI Services account location affects which models can be deployed. Key constraints:

| Constraint | Detail |
|-----------|--------|
| **Primary region** | `canadaeast` — most OpenAI, DeepSeek, Meta, Microsoft, Mistral, xAI, and MoonshotAI models available |
| **Anthropic (Claude)** | Only available in `eastus2` — requires a separate AI Services account, APIM conditional routing, and `api-version=2026-01-15-preview` with `modelProviderData` fields |
| **Marketplace models** | Some models (Llama-4-Scout, Mistral-Medium) require Azure Marketplace purchases to be enabled at the subscription level by a tenant admin |

### Model Compatibility

All models must be compatible with the **OpenAI Chat Completions API** format used by the APIM pipeline. Known incompatible models:

| Model | Issue |
|-------|-------|
| DeepSeek-R1, DeepSeek-R1-0528 | Response wrapped in `<think>...</think>` XML tags; non-standard endpoint schema and streaming format. Would need a dedicated parsing layer before the standard chat interface can surface them. |

### Deployment Constraints

| Constraint | Detail |
|-----------|--------|
| **Serial deployments** | Azure only allows one deployment operation at a time per AI Services account. Terraform handles this; manual deployments should be done sequentially. |
| **GlobalStandard SKU** | All current deployments use `GlobalStandard`. Some models don't support this SKU in all regions. |
| **TPM capacity** | SKU capacity is in thousands of tokens per minute. Monitor usage and increase capacity if hitting 429 rate limits. |

### Troubleshooting

| Issue | Resolution |
|-------|------------|
| **404 Model Not Found** | Verify the `foundryDeploymentId` in `aiModels.ts` matches the actual Azure deployment name. List deployments: `az cognitiveservices account deployment list --resource-group <rg> --name <account> -o table` |
| **429 Rate Limiting** | Increase `sku_capacity` in tfvars and re-apply, or request quota increase |
| **401 Auth Failed** | Verify APIM managed identity has `Cognitive Services OpenAI User` role on the AI Services account. Check `APIM_OPENAI_URL` env var is set correctly. |
| **Content Filtered** | Azure RAI policy triggered. Review input content or adjust RAI policy (all deployments use `Microsoft.Default` policy). |
| **Deployment race conditions** | Re-run `terraform apply` — Azure serializes operations and earlier attempts may have timed out |

---

## 7. Key File Reference

| File | Purpose |
|------|---------|
| `app/backend/src/config/aiModels.ts` | Backend model catalog and URL construction |
| `app/backend/src/routes/chat.ts` | Chat streaming endpoint (`/api/v1/chat/stream/foundry`) |
| `app/backend/src/routes/functions.ts` | RPC functions that call AI models |
| `app/backend/src/utils/azureCredential.ts` | Azure AD token acquisition for Cognitive Services |
| `app/frontend/src/config/aiModels.ts` | Frontend model catalog for UI |
| `infra/config/ai-models.json` | Terraform-managed model deployment definitions |
| `infra/modules/ai-foundry/main.tf` | AI Foundry Terraform module |
| `infra/params/dev.tfvars` | Dev environment model deployments and capacity |
| `infra/scripts/Deploy-AIModels.ps1` | PowerShell script for manual model deployment |

/**
 * Centralized AI Model Configuration for Backend API
 * =============================================================================
 * Azure AI Foundry only - All AI calls go through APIM with Managed Identity.
 * =============================================================================
 */

// =============================================================================
// Types & Interfaces
// =============================================================================

export type AIProvider = "azure-foundry";

export type ModelCapability =
  | "chat"
  | "vision"
  | "image-gen"
  | "image-edit"
  | "code"
  | "reasoning"
  | "embedding"
  | "audio";

export interface AIModelConfig {
  id: string;
  displayName: string;
  description: string;
  provider: AIProvider;
  providerModelId: string;
  foundryDeploymentId?: string;
  capabilities: ModelCapability[];
  maxInputTokens: number;
  maxOutputTokens: number;
  defaultOutputTokens: number;
  supportsThinking: boolean;
  defaultThinkingBudget?: number;
  costPerMInputTokens?: number;
  costPerMOutputTokens?: number;
  recommendedFor?: string[];
  enabled: boolean;
  isDefault?: boolean;
  apiVersion?: string;
}

// Image model specific configuration
export interface ImageModelConfig {
  id: string;
  displayName: string;
  description: string;
  provider: AIProvider;
  providerModelId: string;
  foundryDeploymentId: string;
  capabilities: ModelCapability[];
  apiProvider: "openai" | "blackforestlabs"; // Which API format to use
  apiEndpointPath: string; // Path for the API endpoint
  defaultSize: string;
  supportedSizes: string[];
  supportedFormats: string[];
  enabled: boolean;
  isDefault?: boolean;
}

export interface ProviderEndpoint {
  provider: AIProvider;
  baseUrl: string;
  apiVersion?: string;
}

// =============================================================================
// Provider Endpoints Configuration
// =============================================================================

export const PROVIDER_ENDPOINTS: Record<AIProvider, ProviderEndpoint> = {
  "azure-foundry": {
    provider: "azure-foundry",
    // Use APIM endpoint - APIM uses its Managed Identity to authenticate to AI Foundry
    baseUrl: process.env.APIM_OPENAI_URL || "",
    apiVersion: "2025-04-01-preview",
  },
};

// =============================================================================
// AI Models Configuration - Azure AI Foundry Only
// =============================================================================

export const AI_MODELS: AIModelConfig[] = [
  {
    id: "gpt-4o",
    displayName: "GPT-4o",
    description:
      "OpenAI GPT-4o via Azure AI Foundry - Best multimodal performance",
    provider: "azure-foundry",
    providerModelId: "gpt-4o",
    foundryDeploymentId: "gpt-4o",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
    isDefault: false,
  },
  {
    id: "gpt-4o-mini",
    displayName: "GPT-4o Mini",
    description:
      "OpenAI GPT-4o-mini via Azure AI Foundry - Fast and cost-effective",
    provider: "azure-foundry",
    providerModelId: "gpt-4o-mini",
    foundryDeploymentId: "gpt-4o-mini",
    capabilities: ["chat", "vision", "code"],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
    isDefault: true,
  },
  {
    id: "gpt-4.1",
    displayName: "GPT-4.1",
    description: "OpenAI GPT-4.1 via Azure AI Foundry",
    provider: "azure-foundry",
    providerModelId: "gpt-4.1",
    foundryDeploymentId: "gpt-4-1",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 8192,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "gpt-4.1-mini",
    displayName: "GPT-4.1 Mini",
    description: "OpenAI GPT-4.1-mini via Azure AI Foundry",
    provider: "azure-foundry",
    providerModelId: "gpt-4.1-mini",
    foundryDeploymentId: "gpt-4-1-mini",
    capabilities: ["chat", "vision", "code"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "o3",
    displayName: "OpenAI o3",
    description: "OpenAI o3 via Azure AI Foundry - Advanced reasoning",
    provider: "azure-foundry",
    providerModelId: "o3",
    foundryDeploymentId: "o3",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    defaultOutputTokens: 16384,
    supportsThinking: true,
    defaultThinkingBudget: 10000,
    enabled: true,
  },
  {
    id: "o4-mini",
    displayName: "OpenAI o4-mini",
    description: "OpenAI o4-mini via Azure AI Foundry - Fast reasoning",
    provider: "azure-foundry",
    providerModelId: "o4-mini",
    foundryDeploymentId: "o4-mini",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    defaultOutputTokens: 8192,
    supportsThinking: true,
    defaultThinkingBudget: 5000,
    enabled: true,
    apiVersion: "2024-12-01-preview",
  },
  {
    id: "deepseek-v3.1",
    displayName: "DeepSeek V3.1",
    description:
      "DeepSeek V3.1 via Azure AI Foundry - Strong general-purpose & coding",
    provider: "azure-foundry",
    providerModelId: "DeepSeek-V3.1",
    foundryDeploymentId: "deepseek-v3-1",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "phi-4",
    displayName: "Phi-4",
    description:
      "Microsoft Phi-4 via Azure AI Foundry - Fast and efficient small model",
    provider: "azure-foundry",
    providerModelId: "Phi-4",
    foundryDeploymentId: "phi-4",
    capabilities: ["chat", "code"],
    maxInputTokens: 16384,
    maxOutputTokens: 4096,
    defaultOutputTokens: 2048,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "mistral-large-3",
    displayName: "Mistral Large 3",
    description:
      "Mistral Large 3 via Azure AI Foundry - Premium coding & instruction following",
    provider: "azure-foundry",
    providerModelId: "Mistral-Large-3",
    foundryDeploymentId: "mistral-large-3",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },

  // --- OpenAI models ---
  {
    id: "gpt-4.1-nano",
    displayName: "GPT-4.1 Nano",
    description:
      "OpenAI GPT-4.1-nano via Azure AI Foundry - Fastest and most affordable",
    provider: "azure-foundry",
    providerModelId: "gpt-4.1-nano",
    foundryDeploymentId: "gpt-4-1-nano",
    capabilities: ["chat", "vision", "code"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "gpt-5-chat",
    displayName: "GPT-5",
    description:
      "OpenAI GPT-5 via Azure AI Foundry - Next-generation flagship model",
    provider: "azure-foundry",
    providerModelId: "gpt-5-chat",
    foundryDeploymentId: "gpt-5-chat",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 8192,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    description:
      "OpenAI GPT-5-mini via Azure AI Foundry - Next-generation mid-tier model",
    provider: "azure-foundry",
    providerModelId: "gpt-5-mini",
    foundryDeploymentId: "gpt-5-mini",
    capabilities: ["chat", "vision", "code"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "gpt-5-nano",
    displayName: "GPT-5 Nano",
    description:
      "OpenAI GPT-5-nano via Azure AI Foundry - Next-generation lightweight model",
    provider: "azure-foundry",
    providerModelId: "gpt-5-nano",
    foundryDeploymentId: "gpt-5-nano",
    capabilities: ["chat", "code"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "gpt-5.1-chat",
    displayName: "GPT-5.1",
    description:
      "OpenAI GPT-5.1 via Azure AI Foundry - Latest generation flagship model",
    provider: "azure-foundry",
    providerModelId: "gpt-5.1-chat",
    foundryDeploymentId: "gpt-5-1-chat",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 8192,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "o1",
    displayName: "OpenAI o1",
    description: "OpenAI o1 via Azure AI Foundry - Advanced reasoning model",
    provider: "azure-foundry",
    providerModelId: "o1",
    foundryDeploymentId: "o1",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    defaultOutputTokens: 16384,
    supportsThinking: true,
    defaultThinkingBudget: 10000,
    enabled: true,
  },
  {
    id: "o3-mini",
    displayName: "OpenAI o3-mini",
    description:
      "OpenAI o3-mini via Azure AI Foundry - Efficient reasoning model",
    provider: "azure-foundry",
    providerModelId: "o3-mini",
    foundryDeploymentId: "o3-mini",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    defaultOutputTokens: 8192,
    supportsThinking: true,
    defaultThinkingBudget: 5000,
    enabled: true,
  },

  // --- Third-party OpenAI-compatible models ---
  {
    id: "deepseek-v3.2",
    displayName: "DeepSeek V3.2",
    description:
      "DeepSeek V3.2 via Azure AI Foundry - Latest DeepSeek general-purpose & coding",
    provider: "azure-foundry",
    providerModelId: "DeepSeek-V3.2",
    foundryDeploymentId: "deepseek-v3-2",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "deepseek-v3.2-speciale",
    displayName: "DeepSeek V3.2 Speciale",
    description:
      "DeepSeek V3.2 Speciale via Azure AI Foundry - Enhanced DeepSeek V3.2",
    provider: "azure-foundry",
    providerModelId: "DeepSeek-V3.2-Speciale",
    foundryDeploymentId: "deepseek-v3-2-speciale",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "llama-3.3-70b",
    displayName: "Llama 3.3 70B",
    description:
      "Meta Llama-3.3-70B-Instruct via Azure AI Foundry - Strong open-source model",
    provider: "azure-foundry",
    providerModelId: "Llama-3.3-70B-Instruct",
    foundryDeploymentId: "llama-3-3-70b",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "llama-4-maverick",
    displayName: "Llama 4 Maverick",
    description:
      "Meta Llama-4-Maverick-17B via Azure AI Foundry - Llama 4 MoE flagship",
    provider: "azure-foundry",
    providerModelId: "Llama-4-Maverick-17B-128E-Instruct-FP8",
    foundryDeploymentId: "llama-4-maverick",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 1000000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "phi-4-mini-instruct",
    displayName: "Phi-4 Mini",
    description:
      "Microsoft Phi-4-mini-instruct via Azure AI Foundry - Compact and efficient",
    provider: "azure-foundry",
    providerModelId: "Phi-4-mini-instruct",
    foundryDeploymentId: "phi-4-mini-instruct",
    capabilities: ["chat", "code"],
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    defaultOutputTokens: 2048,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "phi-4-mini-reasoning",
    displayName: "Phi-4 Mini Reasoning",
    description:
      "Microsoft Phi-4-mini-reasoning via Azure AI Foundry - Compact reasoning model",
    provider: "azure-foundry",
    providerModelId: "Phi-4-mini-reasoning",
    foundryDeploymentId: "phi-4-mini-reasoning",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: true,
    defaultThinkingBudget: 3000,
    enabled: true,
  },
  {
    id: "phi-4-reasoning",
    displayName: "Phi-4 Reasoning",
    description:
      "Microsoft Phi-4-reasoning via Azure AI Foundry - Full reasoning variant of Phi-4",
    provider: "azure-foundry",
    providerModelId: "Phi-4-reasoning",
    foundryDeploymentId: "phi-4-reasoning",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 8192,
    supportsThinking: true,
    defaultThinkingBudget: 5000,
    enabled: true,
  },
  {
    id: "codestral-2501",
    displayName: "Codestral 2501",
    description:
      "Mistral Codestral-2501 via Azure AI Foundry - Specialized code model",
    provider: "azure-foundry",
    providerModelId: "Codestral-2501",
    foundryDeploymentId: "codestral-2501",
    capabilities: ["chat", "code"],
    maxInputTokens: 256000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "grok-3",
    displayName: "Grok 3",
    description:
      "xAI Grok 3 via Azure AI Foundry - Powerful general-purpose model",
    provider: "azure-foundry",
    providerModelId: "grok-3",
    foundryDeploymentId: "grok-3",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 131072,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "grok-3-mini",
    displayName: "Grok 3 Mini",
    description:
      "xAI Grok 3 Mini via Azure AI Foundry - Lightweight Grok model",
    provider: "azure-foundry",
    providerModelId: "grok-3-mini",
    foundryDeploymentId: "grok-3-mini",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 131072,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "grok-4-1-fast-nr",
    displayName: "Grok 4.1 Fast",
    description: "xAI Grok 4.1 Fast (non-reasoning) via Azure AI Foundry",
    provider: "azure-foundry",
    providerModelId: "grok-4-1-fast-non-reasoning",
    foundryDeploymentId: "grok-4-1-fast-nr",
    capabilities: ["chat", "code"],
    maxInputTokens: 256000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
  {
    id: "grok-4-1-fast-r",
    displayName: "Grok 4.1 Fast Reasoning",
    description: "xAI Grok 4.1 Fast Reasoning via Azure AI Foundry",
    provider: "azure-foundry",
    providerModelId: "grok-4-1-fast-reasoning",
    foundryDeploymentId: "grok-4-1-fast-r",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 256000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 8192,
    supportsThinking: true,
    defaultThinkingBudget: 5000,
    enabled: true,
  },
  {
    id: "kimi-k2-thinking",
    displayName: "Kimi K2 Thinking",
    description:
      "MoonshotAI Kimi-K2-Thinking via Azure AI Foundry - Long-context reasoning model",
    provider: "azure-foundry",
    providerModelId: "Kimi-K2-Thinking",
    foundryDeploymentId: "kimi-k2-thinking",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 8192,
    supportsThinking: true,
    defaultThinkingBudget: 5000,
    enabled: true,
  },
  {
    id: "kimi-k2.5",
    displayName: "Kimi K2.5",
    description:
      "MoonshotAI Kimi-K2.5 via Azure AI Foundry - Long-context general model",
    provider: "azure-foundry",
    providerModelId: "Kimi-K2.5",
    foundryDeploymentId: "kimi-k2-5",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    enabled: true,
  },
];

// =============================================================================
// Image Generation Models Configuration - Azure AI Foundry
// =============================================================================

export const IMAGE_MODELS: ImageModelConfig[] = [
  {
    id: "flux-2-pro",
    displayName: "FLUX.2 Pro",
    description:
      "Black Forest Labs FLUX.2 Pro - High-quality image generation & editing",
    provider: "azure-foundry",
    providerModelId: "FLUX.2-pro",
    foundryDeploymentId: "flux-2-pro", // lowercase as required by API
    capabilities: ["image-gen", "image-edit"],
    apiProvider: "blackforestlabs",
    apiEndpointPath: "/providers/blackforestlabs/v1/flux-2-pro",
    defaultSize: "1024x1024",
    supportedSizes: ["512x512", "768x768", "1024x1024", "1024x768", "768x1024"],
    supportedFormats: ["jpeg", "png"],
    enabled: true,
    isDefault: true,
  },
  {
    id: "flux-kontext-pro",
    displayName: "FLUX Kontext Pro",
    description:
      "Black Forest Labs FLUX Kontext Pro - Context-aware image generation",
    provider: "azure-foundry",
    providerModelId: "FLUX.1-Kontext-pro",
    foundryDeploymentId: "flux-kontext-pro",
    capabilities: ["image-gen", "image-edit"],
    apiProvider: "blackforestlabs",
    apiEndpointPath: "/providers/blackforestlabs/v1/flux-kontext-pro",
    defaultSize: "1024x1024",
    supportedSizes: ["512x512", "768x768", "1024x1024", "1024x768", "768x1024"],
    supportedFormats: ["jpeg", "png"],
    enabled: true,
  },
  {
    id: "flux-1-pro",
    displayName: "FLUX.1 Pro",
    description: "Black Forest Labs FLUX.1 Pro - Fast image generation",
    provider: "azure-foundry",
    providerModelId: "FLUX.1-pro",
    foundryDeploymentId: "flux-1-pro",
    capabilities: ["image-gen"],
    apiProvider: "blackforestlabs",
    apiEndpointPath: "/providers/blackforestlabs/v1/flux-1-pro",
    defaultSize: "1024x1024",
    supportedSizes: ["512x512", "768x768", "1024x1024", "1024x768", "768x1024"],
    supportedFormats: ["jpeg", "png"],
    enabled: false, // Not deployed yet
  },
];

// =============================================================================
// Helper Functions
// =============================================================================

export function getModelConfig(modelId: string): AIModelConfig | undefined {
  return AI_MODELS.find((m) => m.id === modelId);
}

export function getModelsByProvider(provider: AIProvider): AIModelConfig[] {
  return AI_MODELS.filter((m) => m.provider === provider && m.enabled);
}

export function getEnabledModels(): AIModelConfig[] {
  return AI_MODELS.filter((m) => m.enabled);
}

export function getDefaultModel(): AIModelConfig {
  return AI_MODELS.find((m) => m.isDefault) || AI_MODELS[0];
}

export function getProviderEndpoint(provider: AIProvider): ProviderEndpoint {
  return PROVIDER_ENDPOINTS[provider];
}

// =============================================================================
// Image Model Helper Functions
// =============================================================================

export function getImageModelConfig(
  modelId: string,
): ImageModelConfig | undefined {
  return IMAGE_MODELS.find((m) => m.id === modelId);
}

export function getDefaultImageModel(): ImageModelConfig {
  return IMAGE_MODELS.find((m) => m.isDefault) || IMAGE_MODELS[0];
}

export function getEnabledImageModels(): ImageModelConfig[] {
  return IMAGE_MODELS.filter((m) => m.enabled);
}

/**
 * Build the image generation endpoint URL
 * BFL models route through APIM BFL API - APIM handles Managed Identity auth
 * and sets api-version=preview automatically via policy
 */
export function buildImageEndpointUrl(modelId: string): string {
  const model = getImageModelConfig(modelId);
  if (!model) throw new Error(`Unknown image model: ${modelId}`);

  // BFL models use a separate APIM API path: /bfl/providers/blackforestlabs/v1/{model-id}
  const apimBase = process.env.APIM_OPENAI_URL || "";
  // Derive APIM base from the OpenAI URL (strip /openai path)
  const apimRoot = apimBase.replace(/\/openai$/, "");

  return `${apimRoot}/bfl${model.apiEndpointPath}`;
}

/**
 * All models use Azure AI Foundry via APIM
 */
export function getRouteHandlerName(_modelId: string): string {
  return "chat-stream-foundry";
}

/**
 * Get the Foundry deployment name for API calls
 */
export function getFoundryDeploymentId(modelId: string): string | undefined {
  const model = getModelConfig(modelId);
  return model?.foundryDeploymentId;
}

/**
 * Build the endpoint URL for a specific model
 */
export function buildEndpointUrl(modelId: string): string {
  const model = getModelConfig(modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);

  const endpoint = PROVIDER_ENDPOINTS["azure-foundry"];
  const baseUrl = endpoint.baseUrl.endsWith("/")
    ? endpoint.baseUrl.slice(0, -1)
    : endpoint.baseUrl;
  const apiVersion = model.apiVersion || endpoint.apiVersion;
  return `${baseUrl}/deployments/${model.foundryDeploymentId}/chat/completions?api-version=${apiVersion}`;
}

export default {
  models: AI_MODELS,
  imageModels: IMAGE_MODELS,
  providers: PROVIDER_ENDPOINTS,
  getModelConfig,
  getModelsByProvider,
  getEnabledModels,
  getDefaultModel,
  getProviderEndpoint,
  getRouteHandlerName,
  getFoundryDeploymentId,
  buildEndpointUrl,
  getImageModelConfig,
  getDefaultImageModel,
  getEnabledImageModels,
  buildImageEndpointUrl,
};

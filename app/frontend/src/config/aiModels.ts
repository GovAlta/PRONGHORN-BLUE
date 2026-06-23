/**
 * Centralized AI Model Configuration
 * =============================================================================
 * Azure AI Foundry only - All AI calls go through the backend API which routes
 * to APIM with Managed Identity authentication.
 * 
 * Usage:
 *   import { AI_MODELS, getModelConfig, getModelsByProvider } from '@/config/aiModels';
 * =============================================================================
 */

// =============================================================================
// Types & Interfaces
// =============================================================================

export type AIProvider = "azure-foundry";

export type ModelCapability = 
  | "chat"           // Text chat/completion
  | "vision"         // Image understanding
  | "image-gen"      // Image generation
  | "code"           // Code generation/analysis
  | "reasoning"      // Extended thinking/reasoning
  | "embedding"      // Text embeddings
  | "audio";         // Audio processing

export interface AIModelConfig {
  /** Unique model identifier used in code */
  id: string;
  /** Display name shown in UI */
  displayName: string;
  /** Short description */
  description: string;
  /** AI provider */
  provider: AIProvider;
  /** Original provider model ID (for direct API calls) */
  providerModelId: string;
  /** Azure AI Foundry deployment name */
  foundryDeploymentId?: string;
  /** Model capabilities */
  capabilities: ModelCapability[];
  /** Maximum input tokens */
  maxInputTokens: number;
  /** Maximum output tokens */
  maxOutputTokens: number;
  /** Default output tokens */
  defaultOutputTokens: number;
  /** Supports extended thinking */
  supportsThinking: boolean;
  /** Default thinking budget (if supported) */
  defaultThinkingBudget?: number;
  /** Cost per 1M input tokens (USD) */
  costPerMInputTokens?: number;
  /** Cost per 1M output tokens (USD) */
  costPerMOutputTokens?: number;
  /** Recommended for specific use cases */
  recommendedFor?: string[];
  /** Is this model enabled for use */
  enabled: boolean;
  /** Is this model the default for new projects */
  isDefault?: boolean;
}

export interface ProviderEndpoint {
  /** Provider name */
  provider: AIProvider;
  /** Base URL for API calls */
  baseUrl: string;
  /** API version (if applicable) */
  apiVersion?: string;
}

// =============================================================================
// Provider Endpoints Configuration
// =============================================================================

export const PROVIDER_ENDPOINTS: Record<AIProvider, ProviderEndpoint> = {
  "azure-foundry": {
    provider: "azure-foundry",
    baseUrl: import.meta.env?.VITE_API_BASE_URL || "",
    apiVersion: "2024-10-01-preview",
  },
};

// =============================================================================
// AI Models Configuration - Azure AI Foundry Only
// =============================================================================

export const AI_MODELS: AIModelConfig[] = [
  {
    id: "gpt-4o",
    displayName: "GPT-4o",
    description: "OpenAI GPT-4o via Azure AI Foundry - Best multimodal performance",
    provider: "azure-foundry",
    providerModelId: "gpt-4o",
    foundryDeploymentId: "gpt-4o",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    costPerMInputTokens: 2.5,
    costPerMOutputTokens: 10,
    recommendedFor: ["multimodal", "vision", "general-purpose"],
    enabled: true,
    isDefault: true,
  },
  {
    id: "gpt-4o-mini",
    displayName: "GPT-4o Mini",
    description: "OpenAI GPT-4o-mini via Azure AI Foundry - Fast and cost-effective",
    provider: "azure-foundry",
    providerModelId: "gpt-4o-mini",
    foundryDeploymentId: "gpt-4o-mini",
    capabilities: ["chat", "vision", "code"],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    costPerMInputTokens: 0.15,
    costPerMOutputTokens: 0.6,
    recommendedFor: ["cost-sensitive", "high-volume"],
    enabled: true,
  },
  {
    id: "gpt-4.1",
    displayName: "GPT-4.1",
    description: "OpenAI GPT-4.1 via Azure AI Foundry - Best for coding and long contexts",
    provider: "azure-foundry",
    providerModelId: "gpt-4.1",
    foundryDeploymentId: "gpt-4-1",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 8192,
    supportsThinking: false,
    costPerMInputTokens: 3.5,
    costPerMOutputTokens: 10.5,
    recommendedFor: ["coding", "complex-tasks", "long-context"],
    enabled: true,
  },
  {
    id: "gpt-4.1-mini",
    displayName: "GPT-4.1 Mini",
    description: "OpenAI GPT-4.1-mini via Azure AI Foundry - Cost-effective for most tasks",
    provider: "azure-foundry",
    providerModelId: "gpt-4.1-mini",
    foundryDeploymentId: "gpt-4-1-mini",
    capabilities: ["chat", "vision", "code"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    costPerMInputTokens: 0.7,
    costPerMOutputTokens: 2.1,
    recommendedFor: ["general-chat", "cost-sensitive"],
    enabled: true,
  },
  {
    id: "o3",
    displayName: "OpenAI o3",
    description: "OpenAI o3 via Azure AI Foundry - Advanced reasoning for complex problems",
    provider: "azure-foundry",
    providerModelId: "o3",
    foundryDeploymentId: "o3",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    defaultOutputTokens: 16384,
    supportsThinking: true,
    defaultThinkingBudget: 10000,
    costPerMInputTokens: 3.5,
    costPerMOutputTokens: 10.5,
    recommendedFor: ["complex-reasoning", "math", "science"],
    enabled: true,
  },
  {
    id: "o4-mini",
    displayName: "OpenAI o4-mini",
    description: "OpenAI o4-mini via Azure AI Foundry - Efficient reasoning model",
    provider: "azure-foundry",
    providerModelId: "o4-mini",
    foundryDeploymentId: "o4-mini",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    defaultOutputTokens: 8192,
    supportsThinking: true,
    defaultThinkingBudget: 5000,
    costPerMInputTokens: 1.925,
    costPerMOutputTokens: 5.775,
    recommendedFor: ["reasoning", "cost-effective"],
    enabled: true,
  },
  {
    id: "deepseek-v3.1",
    displayName: "DeepSeek V3.1",
    description: "DeepSeek V3.1 via Azure AI Foundry - Strong general-purpose & coding",
    provider: "azure-foundry",
    providerModelId: "DeepSeek-V3.1",
    foundryDeploymentId: "deepseek-v3-1",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    costPerMInputTokens: 0.27,
    costPerMOutputTokens: 1.10,
    recommendedFor: ["general-purpose", "coding", "cost-effective"],
    enabled: true,
  },
  {
    id: "phi-4",
    displayName: "Phi-4",
    description: "Microsoft Phi-4 via Azure AI Foundry - Fast and efficient small model",
    provider: "azure-foundry",
    providerModelId: "Phi-4",
    foundryDeploymentId: "phi-4",
    capabilities: ["chat", "code"],
    maxInputTokens: 16384,
    maxOutputTokens: 4096,
    defaultOutputTokens: 2048,
    supportsThinking: false,
    costPerMInputTokens: 0.07,
    costPerMOutputTokens: 0.14,
    recommendedFor: ["cost-sensitive", "high-volume", "fast"],
    enabled: true,
  },
  {
    id: "mistral-large-3",
    displayName: "Mistral Large 3",
    description: "Mistral Large 3 via Azure AI Foundry - Premium coding & instruction following",
    provider: "azure-foundry",
    providerModelId: "Mistral-Large-3",
    foundryDeploymentId: "mistral-large-3",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    costPerMInputTokens: 2.0,
    costPerMOutputTokens: 6.0,
    recommendedFor: ["coding", "complex-tasks", "instruction-following"],
    enabled: true,
  },

  // --- OpenAI models ---
  {
    id: "gpt-4.1-nano",
    displayName: "GPT-4.1 Nano",
    description: "OpenAI GPT-4.1-nano via Azure AI Foundry - Fastest and most affordable OpenAI model",
    provider: "azure-foundry",
    providerModelId: "gpt-4.1-nano",
    foundryDeploymentId: "gpt-4-1-nano",
    capabilities: ["chat", "vision", "code"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    costPerMInputTokens: 0.1,
    costPerMOutputTokens: 0.4,
    recommendedFor: ["cost-sensitive", "high-volume", "fast"],
    enabled: true,
  },
  {
    id: "gpt-5-chat",
    displayName: "GPT-5",
    description: "OpenAI GPT-5 via Azure AI Foundry - Next-generation flagship model",
    provider: "azure-foundry",
    providerModelId: "gpt-5-chat",
    foundryDeploymentId: "gpt-5-chat",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 8192,
    supportsThinking: false,
    recommendedFor: ["complex-tasks", "multimodal", "general-purpose"],
    enabled: true,
  },
  {
    id: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    description: "OpenAI GPT-5-mini via Azure AI Foundry - Next-generation mid-tier model",
    provider: "azure-foundry",
    providerModelId: "gpt-5-mini",
    foundryDeploymentId: "gpt-5-mini",
    capabilities: ["chat", "vision", "code"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    recommendedFor: ["general-chat", "cost-sensitive"],
    enabled: true,
  },
  {
    id: "gpt-5-nano",
    displayName: "GPT-5 Nano",
    description: "OpenAI GPT-5-nano via Azure AI Foundry - Next-generation lightweight model",
    provider: "azure-foundry",
    providerModelId: "gpt-5-nano",
    foundryDeploymentId: "gpt-5-nano",
    capabilities: ["chat", "code"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    recommendedFor: ["cost-sensitive", "high-volume"],
    enabled: true,
  },
  {
    id: "gpt-5.1-chat",
    displayName: "GPT-5.1",
    description: "OpenAI GPT-5.1 via Azure AI Foundry - Latest generation flagship model",
    provider: "azure-foundry",
    providerModelId: "gpt-5.1-chat",
    foundryDeploymentId: "gpt-5-1-chat",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    defaultOutputTokens: 8192,
    supportsThinking: false,
    recommendedFor: ["complex-tasks", "multimodal", "general-purpose"],
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
    recommendedFor: ["complex-reasoning", "math", "science"],
    enabled: true,
  },
  {
    id: "o3-mini",
    displayName: "OpenAI o3-mini",
    description: "OpenAI o3-mini via Azure AI Foundry - Efficient reasoning model",
    provider: "azure-foundry",
    providerModelId: "o3-mini",
    foundryDeploymentId: "o3-mini",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    defaultOutputTokens: 8192,
    supportsThinking: true,
    defaultThinkingBudget: 5000,
    recommendedFor: ["reasoning", "cost-effective"],
    enabled: true,
  },

  // --- Third-party OpenAI-compatible models ---
  {
    id: "deepseek-v3.2",
    displayName: "DeepSeek V3.2",
    description: "DeepSeek V3.2 via Azure AI Foundry - Latest DeepSeek general-purpose & coding",
    provider: "azure-foundry",
    providerModelId: "DeepSeek-V3.2",
    foundryDeploymentId: "deepseek-v3-2",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    costPerMInputTokens: 0.27,
    costPerMOutputTokens: 1.10,
    recommendedFor: ["general-purpose", "coding", "cost-effective"],
    enabled: true,
  },
  {
    id: "deepseek-v3.2-speciale",
    displayName: "DeepSeek V3.2 Speciale",
    description: "DeepSeek V3.2 Speciale via Azure AI Foundry - Enhanced DeepSeek V3.2",
    provider: "azure-foundry",
    providerModelId: "DeepSeek-V3.2-Speciale",
    foundryDeploymentId: "deepseek-v3-2-speciale",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    costPerMInputTokens: 0.27,
    costPerMOutputTokens: 1.10,
    recommendedFor: ["general-purpose", "coding"],
    enabled: true,
  },
  {
    id: "llama-3.3-70b",
    displayName: "Llama 3.3 70B",
    description: "Meta Llama-3.3-70B-Instruct via Azure AI Foundry - Strong open-source model",
    provider: "azure-foundry",
    providerModelId: "Llama-3.3-70B-Instruct",
    foundryDeploymentId: "llama-3-3-70b",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    recommendedFor: ["general-purpose", "open-source"],
    enabled: true,
  },
  {
    id: "llama-4-maverick",
    displayName: "Llama 4 Maverick",
    description: "Meta Llama-4-Maverick-17B via Azure AI Foundry - Llama 4 MoE flagship",
    provider: "azure-foundry",
    providerModelId: "Llama-4-Maverick-17B-128E-Instruct-FP8",
    foundryDeploymentId: "llama-4-maverick",
    capabilities: ["chat", "vision", "code", "reasoning"],
    maxInputTokens: 1000000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    recommendedFor: ["multimodal", "long-context", "open-source"],
    enabled: true,
  },
  {
    id: "phi-4-mini-instruct",
    displayName: "Phi-4 Mini",
    description: "Microsoft Phi-4-mini-instruct via Azure AI Foundry - Compact and efficient",
    provider: "azure-foundry",
    providerModelId: "Phi-4-mini-instruct",
    foundryDeploymentId: "phi-4-mini-instruct",
    capabilities: ["chat", "code"],
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    defaultOutputTokens: 2048,
    supportsThinking: false,
    costPerMInputTokens: 0.05,
    costPerMOutputTokens: 0.10,
    recommendedFor: ["cost-sensitive", "high-volume", "fast"],
    enabled: true,
  },
  {
    id: "phi-4-mini-reasoning",
    displayName: "Phi-4 Mini Reasoning",
    description: "Microsoft Phi-4-mini-reasoning via Azure AI Foundry - Compact reasoning model",
    provider: "azure-foundry",
    providerModelId: "Phi-4-mini-reasoning",
    foundryDeploymentId: "phi-4-mini-reasoning",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: true,
    defaultThinkingBudget: 3000,
    costPerMInputTokens: 0.05,
    costPerMOutputTokens: 0.15,
    recommendedFor: ["reasoning", "cost-effective"],
    enabled: true,
  },
  {
    id: "phi-4-reasoning",
    displayName: "Phi-4 Reasoning",
    description: "Microsoft Phi-4-reasoning via Azure AI Foundry - Full reasoning variant of Phi-4",
    provider: "azure-foundry",
    providerModelId: "Phi-4-reasoning",
    foundryDeploymentId: "phi-4-reasoning",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 8192,
    supportsThinking: true,
    defaultThinkingBudget: 5000,
    costPerMInputTokens: 0.07,
    costPerMOutputTokens: 0.21,
    recommendedFor: ["reasoning", "math", "cost-effective"],
    enabled: true,
  },
  {
    id: "codestral-2501",
    displayName: "Codestral 2501",
    description: "Mistral Codestral-2501 via Azure AI Foundry - Specialized code model",
    provider: "azure-foundry",
    providerModelId: "Codestral-2501",
    foundryDeploymentId: "codestral-2501",
    capabilities: ["chat", "code"],
    maxInputTokens: 256000,
    maxOutputTokens: 8192,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    recommendedFor: ["coding", "long-context"],
    enabled: true,
  },
  {
    id: "grok-3",
    displayName: "Grok 3",
    description: "xAI Grok 3 via Azure AI Foundry - Powerful general-purpose model",
    provider: "azure-foundry",
    providerModelId: "grok-3",
    foundryDeploymentId: "grok-3",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 131072,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    recommendedFor: ["general-purpose", "coding"],
    enabled: true,
  },
  {
    id: "grok-3-mini",
    displayName: "Grok 3 Mini",
    description: "xAI Grok 3 Mini via Azure AI Foundry - Lightweight Grok model",
    provider: "azure-foundry",
    providerModelId: "grok-3-mini",
    foundryDeploymentId: "grok-3-mini",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 131072,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    recommendedFor: ["general-purpose", "cost-sensitive"],
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
    recommendedFor: ["general-purpose", "long-context"],
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
    recommendedFor: ["complex-reasoning", "coding"],
    enabled: true,
  },
  {
    id: "kimi-k2-thinking",
    displayName: "Kimi K2 Thinking",
    description: "MoonshotAI Kimi-K2-Thinking via Azure AI Foundry - Long-context reasoning model",
    provider: "azure-foundry",
    providerModelId: "Kimi-K2-Thinking",
    foundryDeploymentId: "kimi-k2-thinking",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 8192,
    supportsThinking: true,
    defaultThinkingBudget: 5000,
    recommendedFor: ["complex-reasoning", "coding"],
    enabled: true,
  },
  {
    id: "kimi-k2.5",
    displayName: "Kimi K2.5",
    description: "MoonshotAI Kimi-K2.5 via Azure AI Foundry - Long-context general model",
    provider: "azure-foundry",
    providerModelId: "Kimi-K2.5",
    foundryDeploymentId: "kimi-k2-5",
    capabilities: ["chat", "code", "reasoning"],
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultOutputTokens: 4096,
    supportsThinking: false,
    recommendedFor: ["general-purpose", "long-context"],
    enabled: true,
  },
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get model configuration by ID
 */
export function getModelConfig(modelId: string): AIModelConfig | undefined {
  return AI_MODELS.find(m => m.id === modelId);
}

/**
 * Get all models for a specific provider
 */
export function getModelsByProvider(provider: AIProvider): AIModelConfig[] {
  return AI_MODELS.filter(m => m.provider === provider && m.enabled);
}

/**
 * Get all enabled models
 */
export function getEnabledModels(): AIModelConfig[] {
  return AI_MODELS.filter(m => m.enabled);
}

/**
 * Get the default model
 */
export function getDefaultModel(): AIModelConfig {
  return AI_MODELS.find(m => m.isDefault) || AI_MODELS[0];
}

/**
 * Get models with a specific capability
 */
export function getModelsByCapability(capability: ModelCapability): AIModelConfig[] {
  return AI_MODELS.filter(m => m.enabled && m.capabilities.includes(capability));
}

/**
 * Get provider endpoint configuration
 */
export function getProviderEndpoint(provider: AIProvider): ProviderEndpoint {
  return PROVIDER_ENDPOINTS[provider];
}

/**
 * All models use Azure AI Foundry via the backend API
 */
export function getEdgeFunctionName(_modelId: string): string {
  return "chat-stream-foundry";
}

/**
 * Get the Foundry deployment ID for a model
 */
export function getFoundryDeploymentId(modelId: string): string | undefined {
  const model = getModelConfig(modelId);
  return model?.foundryDeploymentId;
}

/**
 * Check if a model supports thinking/extended reasoning
 */
export function supportsThinking(modelId: string): boolean {
  const model = getModelConfig(modelId);
  return model?.supportsThinking ?? false;
}

/**
 * Get model options for UI select components
 */
export function getModelSelectOptions(): Array<{ value: string; label: string; description: string }> {
  return getEnabledModels().map(m => ({
    value: m.id,
    label: m.displayName,
    description: m.description,
  }));
}

/**
 * Group models by provider for categorized display
 */
export function getModelsGroupedByProvider(): Record<AIProvider, AIModelConfig[]> {
  const grouped: Record<AIProvider, AIModelConfig[]> = {
    "azure-foundry": [],
  };
  
  getEnabledModels().forEach(m => {
    grouped[m.provider].push(m);
  });
  
  return grouped;
}

// =============================================================================
// Export default for convenience
// =============================================================================

export default {
  models: AI_MODELS,
  providers: PROVIDER_ENDPOINTS,
  getModelConfig,
  getModelsByProvider,
  getEnabledModels,
  getDefaultModel,
  getModelsByCapability,
  getProviderEndpoint,
  getEdgeFunctionName,
  getFoundryDeploymentId,
  supportsThinking,
  getModelSelectOptions,
  getModelsGroupedByProvider,
};

import { describe, it, expect } from "vitest";
import {
  AI_MODELS,
  getModelConfig,
  getModelsByProvider,
  getEnabledModels,
  getDefaultModel,
  getModelsByCapability,
  supportsThinking,
  getModelSelectOptions,
  getModelsGroupedByProvider,
  getEdgeFunctionName,
  getFoundryDeploymentId,
  getProviderEndpoint,
} from "../aiModels";

// =============================================================================
// AI_MODELS static data
// =============================================================================

describe("AI_MODELS", () => {
  it("contains at least one model", () => {
    expect(AI_MODELS.length).toBeGreaterThan(0);
  });

  it("has unique model IDs", () => {
    const ids = AI_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all models have required fields", () => {
    AI_MODELS.forEach((m) => {
      expect(m.id).toBeTruthy();
      expect(m.displayName).toBeTruthy();
      expect(m.provider).toBe("azure-foundry");
      expect(m.capabilities.length).toBeGreaterThan(0);
      expect(m.maxInputTokens).toBeGreaterThan(0);
      expect(m.maxOutputTokens).toBeGreaterThan(0);
    });
  });

  it("has exactly one default model", () => {
    const defaults = AI_MODELS.filter((m) => m.isDefault);
    expect(defaults.length).toBe(1);
  });
});

// =============================================================================
// getModelConfig
// =============================================================================

describe("getModelConfig", () => {
  it("returns model config for valid ID", () => {
    const model = getModelConfig("gpt-4o");
    expect(model).toBeDefined();
    expect(model!.id).toBe("gpt-4o");
    expect(model!.displayName).toBe("GPT-4o");
  });

  it("returns undefined for invalid ID", () => {
    expect(getModelConfig("nonexistent-model")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(getModelConfig("")).toBeUndefined();
  });
});

// =============================================================================
// getModelsByProvider
// =============================================================================

describe("getModelsByProvider", () => {
  it("returns all azure-foundry models", () => {
    const models = getModelsByProvider("azure-foundry");
    expect(models.length).toBeGreaterThan(0);
    models.forEach((m) => {
      expect(m.provider).toBe("azure-foundry");
      expect(m.enabled).toBe(true);
    });
  });
});

// =============================================================================
// getEnabledModels
// =============================================================================

describe("getEnabledModels", () => {
  it("returns only enabled models", () => {
    const models = getEnabledModels();
    models.forEach((m) => expect(m.enabled).toBe(true));
  });

  it("returns at least one model", () => {
    expect(getEnabledModels().length).toBeGreaterThan(0);
  });
});

// =============================================================================
// getDefaultModel
// =============================================================================

describe("getDefaultModel", () => {
  it("returns a model", () => {
    const model = getDefaultModel();
    expect(model).toBeDefined();
    expect(model.id).toBeTruthy();
  });

  it("returns the model marked as default", () => {
    const model = getDefaultModel();
    expect(model.isDefault).toBe(true);
  });

  it("returns gpt-4o as default", () => {
    expect(getDefaultModel().id).toBe("gpt-4o");
  });
});

// =============================================================================
// getModelsByCapability
// =============================================================================

describe("getModelsByCapability", () => {
  it("returns models with 'chat' capability", () => {
    const models = getModelsByCapability("chat");
    expect(models.length).toBeGreaterThan(0);
    models.forEach((m) => expect(m.capabilities).toContain("chat"));
  });

  it("returns models with 'vision' capability", () => {
    const models = getModelsByCapability("vision");
    expect(models.length).toBeGreaterThan(0);
    models.forEach((m) => expect(m.capabilities).toContain("vision"));
  });

  it("returns models with 'reasoning' capability", () => {
    const models = getModelsByCapability("reasoning");
    expect(models.length).toBeGreaterThan(0);
    models.forEach((m) => expect(m.capabilities).toContain("reasoning"));
  });

  it("returns empty array for nonexistent capability", () => {
    // @ts-expect-error testing invalid capability
    const models = getModelsByCapability("teleportation");
    expect(models).toHaveLength(0);
  });
});

// =============================================================================
// supportsThinking
// =============================================================================

describe("supportsThinking", () => {
  it("returns true for o3 model", () => {
    expect(supportsThinking("o3")).toBe(true);
  });

  it("returns true for o4-mini model", () => {
    expect(supportsThinking("o4-mini")).toBe(true);
  });

  it("returns false for gpt-4o", () => {
    expect(supportsThinking("gpt-4o")).toBe(false);
  });

  it("returns false for unknown model", () => {
    expect(supportsThinking("nonexistent")).toBe(false);
  });
});

// =============================================================================
// getModelSelectOptions
// =============================================================================

describe("getModelSelectOptions", () => {
  it("returns options for all enabled models", () => {
    const options = getModelSelectOptions();
    expect(options.length).toBe(getEnabledModels().length);
  });

  it("each option has value, label, description", () => {
    const options = getModelSelectOptions();
    options.forEach((opt) => {
      expect(opt.value).toBeTruthy();
      expect(opt.label).toBeTruthy();
      expect(opt.description).toBeTruthy();
    });
  });
});

// =============================================================================
// getModelsGroupedByProvider
// =============================================================================

describe("getModelsGroupedByProvider", () => {
  it("groups models by provider", () => {
    const grouped = getModelsGroupedByProvider();
    expect(grouped["azure-foundry"]).toBeDefined();
    expect(grouped["azure-foundry"].length).toBeGreaterThan(0);
  });
});

// =============================================================================
// getEdgeFunctionName
// =============================================================================

describe("getEdgeFunctionName", () => {
  it("returns chat-stream-foundry for any model", () => {
    expect(getEdgeFunctionName("gpt-4o")).toBe("chat-stream-foundry");
    expect(getEdgeFunctionName("o3")).toBe("chat-stream-foundry");
    expect(getEdgeFunctionName("unknown")).toBe("chat-stream-foundry");
  });
});

// =============================================================================
// getFoundryDeploymentId
// =============================================================================

describe("getFoundryDeploymentId", () => {
  it("returns deployment ID for known model", () => {
    expect(getFoundryDeploymentId("gpt-4o")).toBe("gpt-4o");
    expect(getFoundryDeploymentId("gpt-4.1")).toBe("gpt-4-1");
  });

  it("returns undefined for unknown model", () => {
    expect(getFoundryDeploymentId("nonexistent")).toBeUndefined();
  });
});

// =============================================================================
// getProviderEndpoint
// =============================================================================

describe("getProviderEndpoint", () => {
  it("returns azure-foundry endpoint", () => {
    const ep = getProviderEndpoint("azure-foundry");
    expect(ep.provider).toBe("azure-foundry");
    expect(ep.apiVersion).toBeDefined();
  });
});

/**
 * Unit tests for the aiModels configuration module
 */
import {
  AI_MODELS,
  IMAGE_MODELS,
  PROVIDER_ENDPOINTS,
  getModelConfig,
  getModelsByProvider,
  getEnabledModels,
  getDefaultModel,
  getProviderEndpoint,
  getImageModelConfig,
  getDefaultImageModel,
  getEnabledImageModels,
  buildEndpointUrl,
  buildImageEndpointUrl,
  getFoundryDeploymentId,
  getRouteHandlerName,
} from "../../config/aiModels";

describe("AI_MODELS", () => {
  it("should contain model definitions", () => {
    expect(AI_MODELS.length).toBeGreaterThan(0);
  });

  it("should have required fields on every model", () => {
    for (const model of AI_MODELS) {
      expect(model.id).toBeDefined();
      expect(model.displayName).toBeDefined();
      expect(model.provider).toBe("azure-foundry");
      expect(model.capabilities.length).toBeGreaterThan(0);
      expect(model.maxInputTokens).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it("should have exactly one default model", () => {
    const defaults = AI_MODELS.filter(m => m.isDefault);
    expect(defaults.length).toBe(1);
  });
});

describe("IMAGE_MODELS", () => {
  it("should contain image model definitions", () => {
    expect(IMAGE_MODELS.length).toBeGreaterThan(0);
  });

  it("should have exactly one default image model", () => {
    const defaults = IMAGE_MODELS.filter(m => m.isDefault);
    expect(defaults.length).toBe(1);
  });
});

describe("PROVIDER_ENDPOINTS", () => {
  it("should have azure-foundry endpoint", () => {
    expect(PROVIDER_ENDPOINTS["azure-foundry"]).toBeDefined();
    expect(typeof PROVIDER_ENDPOINTS["azure-foundry"].baseUrl).toBe("string");
  });
});

describe("getModelConfig", () => {
  it("should return model config for a known model", () => {
    const config = getModelConfig("gpt-4o");
    expect(config).toBeDefined();
    expect(config?.id).toBe("gpt-4o");
  });

  it("should return undefined for an unknown model", () => {
    expect(getModelConfig("nonexistent")).toBeUndefined();
  });
});

describe("getModelsByProvider", () => {
  it("should return only enabled models for azure-foundry", () => {
    const models = getModelsByProvider("azure-foundry");
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.provider).toBe("azure-foundry");
      expect(m.enabled).toBe(true);
    }
  });
});

describe("getEnabledModels", () => {
  it("should return only enabled models", () => {
    const models = getEnabledModels();
    for (const m of models) {
      expect(m.enabled).toBe(true);
    }
  });
});

describe("getDefaultModel", () => {
  it("should return the default model", () => {
    const model = getDefaultModel();
    expect(model).toBeDefined();
    expect(model.isDefault).toBe(true);
  });
});

describe("getProviderEndpoint", () => {
  it("should return endpoint for azure-foundry", () => {
    const ep = getProviderEndpoint("azure-foundry");
    expect(ep.provider).toBe("azure-foundry");
    expect(typeof ep.baseUrl).toBe("string");
  });
});

describe("getImageModelConfig", () => {
  it("should return image model config for known model", () => {
    const config = getImageModelConfig("flux-2-pro");
    expect(config).toBeDefined();
    expect(config?.id).toBe("flux-2-pro");
  });

  it("should return undefined for unknown image model", () => {
    expect(getImageModelConfig("nonexistent")).toBeUndefined();
  });
});

describe("getDefaultImageModel", () => {
  it("should return the default image model", () => {
    const model = getDefaultImageModel();
    expect(model).toBeDefined();
    expect(model.isDefault).toBe(true);
  });
});

describe("getEnabledImageModels", () => {
  it("should return only enabled image models", () => {
    const models = getEnabledImageModels();
    for (const m of models) {
      expect(m.enabled).toBe(true);
    }
  });
});

describe("buildEndpointUrl", () => {
  it("should build a valid endpoint URL for a known model", () => {
    const url = buildEndpointUrl("gpt-4o");
    expect(url).toContain("gpt-4o");
    expect(url).toContain("chat/completions");
    expect(url).toContain("api-version");
  });

  it("should throw for an unknown model", () => {
    expect(() => buildEndpointUrl("nonexistent")).toThrow();
  });
});

describe("buildImageEndpointUrl", () => {
  it("should build a valid endpoint URL for a known image model", () => {
    const url = buildImageEndpointUrl("flux-2-pro");
    expect(url).toContain("bfl");
    expect(url).toContain("flux-2-pro");
  });

  it("should throw for an unknown image model", () => {
    expect(() => buildImageEndpointUrl("nonexistent")).toThrow();
  });
});

describe("getFoundryDeploymentId", () => {
  it("should return deployment id for a known model", () => {
    const id = getFoundryDeploymentId("gpt-4o");
    expect(id).toBe("gpt-4o");
  });

  it("should return undefined for an unknown model", () => {
    expect(getFoundryDeploymentId("nonexistent")).toBeUndefined();
  });
});

describe("getRouteHandlerName", () => {
  it("should return chat-stream-foundry for any model", () => {
    expect(getRouteHandlerName("gpt-4o")).toBe("chat-stream-foundry");
    expect(getRouteHandlerName("anything")).toBe("chat-stream-foundry");
  });
});

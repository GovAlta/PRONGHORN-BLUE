/**
 * Unit tests for the chat routes
 */
import express from "express";
import "express-async-errors";
import request from "supertest";
import chatRouter from "../../routes/chat";
import { errorHandler } from "../../middleware/errorHandler";

// Suppress logger output
jest.mock("../../utils/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Mock the database module
jest.mock("../../utils/database", () => {
  const queryFn = jest.fn();
  return { __esModule: true, default: { query: queryFn } };
});

// Mock @azure/identity
jest.mock("@azure/identity", () => ({
  DefaultAzureCredential: jest.fn().mockImplementation(() => ({
    getToken: jest.fn().mockResolvedValue({ token: "mock-azure-token" }),
  })),
}));

// Mock aiModels config
jest.mock("../../config/aiModels", () => ({
  getModelConfig: jest.fn(),
  buildEndpointUrl: jest.fn().mockReturnValue("https://mock-endpoint.com/openai/deployments/gpt-4o/chat/completions"),
  PROVIDER_ENDPOINTS: {
    "azure-foundry": {
      provider: "azure-foundry",
      baseUrl: "https://mock-apim.com/openai",
      apiVersion: "2024-10-01-preview",
    },
  },
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

import db from "../../utils/database";
import { getModelConfig } from "../../config/aiModels";
const mockDbQuery = db.query as jest.Mock;
const mockGetModelConfig = getModelConfig as jest.Mock;

function fakeAuth(userId?: string) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (userId) {
      req.user = { id: userId, email: "test@test.com" };
    }
    next();
  };
}

function createApp(userId = "user-1") {
  const app = express();
  app.use(express.json());
  app.use(fakeAuth(userId));
  app.use("/chat", chatRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetModelConfig.mockReturnValue({
    id: "gpt-4o",
    provider: "azure-foundry",
    foundryDeploymentId: "gpt-4o",
  });
});

// ============================================================================
// POST /chat/stream/foundry
// ============================================================================
describe("POST /chat/stream/foundry", () => {
  it("should return 403 when project access is denied", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // no project access
    const res = await request(createApp())
      .post("/chat/stream/foundry")
      .send({ projectId: "p1", userPrompt: "Hello" });
    expect(res.status).toBe(403);
  });

  it("should return 400 when model is not an Azure Foundry model", async () => {
    mockGetModelConfig.mockReturnValue(null);
    const res = await request(createApp())
      .post("/chat/stream/foundry")
      .send({ userPrompt: "Hello", model: "unknown-model" });
    expect(res.status).toBe(400);
  });

  it("should return 400 when model provider is not azure-foundry", async () => {
    mockGetModelConfig.mockReturnValue({ id: "x", provider: "other" });
    const res = await request(createApp())
      .post("/chat/stream/foundry")
      .send({ userPrompt: "Hello", model: "x" });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// POST /chat/summarize
// ============================================================================
describe("POST /chat/summarize", () => {
  it("should return 400 when sessionId is missing", async () => {
    const res = await request(createApp())
      .post("/chat/summarize")
      .send({ messages: [] });
    expect(res.status).toBe(400);
  });

  it("should return 400 when messages are missing", async () => {
    const res = await request(createApp())
      .post("/chat/summarize")
      .send({ sessionId: "s1" });
    expect(res.status).toBe(400);
  });

  it("should return summary on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "This is a summary" } }],
      }),
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // update session

    const res = await request(createApp())
      .post("/chat/summarize")
      .send({ sessionId: "s1", messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(200);
    expect(res.body.summary).toBe("This is a summary");
  });

  it("should return 500 when AI API fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const res = await request(createApp())
      .post("/chat/summarize")
      .send({ sessionId: "s1", messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(500);
  });
});

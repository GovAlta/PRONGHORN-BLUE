/**
 * Unit tests for the artifacts routes
 */
import express from "express";
import "express-async-errors";
import request from "supertest";
import artifactsRouter from "../../routes/artifacts";
import { errorHandler } from "../../middleware/errorHandler";

jest.mock("../../utils/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("uuid", () => ({ v4: jest.fn().mockReturnValue("test-uuid-1234") }));

const mockGetArtifactContent = jest.fn().mockResolvedValue("# Hello");
const mockPutArtifactContent = jest.fn().mockResolvedValue({ contentLength: 7 });
const mockDeleteArtifactContent = jest.fn().mockResolvedValue(undefined);

jest.mock("../../staging/artifactContentStore", () => ({
  getArtifactContent: (...args: unknown[]) => mockGetArtifactContent(...args),
  putArtifactContent: (...args: unknown[]) => mockPutArtifactContent(...args),
  deleteArtifactContent: (...args: unknown[]) => mockDeleteArtifactContent(...args),
}));

jest.mock("../../utils/database", () => {
  const queryFn = jest.fn();
  return { __esModule: true, default: { query: queryFn } };
});

import db from "../../utils/database";
const mockDbQuery = db.query as jest.Mock;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/artifacts", artifactsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /artifacts/:projectId", () => {
  it("should return all artifacts for a project", async () => {
    const artifacts = [{ id: "a1", ai_title: "doc.md" }];
    mockDbQuery.mockResolvedValueOnce({ rows: artifacts });
    const res = await request(createApp()).get("/artifacts/p1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(artifacts);
  });
});

describe("GET /artifacts/:projectId/:id", () => {
  it("should return a single artifact with blob content", async () => {
    const artifact = { id: "a1", ai_title: "doc.md" };
    mockDbQuery.mockResolvedValueOnce({ rows: [artifact] });
    mockGetArtifactContent.mockResolvedValueOnce("# Hello");
    const res = await request(createApp()).get("/artifacts/p1/a1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...artifact, content: "# Hello" });
    expect(mockGetArtifactContent).toHaveBeenCalledWith("p1", "a1");
  });

  it("should return 404 when artifact not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp()).get("/artifacts/p1/missing");
    expect(res.status).toBe(404);
  });
});

describe("POST /artifacts/:projectId", () => {
  it("should create a new artifact and write content to blob", async () => {
    const created = { id: "test-uuid-1234", ai_title: "new.md", content_length: 7 };
    mockDbQuery.mockResolvedValueOnce({ rows: [created] });
    const res = await request(createApp())
      .post("/artifacts/p1")
      .send({ name: "new.md", type: "document", content: "# Hello" });
    expect(res.status).toBe(201);
    expect(mockPutArtifactContent).toHaveBeenCalledWith("p1", "test-uuid-1234", "# Hello");
  });
});

describe("PATCH /artifacts/:projectId/:id", () => {
  it("should update an artifact and write content to blob when content provided", async () => {
    const updated = { id: "a1", ai_title: "updated.md", content_length: 9 };
    mockDbQuery.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(createApp())
      .patch("/artifacts/p1/a1")
      .send({ name: "updated.md", content: "# Updated" });
    expect(res.status).toBe(200);
    expect(mockPutArtifactContent).toHaveBeenCalledWith("p1", "a1", "# Updated");
  });

  it("should update metadata only when no content provided", async () => {
    const updated = { id: "a1", ai_title: "renamed.md" };
    mockDbQuery.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(createApp())
      .patch("/artifacts/p1/a1")
      .send({ name: "renamed.md" });
    expect(res.status).toBe(200);
    expect(mockPutArtifactContent).not.toHaveBeenCalled();
  });

  it("should return 404 when artifact not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp())
      .patch("/artifacts/p1/missing")
      .send({ name: "x" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /artifacts/:projectId/:id", () => {
  it("should delete an artifact and its blob content", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(createApp()).delete("/artifacts/p1/a1");
    expect(res.status).toBe(204);
    expect(mockDeleteArtifactContent).toHaveBeenCalledWith("p1", "a1");
  });

  it("should return 404 when artifact not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(createApp()).delete("/artifacts/p1/missing");
    expect(res.status).toBe(404);
  });
});

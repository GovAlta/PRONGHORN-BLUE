/**
 * Unit tests for the audit routes
 */
import express from "express";
import "express-async-errors";
import request from "supertest";
import auditRouter from "../../routes/audit";
import { errorHandler } from "../../middleware/errorHandler";

jest.mock("../../utils/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("uuid", () => ({ v4: jest.fn().mockReturnValue("test-uuid-1234") }));

jest.mock("../../utils/database", () => {
  const queryFn = jest.fn();
  return { __esModule: true, default: { query: queryFn } };
});

import db from "../../utils/database";
const mockDbQuery = db.query as jest.Mock;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/audits", auditRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /audits/:projectId", () => {
  it("should return all audits for a project", async () => {
    const audits = [{ id: "au1", type: "security", status: "running" }];
    mockDbQuery.mockResolvedValueOnce({ rows: audits });
    const res = await request(createApp()).get("/audits/p1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(audits);
  });
});

describe("GET /audits/:projectId/:id", () => {
  it("should return a single audit", async () => {
    const audit = { id: "au1", status: "running" };
    mockDbQuery.mockResolvedValueOnce({ rows: [audit] });
    const res = await request(createApp()).get("/audits/p1/au1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(audit);
  });

  it("should return 404 when audit not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp()).get("/audits/p1/missing");
    expect(res.status).toBe(404);
  });
});

describe("POST /audits/:projectId/start", () => {
  it("should create a new audit with running status", async () => {
    const created = { id: "test-uuid-1234", type: "security", status: "running" };
    mockDbQuery.mockResolvedValueOnce({ rows: [created] });
    const res = await request(createApp())
      .post("/audits/p1/start")
      .send({ type: "security", config: {} });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("running");
  });
});

describe("PATCH /audits/:projectId/:id", () => {
  it("should update an audit", async () => {
    const updated = { id: "au1", status: "completed", results: { score: 95 } };
    mockDbQuery.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(createApp())
      .patch("/audits/p1/au1")
      .send({ status: "completed", results: { score: 95 } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
  });

  it("should return 404 when audit not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp())
      .patch("/audits/p1/missing")
      .send({ status: "completed" });
    expect(res.status).toBe(404);
  });
});

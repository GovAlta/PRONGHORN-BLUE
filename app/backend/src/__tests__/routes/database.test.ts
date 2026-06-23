/**
 * Unit tests for the database routes
 */
import express from "express";
import "express-async-errors";
import request from "supertest";
import databaseRouter from "../../routes/database";
import { errorHandler } from "../../middleware/errorHandler";

jest.mock("../../utils/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
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
  app.use("/databases", databaseRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /databases/:projectId", () => {
  it("should return all databases for a project", async () => {
    const dbs = [{ id: "db1", name: "main", type: "postgresql" }];
    mockDbQuery.mockResolvedValueOnce({ rows: dbs });
    const res = await request(createApp()).get("/databases/p1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(dbs);
  });
});

describe("GET /databases/:projectId/:databaseId", () => {
  it("should return a single database", async () => {
    const dbRow = { id: "db1", name: "main" };
    mockDbQuery.mockResolvedValueOnce({ rows: [dbRow] });
    const res = await request(createApp()).get("/databases/p1/db1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(dbRow);
  });

  it("should return 404 when database not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp()).get("/databases/p1/missing");
    expect(res.status).toBe(404);
  });
});

describe("POST /databases/:projectId", () => {
  it("should create a new database schema", async () => {
    const created = {
      id: "test-uuid-1234",
      name: "new-db",
      type: "postgresql",
    };
    mockDbQuery.mockResolvedValueOnce({ rows: [created] });
    const res = await request(createApp())
      .post("/databases/p1")
      .send({ name: "new-db", type: "postgresql", schema: {} });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
  });
});

describe("PATCH /databases/:projectId/:databaseId", () => {
  it("should update a database schema", async () => {
    const updated = { id: "db1", name: "renamed" };
    mockDbQuery.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(createApp())
      .patch("/databases/p1/db1")
      .send({ name: "renamed" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
  });

  it("should return 404 when database not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp())
      .patch("/databases/p1/missing")
      .send({ name: "x" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /databases/:projectId/:databaseId", () => {
  it("should delete a database", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(createApp()).delete("/databases/p1/db1");
    expect(res.status).toBe(204);
  });
});

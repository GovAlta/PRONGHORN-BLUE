/**
 * Unit tests for the canvas routes
 */
import express from "express";
import "express-async-errors";
import request from "supertest";
import canvasRouter from "../../routes/canvas";
import { errorHandler } from "../../middleware/errorHandler";

// Suppress logger output
jest.mock("../../utils/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock uuid
jest.mock("uuid", () => ({
  v4: jest.fn().mockReturnValue("test-uuid-1234"),
}));

// Mock the database module
jest.mock("../../utils/database", () => {
  const queryFn = jest.fn();
  return {
    __esModule: true,
    default: {
      query: queryFn,
      healthCheck: jest.fn(),
      getActiveDbPort: jest.fn(),
    },
  };
});

import db from "../../utils/database";
const mockDbQuery = db.query as jest.Mock;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/canvas", canvasRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================================================
// GET /:projectId/nodes
// ============================================================================
describe("GET /canvas/:projectId/nodes", () => {
  it("should return all nodes for a project", async () => {
    const nodes = [
      { id: "n1", project_id: "p1", type: "task", position: { x: 0, y: 0 } },
      { id: "n2", project_id: "p1", type: "note", position: { x: 100, y: 100 } },
    ];
    mockDbQuery.mockResolvedValueOnce({ rows: nodes });
    const app = createApp();
    const res = await request(app).get("/canvas/p1/nodes");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(nodes);
    expect(mockDbQuery).toHaveBeenCalledWith(expect.stringContaining("canvas_nodes"), ["p1"]);
  });
});

// ============================================================================
// GET /:projectId/edges
// ============================================================================
describe("GET /canvas/:projectId/edges", () => {
  it("should return all edges for a project", async () => {
    const edges = [{ id: "e1", source: "n1", target: "n2" }];
    mockDbQuery.mockResolvedValueOnce({ rows: edges });
    const app = createApp();
    const res = await request(app).get("/canvas/p1/edges");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(edges);
  });
});

// ============================================================================
// POST /:projectId/nodes
// ============================================================================
describe("POST /canvas/:projectId/nodes", () => {
  it("should create a new node with auto-generated id", async () => {
    const createdNode = { id: "test-uuid-1234", project_id: "p1", type: "task" };
    mockDbQuery.mockResolvedValueOnce({ rows: [createdNode] });
    const app = createApp();
    const res = await request(app)
      .post("/canvas/p1/nodes")
      .send({ type: "task", position: { x: 10, y: 20 }, data: {} });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(createdNode);
  });

  it("should use client-provided id when given", async () => {
    const createdNode = { id: "my-custom-id", project_id: "p1", type: "task" };
    mockDbQuery.mockResolvedValueOnce({ rows: [createdNode] });
    const app = createApp();
    const res = await request(app)
      .post("/canvas/p1/nodes")
      .send({ id: "my-custom-id", type: "task", position: { x: 0, y: 0 } });
    expect(res.status).toBe(201);
    expect(mockDbQuery).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["my-custom-id"]));
  });
});

// ============================================================================
// PATCH /:projectId/nodes/:nodeId
// ============================================================================
describe("PATCH /canvas/:projectId/nodes/:nodeId", () => {
  it("should update an existing node", async () => {
    const updatedNode = { id: "n1", project_id: "p1", position: { x: 50, y: 50 } };
    mockDbQuery.mockResolvedValueOnce({ rows: [updatedNode] });
    const app = createApp();
    const res = await request(app)
      .patch("/canvas/p1/nodes/n1")
      .send({ position: { x: 50, y: 50 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updatedNode);
  });

  it("should create node if not found (upsert behavior)", async () => {
    // First update returns empty (not found)
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    // Then insert creates it
    const createdNode = { id: "n-new", project_id: "p1", type: "OTHER" };
    mockDbQuery.mockResolvedValueOnce({ rows: [createdNode] });
    const app = createApp();
    const res = await request(app)
      .patch("/canvas/p1/nodes/n-new")
      .send({});
    expect(res.status).toBe(201);
    expect(res.body).toEqual(createdNode);
  });
});

// ============================================================================
// DELETE /:projectId/nodes/:nodeId
// ============================================================================
describe("DELETE /canvas/:projectId/nodes/:nodeId", () => {
  it("should delete a node and its connected edges", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1 }) // delete node
      .mockResolvedValueOnce({ rowCount: 2 }); // delete connected edges
    const app = createApp();
    const res = await request(app).delete("/canvas/p1/nodes/n1");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// POST /:projectId/edges
// ============================================================================
describe("POST /canvas/:projectId/edges", () => {
  it("should create a new edge", async () => {
    const createdEdge = { id: "test-uuid-1234", source: "n1", target: "n2" };
    mockDbQuery.mockResolvedValueOnce({ rows: [createdEdge] });
    const app = createApp();
    const res = await request(app)
      .post("/canvas/p1/edges")
      .send({ source: "n1", target: "n2" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(createdEdge);
  });
});

// ============================================================================
// DELETE /:projectId/edges/:edgeId
// ============================================================================
describe("DELETE /canvas/:projectId/edges/:edgeId", () => {
  it("should delete an edge", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1 });
    const app = createApp();
    const res = await request(app).delete("/canvas/p1/edges/e1");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

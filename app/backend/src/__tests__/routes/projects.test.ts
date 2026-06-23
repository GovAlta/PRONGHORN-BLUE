/**
 * Unit tests for the projects routes
 */
import express from "express";
import "express-async-errors";
import request from "supertest";
import projectsRouter from "../../routes/projects";
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

// Fake auth middleware to inject user
function fakeAuth(userId?: string) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (userId) {
      req.user = { id: userId, email: "test@test.com" };
    }
    next();
  };
}

function createApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use(fakeAuth(userId));
  app.use("/projects", projectsRouter);
  app.use(errorHandler);
  return app;
}

describe("GET /projects", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  it("returns empty array when user is not authenticated", async () => {
    const res = await request(createApp()).get("/projects");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns projects for the authenticated user", async () => {
    const projects = [
      { id: "p1", name: "Alpha", updated_at: "2025-01-02T00:00:00Z" },
      { id: "p2", name: "Beta", updated_at: "2025-01-01T00:00:00Z" },
    ];
    mockDbQuery.mockResolvedValue({ rows: projects });

    const res = await request(createApp("user-1")).get("/projects");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Should be sorted by updated_at descending
    expect(res.body[0].name).toBe("Alpha");
    expect(res.body[1].name).toBe("Beta");
  });
});

describe("GET /projects/:id", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  it("returns a project when found", async () => {
    const project = { id: "p1", name: "Test Project" };
    mockDbQuery.mockResolvedValue({ rows: [project] });

    const res = await request(createApp("user-1")).get("/projects/p1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(project);
  });

  it("returns 404 when project is not found", async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });

    const res = await request(createApp("user-1")).get("/projects/nonexistent");

    expect(res.status).toBe(404);
  });
});

describe("POST /projects", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  it("creates a new project and returns 201", async () => {
    const created = { id: "test-uuid-1234", name: "New Project", status: "DESIGN" };
    mockDbQuery.mockResolvedValue({ rows: [created] });

    const res = await request(createApp("user-1"))
      .post("/projects")
      .send({ name: "New Project" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("New Project");
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO projects"),
      expect.arrayContaining(["test-uuid-1234", "New Project"]),
    );
  });

  it("returns 400 when project name is missing", async () => {
    const res = await request(createApp("user-1"))
      .post("/projects")
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("PATCH /projects/:id", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  it("updates a project and returns the updated record", async () => {
    const updated = { id: "p1", name: "Updated Name" };
    mockDbQuery.mockResolvedValue({ rows: [updated] });

    const res = await request(createApp("user-1"))
      .patch("/projects/p1")
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Name");
  });

  it("returns 400 when no valid fields are provided", async () => {
    const res = await request(createApp("user-1"))
      .patch("/projects/p1")
      .send({ invalid_field: "value" });

    expect(res.status).toBe(400);
  });

  it("returns 404 when the project does not exist or does not belong to user", async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });

    const res = await request(createApp("user-1"))
      .patch("/projects/nonexistent")
      .send({ name: "X" });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /projects/:id", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  it("deletes a project and returns 204", async () => {
    mockDbQuery.mockResolvedValue({ rowCount: 1 });

    const res = await request(createApp("user-1")).delete("/projects/p1");

    expect(res.status).toBe(204);
  });

  it("returns 404 when the project does not exist", async () => {
    mockDbQuery.mockResolvedValue({ rowCount: 0 });

    const res = await request(createApp("user-1")).delete("/projects/nonexistent");

    expect(res.status).toBe(404);
  });
});

describe("POST /projects/:id/clone", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  it("clones a project and returns 201", async () => {
    const source = { id: "p1", name: "Original", description: "desc", org_id: null, organization: null, budget: null, scope: null };
    const cloned = { id: "test-uuid-1234", name: "My Clone" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [source] }) // SELECT source project
      .mockResolvedValueOnce({ rows: [cloned] }); // INSERT clone

    const res = await request(createApp("user-1"))
      .post("/projects/p1/clone")
      .send({ name: "My Clone" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("My Clone");
  });

  it("returns 404 when source project does not exist", async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });

    const res = await request(createApp("user-1"))
      .post("/projects/nonexistent/clone")
      .send({ name: "Clone" });

    expect(res.status).toBe(404);
  });
});

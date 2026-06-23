/**
 * Unit tests for the health check routes
 */
import express from "express";
import request from "supertest";
import healthRouter from "../../routes/health";

// Mock the database module
jest.mock("../../utils/database", () => ({
  __esModule: true,
  default: {
    healthCheck: jest.fn(),
    getActiveDbPort: jest.fn(),
    getPoolForTarget: jest.fn(),
  },
}));

import db from "../../utils/database";

function createApp() {
  const app = express();
  app.use("/health", healthRouter);
  return app;
}

describe("GET /health", () => {
  it("returns healthy status with service metadata", async () => {
    (db.getActiveDbPort as jest.Mock).mockReturnValue(5432);

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: "healthy",
        service: "pronghorn-api",
        database: { activePort: 5432 },
      }),
    );
    expect(res.body).toHaveProperty("timestamp");
  });

  it("returns null activePort when no db connection yet", async () => {
    (db.getActiveDbPort as jest.Mock).mockReturnValue(null);

    const res = await request(createApp()).get("/health");
    expect(res.body.database.activePort).toBeNull();
  });
});

describe("GET /health/detailed", () => {
  const mockGenappsPool = { query: jest.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }) };

  beforeEach(() => {
    (db.getPoolForTarget as jest.Mock).mockResolvedValue(mockGenappsPool);
    mockGenappsPool.query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
  });

  it("returns 200 with healthy checks when db is healthy", async () => {
    (db.healthCheck as jest.Mock).mockResolvedValue(true);
    (db.getActiveDbPort as jest.Mock).mockReturnValue(5432);

    const res = await request(createApp()).get("/health/detailed");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.checks.database.status).toBe("healthy");
    expect(res.body.checks.database.activePort).toBe(5432);
  });

  it("returns 503 when db health check returns false", async () => {
    (db.healthCheck as jest.Mock).mockResolvedValue(false);
    (db.getActiveDbPort as jest.Mock).mockReturnValue(5432);

    const res = await request(createApp()).get("/health/detailed");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.checks.database.status).toBe("unhealthy");
  });

  it("returns 503 with error when db health check throws", async () => {
    (db.healthCheck as jest.Mock).mockRejectedValue(new Error("connection refused"));
    (db.getActiveDbPort as jest.Mock).mockReturnValue(null);

    const res = await request(createApp()).get("/health/detailed");

    expect(res.status).toBe(503);
    expect(res.body.checks.database.error).toBe("connection refused");
  });

  it("includes latency in database check", async () => {
    (db.healthCheck as jest.Mock).mockResolvedValue(true);
    (db.getActiveDbPort as jest.Mock).mockReturnValue(5432);

    const res = await request(createApp()).get("/health/detailed");

    expect(typeof res.body.checks.database.latency).toBe("number");
    expect(res.body.checks.database.latency).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /health/ready", () => {
  it("returns ready true when db is healthy", async () => {
    (db.healthCheck as jest.Mock).mockResolvedValue(true);
    (db.getActiveDbPort as jest.Mock).mockReturnValue(5432);

    const res = await request(createApp()).get("/health/ready");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ ready: true, database: { activePort: 5432 } }),
    );
  });

  it("returns 503 when db is not healthy", async () => {
    (db.healthCheck as jest.Mock).mockResolvedValue(false);
    (db.getActiveDbPort as jest.Mock).mockReturnValue(5433);

    const res = await request(createApp()).get("/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.reason).toBe("Database not ready");
  });

  it("returns 503 with error message when db check throws", async () => {
    (db.healthCheck as jest.Mock).mockRejectedValue(new Error("timeout"));
    (db.getActiveDbPort as jest.Mock).mockReturnValue(null);

    const res = await request(createApp()).get("/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.reason).toBe("timeout");
  });
});

describe("GET /health/live", () => {
  it("always returns 200 with alive=true", async () => {
    const res = await request(createApp()).get("/health/live");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ alive: true });
  });
});

/**
 * Unit tests for the collaboration routes
 */
import express from "express";
import "express-async-errors";
import request from "supertest";
import collaborationRouter from "../../routes/collaboration";
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

function fakeAuth(userId: string) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: userId, email: "test@test.com" };
    next();
  };
}

function createApp(userId = "user-1") {
  const app = express();
  app.use(express.json());
  app.use(fakeAuth(userId));
  app.use("/collab", collaborationRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /collab/:projectId/sessions", () => {
  it("should return active sessions for a project", async () => {
    const sessions = [{ id: "s1", status: "active" }];
    mockDbQuery.mockResolvedValueOnce({ rows: sessions });
    const res = await request(createApp()).get("/collab/p1/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sessions);
  });
});

describe("POST /collab/:projectId/join", () => {
  it("should join an existing active session", async () => {
    const session = { id: "s1", project_id: "p1", status: "active" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [session] }) // find session
      .mockResolvedValueOnce({ rows: [] }); // add participant
    const res = await request(createApp()).post("/collab/p1/join");
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe("s1");
    expect(res.body.userId).toBe("user-1");
  });

  it("should create a new session when none exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] }) // no active session
      .mockResolvedValueOnce({ rows: [{ id: "test-uuid-1234", status: "active" }] }) // create
      .mockResolvedValueOnce({ rows: [] }); // add participant
    const res = await request(createApp()).post("/collab/p1/join");
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe("test-uuid-1234");
  });
});

describe("POST /collab/:projectId/leave", () => {
  it("should remove participant and return 204", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp()).post("/collab/p1/leave");
    expect(res.status).toBe(204);
  });
});

describe("GET /collab/:projectId/participants", () => {
  it("should return active participants", async () => {
    const participants = [{ id: "user-1", email: "test@test.com", name: "Test" }];
    mockDbQuery.mockResolvedValueOnce({ rows: participants });
    const res = await request(createApp()).get("/collab/p1/participants");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(participants);
  });
});

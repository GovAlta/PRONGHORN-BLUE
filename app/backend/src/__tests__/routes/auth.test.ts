/**
 * Unit tests for the auth routes
 */
import express from "express";
import "express-async-errors";
import request from "supertest";
import authRouter from "../../routes/auth";
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

// Mock jsonwebtoken
const mockSign = jest.fn().mockReturnValue("mock-jwt-token");
const mockVerify = jest.fn();
jest.mock("jsonwebtoken", () => ({
  sign: (...args: any[]) => mockSign(...args),
  verify: (...args: any[]) => mockVerify(...args),
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
  app.use("/auth", authRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockReset();
  process.env.JWT_SECRET = "test-secret";
});

afterEach(() => {
  delete process.env.JWT_SECRET;
});

// ============================================================================
// POST /auth/signup
// ============================================================================
describe("POST /auth/signup", () => {
  it("should return 400 when email is missing", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/auth/signup")
      .send({ password: "password123" });
    expect(res.status).toBe(400);
  });

  it("should return 400 when password is missing", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/auth/signup")
      .send({ email: "test@test.com" });
    expect(res.status).toBe(400);
  });

  it("should return 409 when email already exists", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: "existing-id" }] });
    const app = createApp();
    const res = await request(app)
      .post("/auth/signup")
      .send({ email: "existing@test.com", password: "password123" });
    expect(res.status).toBe(409);
  });

  it("should create user and return token on success", async () => {
    // First query: check existing user (none found)
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    // Second query: insert user
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: "new-user-id", email: "new@test.com", name: "new", role: "user" }],
    });

    const app = createApp();
    const res = await request(app)
      .post("/auth/signup")
      .send({ email: "new@test.com", password: "password123", name: "Test User" });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
  });
});

// ============================================================================
// POST /auth/login
// ============================================================================
describe("POST /auth/login", () => {
  it("should return 400 when email is missing", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/auth/login")
      .send({ password: "password123" });
    expect(res.status).toBe(400);
  });

  it("should return 401 when user not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const app = createApp();
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "nouser@test.com", password: "password123" });
    expect(res.status).toBe(401);
  });

  it("should return 401 when password is wrong", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: "user-1", email: "test@test.com", encrypted_password: "wrong-hash", role: "user" }],
    });
    const app = createApp();
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "test@test.com", password: "badpassword" });
    expect(res.status).toBe(401);
  });

  it("should return token on valid credentials", async () => {
    // hashPassword('correct') using sha256
    const crypto = require("crypto");
    const validHash = crypto.createHash("sha256").update("correct").digest("hex");

    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: "user-1",
        email: "test@test.com",
        encrypted_password: validHash,
        name: "Test",
        role: "user",
      }],
    });

    const app = createApp();
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "test@test.com", password: "correct" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
  });
});

// ============================================================================
// POST /auth/refresh
// ============================================================================
describe("POST /auth/refresh", () => {
  it("should return 401 when no Authorization header is provided", async () => {
    const app = createApp();
    const res = await request(app).post("/auth/refresh").send({});
    expect(res.status).toBe(401);
  });

  it("should return 401 when token is invalid", async () => {
    mockVerify.mockImplementation(() => {
      throw new Error("invalid token");
    });
    const app = createApp();
    const res = await request(app)
      .post("/auth/refresh")
      .set("Authorization", "Bearer invalid-token");
    expect(res.status).toBe(401);
  });

  it("should return 401 when user no longer exists", async () => {
    mockVerify.mockReturnValue({ sub: "deleted-user" });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const app = createApp();
    const res = await request(app)
      .post("/auth/refresh")
      .set("Authorization", "Bearer old-token");
    expect(res.status).toBe(401);
  });

  it("should return new token on valid refresh", async () => {
    mockVerify.mockReturnValue({ sub: "user-1" });
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: "user-1", email: "test@test.com", name: "Test", role: "user" }],
    });
    const app = createApp();
    const res = await request(app)
      .post("/auth/refresh")
      .set("Authorization", "Bearer valid-token");
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });
});

// ============================================================================
// POST /auth/logout
// ============================================================================
describe("POST /auth/logout", () => {
  it("should return success message", async () => {
    const app = createApp();
    const res = await request(app).post("/auth/logout");
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/logged out/i);
  });
});

// ============================================================================
// POST /auth/reset-password
// ============================================================================
describe("POST /auth/reset-password", () => {
  it("should return 400 when email is missing", async () => {
    const app = createApp();
    const res = await request(app).post("/auth/reset-password").send({});
    expect(res.status).toBe(400);
  });

  it("should return success even when user does not exist (prevents email enumeration)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const app = createApp();
    const res = await request(app)
      .post("/auth/reset-password")
      .send({ email: "nonexistent@test.com" });
    expect(res.status).toBe(200);
  });

  it("should return success and store reset token when user exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "user-1", email: "test@test.com" }] })
      .mockResolvedValueOnce({ rows: [] }) // DELETE old tokens
      .mockResolvedValueOnce({ rows: [] }) // INSERT new token
      .mockResolvedValueOnce({ rows: [] }); // UPDATE recovery_token
    const app = createApp();
    const res = await request(app)
      .post("/auth/reset-password")
      .send({ email: "test@test.com" });
    expect(res.status).toBe(200);
    // Verify that DB queries were made to store token
    expect(mockDbQuery).toHaveBeenCalledTimes(4);
  });
});

// ============================================================================
// POST /auth/update-password
// ============================================================================
describe("POST /auth/update-password", () => {
  it("should return 400 when token or password is missing", async () => {
    const app = createApp();
    const res = await request(app).post("/auth/update-password").send({ token: "abc" });
    expect(res.status).toBe(400);
  });

  it("should return 400 when reset token is invalid", async () => {
    // First query: check one_time_tokens (not found)
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    // Second query: check auth.users recovery_token (not found)
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const app = createApp();
    const res = await request(app)
      .post("/auth/update-password")
      .send({ token: "invalid", password: "newpass" });
    expect(res.status).toBe(400);
  });

  it("should update password when token is valid via one_time_tokens", async () => {
    // Find token in one_time_tokens
    mockDbQuery.mockResolvedValueOnce({ rows: [{ user_id: "user-1" }] });
    // UPDATE password
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    // DELETE used token
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const app = createApp();
    const res = await request(app)
      .post("/auth/update-password")
      .send({ token: "valid-token", password: "newpassword" });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/updated/i);
  });

  it("should update password when token is valid via recovery_token fallback", async () => {
    // one_time_tokens: not found
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    // auth.users recovery_token: found
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: "user-1" }] });
    // UPDATE password
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    // DELETE used token
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const app = createApp();
    const res = await request(app)
      .post("/auth/update-password")
      .send({ token: "recovery-token", password: "newpassword" });
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// GET /auth/oauth/google
// ============================================================================
describe("GET /auth/oauth/google", () => {
  it("should return 500 when Google OAuth is not configured", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const app = createApp();
    const res = await request(app).get("/auth/oauth/google");
    expect(res.status).toBe(500);
  });
});

// ============================================================================
// GET /auth/oauth/azure
// ============================================================================
describe("GET /auth/oauth/azure", () => {
  it("should return 500 when Azure AD OAuth is not configured", async () => {
    delete process.env.AZURE_AD_CLIENT_ID;
    const app = createApp();
    const res = await request(app).get("/auth/oauth/azure");
    expect(res.status).toBe(500);
  });
});

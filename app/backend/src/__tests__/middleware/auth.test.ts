/**
 * Unit tests for the authentication middleware
 */
import { Request, Response, NextFunction } from "express";
import { authMiddleware, optionalAuthMiddleware, requireRole } from "../../middleware/auth";

// Suppress logger output during tests
jest.mock("../../utils/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock jwks-rsa so we don't hit the network
jest.mock("jwks-rsa", () => {
  return jest.fn().mockReturnValue({
    getSigningKey: jest.fn(),
  });
});

// Mock jsonwebtoken so verify can be controlled per-test
jest.mock("jsonwebtoken", () => {
  const original = jest.requireActual("jsonwebtoken");
  return {
    ...original,
    verify: jest.fn(),
  };
});

// Mock the database module so the Azure AD success path's auth.users seed
// does not try to open a real PostgreSQL connection during tests.
jest.mock("../../utils/database", () => ({
  __esModule: true,
  default: {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  },
}));

import jwt from "jsonwebtoken";

function mockReqRes(headers: Record<string, string> = {}) {
  const req = {
    headers: { ...headers },
    user: undefined,
  } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next: NextFunction = jest.fn();
  return { req, res, next };
}

// Flush the JS task + microtask queues so async seed work (chained awaits +
// `.finally(() => next())`) completes before assertions run.
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("authMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("authenticates via APIM headers when X-User-Id and X-User-Email are present", async () => {
    const { req, res, next } = mockReqRes({
      "x-user-id": "user-123",
      "x-user-email": "alice@example.com",
      "x-user-name": "Alice",
    });

    authMiddleware(req, res, next);
    // Seed runs before next(); wait a microtask for the .finally(...) to fire.
    await flushAsync();

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({
      id: "user-123",
      email: "alice@example.com",
      name: "Alice",
    });
  });

  it("derives name from email when X-User-Name is absent", async () => {
    const { req, res, next } = mockReqRes({
      "x-user-id": "user-123",
      "x-user-email": "bob@contoso.com",
    });

    authMiddleware(req, res, next);
    await flushAsync();

    expect(req.user?.name).toBe("bob");
  });

  it("returns 401 when no auth headers and no Authorization header", () => {
    const { req, res, next } = mockReqRes({});

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Unauthorized", message: "No authorization header provided" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is malformed", () => {
    const { req, res, next } = mockReqRes({ authorization: "Basic abc" });

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Invalid authorization header format") }),
    );
  });

  it("returns 401 when Bearer token is missing", () => {
    const { req, res, next } = mockReqRes({ authorization: "Bearer " });

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("falls back to local JWT_SECRET when Azure AD validation fails", () => {
    const secret = "test-secret-key-for-unit-tests";
    process.env.JWT_SECRET = secret;

    // Make jwt.verify call Azure AD callback with error, then succeed on local
    (jwt.verify as jest.Mock).mockImplementation((
      _token: string,
      _secretOrKey: unknown,
      options: unknown,
      callback?: (err: Error | null, decoded: unknown) => void,
    ): unknown => {
      if (typeof options === "object" && callback) {
        // Azure AD path — simulate failure
        callback(new Error("Azure AD fail"), null);
        return undefined;
      }
      // Local path (no callback) — return decoded payload
      return { sub: "local-user", email: "local@test.com", name: "Local" };
    });

    const { req, res, next } = mockReqRes({ authorization: "Bearer some-jwt" });

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual(
      expect.objectContaining({ id: "local-user", email: "local@test.com" }),
    );

    delete process.env.JWT_SECRET;
  });

  it("sets user from Azure AD token on successful Azure AD verification", async () => {
    (jwt.verify as jest.Mock).mockImplementation((_token, _key, _opts, callback) => {
      if (callback) {
        callback(null, { oid: "azure-oid", email: "az@test.com", name: "Azure User" });
      }
    });

    const { req, res, next } = mockReqRes({ authorization: "Bearer azure-token" });

    authMiddleware(req, res, next);
    // Seed runs before next(); wait a microtask for the .finally(...) to fire.
    await flushAsync();

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual(
      expect.objectContaining({ id: "azure-oid", email: "az@test.com", name: "Azure User" }),
    );
  });

  it("returns 500 when an unexpected exception is thrown", () => {
    // Force a throw before any auth logic
    const { req, res, next } = mockReqRes({});
    Object.defineProperty(req, "headers", {
      get() { throw new Error("kaboom"); },
    });

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Internal Server Error" }),
    );
  });

  it("seeds auth.users from APIM headers on the first request for a new user", async () => {
    const dbModule = jest.requireMock("../../utils/database") as {
      default: { query: jest.Mock };
    };
    dbModule.default.query.mockClear();
    dbModule.default.query.mockResolvedValue({ rows: [{ id: "new-apim-user" }], rowCount: 1 });

    const { req, res, next } = mockReqRes({
      "x-user-id": "new-apim-user",
      "x-user-email": "new@example.com",
      "x-user-name": "New User",
    });

    authMiddleware(req, res, next);
    await flushAsync();

    expect(next).toHaveBeenCalled();
    // First call: INSERT into auth.users; second call: INSERT into public.user_roles
    expect(dbModule.default.query).toHaveBeenCalledTimes(2);
    const insertUsersCall = dbModule.default.query.mock.calls[0];
    expect(insertUsersCall[0]).toMatch(/INSERT INTO auth\.users/);
    expect(insertUsersCall[1]).toEqual([
      "new-apim-user",
      "new@example.com",
      expect.any(String),
    ]);
    const insertRolesCall = dbModule.default.query.mock.calls[1];
    expect(insertRolesCall[0]).toMatch(/INSERT INTO public\.user_roles/);
    expect(insertRolesCall[1]).toEqual(["new-apim-user"]);
  });
});

describe("optionalAuthMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("attaches user when APIM headers are present", async () => {
    const { req, res, next } = mockReqRes({
      "x-user-id": "user-opt",
      "x-user-email": "opt@test.com",
    });

    optionalAuthMiddleware(req, res, next);
    await flushAsync();

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user?.email).toBe("opt@test.com");
  });

  it("continues without user when no auth is provided", () => {
    const { req, res, next } = mockReqRes({});

    optionalAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it("continues without user when Authorization header is malformed", () => {
    const { req, res, next } = mockReqRes({ authorization: "Basic abc" });

    optionalAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it("continues without user when token verification fails", () => {
    (jwt.verify as jest.Mock).mockImplementation((_token, _key, _opts, callback) => {
      if (callback) {
        callback(new Error("invalid"), null);
      }
    });

    const { req, res, next } = mockReqRes({ authorization: "Bearer bad-token" });

    optionalAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });
});

describe("requireRole middleware factory", () => {
  it("returns 401 when req.user is not set", () => {
    const middleware = requireRole("admin");
    const { req, res, next } = mockReqRes({});

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when user role is not in the allowed list", () => {
    const middleware = requireRole("admin");
    const { req, res, next } = mockReqRes({});
    req.user = { id: "1", email: "u@test.com", role: "viewer" };

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next when user role matches", () => {
    const middleware = requireRole("admin", "editor");
    const { req, res, next } = mockReqRes({});
    req.user = { id: "1", email: "u@test.com", role: "editor" };

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

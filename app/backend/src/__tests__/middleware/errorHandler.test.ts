/**
 * Unit tests for the error handler middleware and error factories
 */
import { Request, Response, NextFunction } from "express";
import { errorHandler, createError, Errors } from "../../middleware/errorHandler";

// Suppress logger output during tests
jest.mock("../../utils/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

function mockReqRes() {
  const req = { path: "/test", method: "GET" } as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next: NextFunction = jest.fn();
  return { req, res, next };
}

describe("errorHandler middleware", () => {
  it("returns 500 when no statusCode is set on the error", () => {
    const { req, res, next } = mockReqRes();
    const err = new Error("something broke");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "something broke" }),
    );
  });

  it("uses the statusCode from the error when present", () => {
    const { req, res, next } = mockReqRes();
    const err = createError(422, "Validation failed", "VALIDATION_ERROR");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Validation failed", code: "VALIDATION_ERROR" }),
    );
  });

  it("includes stack trace in non-production environments", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const { req, res, next } = mockReqRes();
    const err = createError(400, "bad");

    errorHandler(err, req, res, next);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body).toHaveProperty("stack");

    process.env.NODE_ENV = originalEnv;
  });

  it("omits stack trace in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const { req, res, next } = mockReqRes();
    const err = createError(400, "bad");

    errorHandler(err, req, res, next);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body).not.toHaveProperty("stack");

    process.env.NODE_ENV = originalEnv;
  });

  it("includes details when the error carries them", () => {
    const { req, res, next } = mockReqRes();
    const details = { field: "email", issue: "required" };
    const err = createError(422, "Validation failed", "VALIDATION_ERROR", details);

    errorHandler(err, req, res, next);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.details).toEqual(details);
  });
});

describe("createError", () => {
  it("creates an Error with the expected properties", () => {
    const err = createError(404, "Not found", "NOT_FOUND", { id: "1" });
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Not found");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.details).toEqual({ id: "1" });
  });
});

describe("Errors factory helpers", () => {
  it.each([
    ["badRequest", 400, "BAD_REQUEST"],
    ["unauthorized", 401, "UNAUTHORIZED"],
    ["forbidden", 403, "FORBIDDEN"],
    ["notFound", 404, "NOT_FOUND"],
    ["conflict", 409, "CONFLICT"],
    ["validation", 422, "VALIDATION_ERROR"],
    ["internal", 500, "INTERNAL_ERROR"],
    ["serviceUnavailable", 503, "SERVICE_UNAVAILABLE"],
  ] as const)("%s returns status %i with code %s", (factory, expectedStatus, expectedCode) => {
    const arg = factory === "validation" ? { field: "x" } : "test message";
    const err = (Errors as any)[factory](arg);
    expect(err.statusCode).toBe(expectedStatus);
    expect(err.code).toBe(expectedCode);
  });

  it("notFound includes resource name in message", () => {
    const err = Errors.notFound("Widget");
    expect(err.message).toBe("Widget not found");
  });

  it("unauthorized / forbidden / internal / serviceUnavailable use defaults when called without message", () => {
    expect(Errors.unauthorized().message).toBe("Unauthorized");
    expect(Errors.forbidden().message).toBe("Forbidden");
    expect(Errors.internal().message).toBe("Internal server error");
    expect(Errors.serviceUnavailable().message).toBe("Service temporarily unavailable");
  });
});

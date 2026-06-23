/**
 * Global Error Handler Middleware
 */
import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";

interface ApiError extends Error {
  statusCode?: number;
  code?: string;
  details?: any;
}

/**
 * Central error handling middleware
 */
export function errorHandler(err: ApiError, req: Request, res: Response, _next: NextFunction): void {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  logger.error(`Error ${statusCode}: ${message}`, {
    path: req.path,
    method: req.method,
    stack: err.stack,
    details: err.details,
  });

  res.status(statusCode).json({
    error: err.name || "Error",
    message,
    code: err.code,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    ...(err.details && { details: err.details }),
  });
}

/**
 * Create a custom API error
 */
export function createError(statusCode: number, message: string, code?: string, details?: any): ApiError {
  const error: ApiError = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

/**
 * Common error factories
 */
export const Errors = {
  badRequest: (message: string, details?: any) => createError(400, message, "BAD_REQUEST", details),
  unauthorized: (message = "Unauthorized") => createError(401, message, "UNAUTHORIZED"),
  forbidden: (message = "Forbidden") => createError(403, message, "FORBIDDEN"),
  notFound: (resource = "Resource") => createError(404, `${resource} not found`, "NOT_FOUND"),
  conflict: (message: string) => createError(409, message, "CONFLICT"),
  validation: (details: any) => createError(422, "Validation failed", "VALIDATION_ERROR", details),
  internal: (message = "Internal server error") => createError(500, message, "INTERNAL_ERROR"),
  serviceUnavailable: (message = "Service temporarily unavailable") => createError(503, message, "SERVICE_UNAVAILABLE"),
};

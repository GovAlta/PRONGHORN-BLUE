/**
 * Rate limiting middleware
 *
 * Centralized express-rate-limit configurations to protect the API from
 * brute-force and denial-of-service abuse. A broad limiter is applied to all
 * API traffic, while sensitive authentication endpoints use a stricter limiter.
 *
 * Limits can be tuned via environment variables without code changes.
 */
import rateLimit, { Options } from "express-rate-limit";

/**
 * Parse a positive integer from an environment variable, falling back to a
 * default when the value is missing or invalid.
 * @param value - Raw environment variable value.
 * @param fallback - Default to use when value is absent or non-numeric.
 * @returns A positive integer.
 */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const STANDARD_WINDOW_MS = parsePositiveInt(
  process.env.RATE_LIMIT_WINDOW_MS,
  15 * 60 * 1000, // 15 minutes
);
const STANDARD_MAX = parsePositiveInt(process.env.RATE_LIMIT_MAX, 1000);
const AUTH_MAX = parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 20);
const HEALTH_WINDOW_MS = parsePositiveInt(
  process.env.HEALTH_RATE_LIMIT_WINDOW_MS,
  60 * 1000, // 1 minute
);
const HEALTH_MAX = parsePositiveInt(process.env.HEALTH_RATE_LIMIT_MAX, 600);

const sharedOptions: Partial<Options> = {
  windowMs: STANDARD_WINDOW_MS,
  standardHeaders: true, // RateLimit-* headers
  legacyHeaders: false, // disable deprecated X-RateLimit-* headers
  message: { error: "Too many requests, please try again later." },
};

/**
 * Broad limiter for general API traffic.
 * @example app.use('/api', apiRateLimiter);
 */
export const apiRateLimiter = rateLimit({
  ...sharedOptions,
  max: STANDARD_MAX,
});

/**
 * Strict limiter for authentication endpoints (login, signup, password reset)
 * to mitigate credential brute-forcing.
 * @example router.use('/auth', authRateLimiter, authRouter);
 */
export const authRateLimiter = rateLimit({
  ...sharedOptions,
  max: AUTH_MAX,
  message: {
    error: "Too many authentication attempts, please try again later.",
  },
});

/**
 * Lenient limiter for health/monitoring endpoints. Generous enough that
 * container liveness/readiness probes are never throttled, while still bounding
 * abuse of the dependency-checking (`/detailed`) endpoint, which performs
 * database round-trips. Mounted on the non-versioned `/health` and
 * `/api/health` paths (the `/api/v1` mount is already covered by
 * {@link apiRateLimiter}).
 *
 * @example app.use('/health', healthRateLimiter, healthRouter);
 */
export const healthRateLimiter = rateLimit({
  ...sharedOptions,
  windowMs: HEALTH_WINDOW_MS,
  max: HEALTH_MAX,
});

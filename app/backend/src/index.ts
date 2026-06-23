/**
 * Pronghorn API Server
 *
 * Azure Container Apps backend
 * Provides REST API endpoints for all application functionality
 *
 * API Versioning: /api/v1/...
 * OpenAPI/Swagger: /api-docs
 */

// Load environment variables FIRST — before any code that reads process.env
// (dispatcher config needs HTTPS_PROXY, database.ts needs POSTGRES_*, etc.)
import { config } from "dotenv";
config();

// =============================================================================
// Network Dispatcher Configuration
// Production (ACA): Override DNS to use Azure DNS (168.63.129.16) for private
//   endpoint resolution — ACA's default DNS (127.0.0.11) can't resolve them.
// Local dev: Use Node.js default networking (no custom dispatcher).
// This MUST run before any fetch() calls.
// =============================================================================
import { setGlobalDispatcher, Agent } from "undici";
import { Resolver } from "dns/promises";
import dns from "dns";

const isProduction = process.env.NODE_ENV === "production";

if (isProduction) {
  // Azure Container Apps needs custom DNS for private endpoint resolution
  const azureDns = new Resolver();
  azureDns.setServers(["168.63.129.16"]);

  setGlobalDispatcher(
    new Agent({
      connect: {
        lookup: ((
          hostname: string,
          options: dns.LookupOptions,
          callback: (...args: unknown[]) => void,
        ) => {
          azureDns
            .resolve4(hostname)
            .then((addresses) => {
              if (options.all) {
                // undici 7.x passes all:true — callback expects an array of {address, family}
                callback(
                  null,
                  addresses.map((a) => ({ address: a, family: 4 })),
                );
              } else {
                callback(null, addresses[0], 4);
              }
            })
            .catch(() => {
              // Fall back to default DNS for non-private hostnames
              dns.lookup(hostname, options, callback as any);
            });
        }) as unknown as typeof dns.lookup,
      },
    }),
  );
}

import "express-async-errors";

import { runMigrations } from "./migrate";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { logger } from "./utils/logger";
import { errorHandler } from "./middleware/errorHandler";
import { apiRateLimiter, healthRateLimiter } from "./middleware/rateLimit";
import { swaggerSpec, getOpenApiSpec } from "./swagger";
import { initWebSocket, getWsStats } from "./websocket";
import { initRepoBlobStore } from "./utils/repoBlobStore";
import {
  startDockerDeploymentPoller,
  stopDockerDeploymentPoller,
} from "./services/deployment/docker/poller";

// Versioned route imports
import v1Router from "./routes/v1";

// Legacy route imports (for backward compatibility during migration)
import healthRouter from "./routes/health";
import migrateRouter from "./routes/migrate";

const app = express();
const PORT = process.env.PORT || 8080;

// ============================================================================
// Middleware
// ============================================================================

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      // Restrictive default policy suitable for a JSON API. The Swagger UI
      // route below sets its own relaxed policy so documentation still renders.
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
  "https://ca-pronghorn-frontend.orangeplant-ff11f103.canadacentral.azurecontainerapps.io",
  "https://pronghorn.blue",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://localhost:3000",
];
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, health checks)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
        return callback(null, origin);
      }
      // Unknown origin: respond without CORS headers so the browser blocks it.
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-client-info",
      "apikey",
      "ocp-apim-subscription-key",
    ],
    credentials: true,
  }),
);

// Body parsing
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });
  next();
});

// ============================================================================
// OpenAPI/Swagger Documentation
// ============================================================================

// Swagger UI - API documentation
app.use(
  "/api-docs",
  helmet({
    // Swagger UI requires inline scripts/styles to render; relax CSP here only.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
      },
    },
  }),
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "Pronghorn API Documentation",
  }),
);

// OpenAPI spec endpoint (for APIM import)
app.get("/api/openapi.json", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.json(getOpenApiSpec());
});

// ============================================================================
// Routes
// ============================================================================

// Health check (no auth required) - available at root for container probes
app.use("/health", healthRateLimiter, healthRouter);

// API v1 Routes (versioned)
app.use("/api/v1", apiRateLimiter, v1Router);

// Legacy routes (redirect to v1 for backward compatibility)
app.use("/api/health", healthRateLimiter, healthRouter);

// Migration routes (requires admin API key)
app.use("/api/migrate", migrateRouter);

// Catch-all for undefined routes
app.use("*", (req: Request, res: Response) => {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

// ============================================================================
// Error Handling
// ============================================================================

app.use(errorHandler);

// ============================================================================
// Server Startup
// ============================================================================

export async function startServer() {
  initRepoBlobStore();

  // Run database migrations before accepting traffic (controlled by RUN_MIGRATIONS_ON_STARTUP env var)
  const runMigrationsFlag = (
    process.env.RUN_MIGRATIONS_ON_STARTUP || "true"
  ).toLowerCase();
  if (runMigrationsFlag === "true" || runMigrationsFlag === "1") {
    try {
      await runMigrations();
    } catch (err) {
      // Migration failed: the runner has already logged the exact file +
      // SQLSTATE and recorded a `failed` status (surfaced via /health/detailed).
      // We still start the server so the failure is observable rather than the
      // container silently crash-looping, but the schema is known-degraded.
      logger.error(
        "Database migrations failed — server starting with degraded schema (see /health/detailed)",
        { error: (err as Error).message },
      );
    }
  } else {
    logger.info(
      "Database migrations skipped (RUN_MIGRATIONS_ON_STARTUP=false)",
    );
  }

  const server = app.listen(PORT, () => {
    logger.info(`🚀 Pronghorn API Server running on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || "development"}`);
  });

  // Attach WebSocket server to the same HTTP server
  const wss = initWebSocket(server);
  logger.info("WebSocket server attached to HTTP server on /ws path");

  // WebSocket health endpoint (direct access, not through APIM)
  app.get("/ws/health", (_req, res) => {
    res.json({ status: "ok", ...getWsStats() });
  });

  // Background poller for Docker-archetype deployments (US1).
  // Skipped under NODE_ENV=test so unit tests don't spawn a real interval.
  if (process.env.NODE_ENV !== "test") {
    startDockerDeploymentPoller();
  }

  // Graceful shutdown
  function gracefulShutdown(signal: string) {
    logger.info(`${signal} received. Shutting down gracefully...`);
    stopDockerDeploymentPoller();
    wss?.close();
    server.close(() => {
      logger.info("Process terminated");
      process.exit(0);
    });
    // Force exit if server hasn't closed in 5 seconds
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  // nodemon sends SIGUSR2 on restart
  process.once("SIGUSR2", () => {
    logger.info("SIGUSR2 received (nodemon restart). Shutting down...");
    wss?.close();
    server.close(() => {
      process.kill(process.pid, "SIGUSR2");
    });
    setTimeout(() => process.kill(process.pid, "SIGUSR2"), 5000).unref();
  });

  return server;
}

if (require.main === module) {
  startServer();
}

export default app;

/**
 * Health Check Routes
 * @swagger
 * tags:
 *   name: Health
 *   description: Health check and monitoring endpoints
 */
import { Router, Request, Response } from "express";
import db from "../utils/database";
import { getMigrationStatus } from "../migrate";

const router = Router();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Basic health check
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthCheck'
 */
router.get("/", (_req: Request, res: Response) => {
  const activeDatabasePort = db.getActiveDbPort();

  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "pronghorn-api",
    version: process.env.npm_package_version || "1.0.0",
    database: {
      activePort: activeDatabasePort,
    },
  });
});

/**
 * @swagger
 * /health/detailed:
 *   get:
 *     summary: Detailed health check with dependency status
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: All services healthy
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/HealthCheck'
 *                 - type: object
 *                   properties:
 *                     checks:
 *                       type: object
 *       503:
 *         description: One or more services degraded
 */
router.get("/detailed", async (_req: Request, res: Response) => {
  const checks: Record<
    string,
    { status: string; latency: number; error?: string; activePort?: number }
  > = {};

  // Database check
  const dbStart = Date.now();
  try {
    const dbHealthy = await db.healthCheck();
    checks.database = {
      status: dbHealthy ? "healthy" : "unhealthy",
      latency: Date.now() - dbStart,
      activePort: db.getActiveDbPort() || undefined,
    };
  } catch (error) {
    checks.database = {
      status: "unhealthy",
      latency: Date.now() - dbStart,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }

  // Generated Applications database check
  const genappsStart = Date.now();
  try {
    const genappsPool = await db.getPoolForTarget({
      database: "postgres",
      server: "genapps",
    });
    await genappsPool.query("SELECT 1");
    checks.database_genapps = {
      status: "healthy",
      latency: Date.now() - genappsStart,
    };
  } catch (error) {
    checks.database_genapps = {
      status: "unhealthy",
      latency: Date.now() - genappsStart,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }

  // Schema migration status — surfaces a half-migrated or failed schema so
  // a bad startup migration is observable instead of silent.
  const migration = getMigrationStatus();
  checks.migrations = {
    status: migration.state === "failed" ? "unhealthy" : "healthy",
    latency: 0,
    error:
      migration.state === "failed" && migration.failed
        ? `${migration.failed.file} (${migration.failed.code ?? "?"}): ${migration.failed.message ?? "migration failed"}`
        : undefined,
  };

  // Overall status
  const allHealthy = Object.values(checks).every((c) => c.status === "healthy");

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    service: "pronghorn-api",
    version: process.env.npm_package_version || "1.0.0",
    checks,
  });
});

/**
 * @swagger
 * /health/ready:
 *   get:
 *     summary: Kubernetes readiness probe
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Service is ready
 *       503:
 *         description: Service not ready
 */
router.get("/ready", async (_req: Request, res: Response) => {
  try {
    const dbHealthy = await db.healthCheck();
    const activeDatabasePort = db.getActiveDbPort();

    if (dbHealthy) {
      res.status(200).json({
        ready: true,
        database: {
          activePort: activeDatabasePort,
        },
      });
    } else {
      res.status(503).json({
        ready: false,
        reason: "Database not ready",
        database: {
          activePort: activeDatabasePort,
        },
      });
    }
  } catch (error) {
    const activeDatabasePort = db.getActiveDbPort();
    res.status(503).json({
      ready: false,
      reason: error instanceof Error ? error.message : "Unknown error",
      database: {
        activePort: activeDatabasePort,
      },
    });
  }
});

/**
 * @swagger
 * /health/live:
 *   get:
 *     summary: Kubernetes liveness probe
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Service is alive
 */
router.get("/live", (_req: Request, res: Response) => {
  res.status(200).json({ alive: true });
});

export default router;

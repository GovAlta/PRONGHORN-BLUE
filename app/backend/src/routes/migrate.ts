/**
 * Migration Routes
 * POST /migrate/run - Run pending migrations
 * GET /migrate/status - Get migration status
 */
import { Router, Request, Response } from "express";
import MigrationRunner from "../utils/migrate";
import path from "path";

const router = Router();

/**
 * Run database migrations
 * POST /migrate/run
 */
router.post("/run", async (req: Request, res: Response): Promise<void> => {
  // Require admin API key for migrations
  const apiKey = req.headers["x-admin-api-key"] as string;
  const expectedKey = process.env.ADMIN_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    res.status(403).json({ error: "Unauthorized - Admin API key required" });
    return;
  }

  try {
    const runner = new MigrationRunner({
      migrationsPath: path.join(__dirname, "../../migrations"),
    });

    const result = await runner.runMigrations();
    await runner.disconnect();

    if (result.success) {
      res.json({
        success: true,
        message: "Migrations completed successfully",
        filesExecuted: result.filesExecuted,
        duration: result.duration,
      });
    } else {
      res.status(500).json({
        success: false,
        message: "Migration failed",
        errors: result.errors,
        filesExecuted: result.filesExecuted,
        duration: result.duration,
      });
    }
  } catch (error: any) {
    console.error("Migration error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get migration status
 * GET /migrate/status
 */
router.get("/status", async (req: Request, res: Response): Promise<void> => {
  // Require admin API key
  const apiKey = req.headers["x-admin-api-key"] as string;
  const expectedKey = process.env.ADMIN_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    res.status(403).json({ error: "Unauthorized - Admin API key required" });
    return;
  }

  try {
    const runner = new MigrationRunner({
      migrationsPath: path.join(__dirname, "../../migrations"),
    });

    const status = await runner.getStatus();
    await runner.disconnect();

    res.json({
      pending: status.pending,
      executed: status.executed,
      pendingCount: status.pending.length,
      executedCount: status.executed.length,
    });
  } catch (error: any) {
    console.error("Migration status error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;

/**
 * API v1 Router
 * All versioned routes are mounted here
 */
import { Router } from "express";
import { authMiddleware, optionalAuthMiddleware } from "../../middleware/auth";
import { authRateLimiter } from "../../middleware/rateLimit";

// Route imports
import healthRouter from "../health";
import authRouter from "../auth";
import chatRouter from "../chat";
import projectsRouter from "../projects";
import artifactsRouter from "../artifacts";
import canvasRouter from "../canvas";
import databaseRouter from "../database";
import auditRouter from "../audit";
import collaborationRouter from "../collaboration";

import dbRouter from "../db";
import rpcRouter from "../rpc";
import functionsRouter from "../functions";
import storageRouter from "../storage";
import githubRouter from "../github";

const router = Router();

// ============================================================================
// Public Routes (no auth required)
// ============================================================================

router.use("/health", healthRouter);
router.use("/auth", authRateLimiter, authRouter);

// ============================================================================
// Protected Routes (auth required)
// ============================================================================

router.use("/chat", authMiddleware, chatRouter);
router.use("/projects", authMiddleware, projectsRouter);
router.use("/artifacts", authMiddleware, artifactsRouter);
router.use("/canvas", authMiddleware, canvasRouter);
router.use("/database", authMiddleware, databaseRouter);
router.use("/audit", authMiddleware, auditRouter);
router.use("/collaboration", authMiddleware, collaborationRouter);
router.use("/github", optionalAuthMiddleware, githubRouter);

// - db is protected (require auth)
// - rpc and functions use optional auth (some calls allow anonymous)
// - storage uses optional auth (public files can be accessed without auth)
router.use("/db", authMiddleware, dbRouter);
router.use("/rpc", optionalAuthMiddleware, rpcRouter);
router.use("/functions", optionalAuthMiddleware, functionsRouter);
router.use("/storage", optionalAuthMiddleware, storageRouter);

export default router;

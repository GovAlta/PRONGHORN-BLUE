/**
 * GitHub App Integration Routes
 *
 * Repository operations authenticate using the platform GitHub App installation
 * token (see {@link ../utils/githubAppAuth}). There is no per-user OAuth flow:
 * the App's installation token is used server-to-server for all repo create,
 * commit/push, read, and workflow-dispatch operations.
 *
 * The endpoints below are retained for frontend compatibility:
 *   1. GET    /github/auth/status     → reports whether the GitHub App is configured
 *   2. DELETE /github/auth/disconnect → no-op (kept so the UI never 404s)
 *
 * @swagger
 * tags:
 *   name: GitHub
 *   description: GitHub App integration
 */
import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { isGitHubAppConfigured } from "../utils/githubAppAuth";

const router = Router();

// The GitHub organization the App is installed on; reported as the connection
// identity so existing UI can display where repos are created.
const GITHUB_ORG = process.env.GITHUB_ORG || "";

/**
 * GET /github/auth/status
 * Returns whether the GitHub App is configured. Because repo operations are
 * performed server-to-server with the App installation token, "connected" is a
 * property of the platform configuration rather than the individual user.
 */
router.get("/auth/status", (_req: Request, res: Response) => {
  const connected = isGitHubAppConfigured();
  res.json({
    connected,
    githubUsername: connected ? GITHUB_ORG || null : null,
  });
});

/**
 * DELETE /github/auth/disconnect
 * No-op retained for frontend compatibility. There is no per-user token to
 * remove under the GitHub App model.
 */
router.delete("/auth/disconnect", (_req: Request, res: Response) => {
  logger.info("[github] disconnect called — no-op under GitHub App model");
  res.json({ success: true });
});

export default router;

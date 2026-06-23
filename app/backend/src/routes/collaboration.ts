/**
 * Collaboration Routes - Real-time collaboration via WebSocket
 */
import { Router, Request, Response } from "express";
import db from "../utils/database";
import { v4 as uuidv4 } from "uuid";
import { getRepoBlobStore } from "../utils/repoBlobStore";

const router = Router();

// Get collaboration sessions for project
router.get("/:projectId/sessions", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { rows } = await db.query(
    "SELECT * FROM collaboration_sessions WHERE project_id = $1 AND status = $2",
    [projectId, "active"],
  );
  res.json(rows);
});

// Join collaboration session
router.post("/:projectId/join", async (req: Request, res: Response) => {
  const { projectId } = req.params;

  // Get or create active session
  let { rows } = await db.query(
    "SELECT * FROM collaboration_sessions WHERE project_id = $1 AND status = 'active'",
    [projectId],
  );

  if (rows.length === 0) {
    const id = uuidv4();
    const result = await db.query(
      `INSERT INTO collaboration_sessions (id, project_id, status, created_at)
       VALUES ($1, $2, 'active', NOW()) RETURNING *`,
      [id, projectId],
    );
    rows = result.rows;
  }

  const session = rows[0];

  // Add participant
  await db.query(
    `INSERT INTO session_participants (session_id, user_id, joined_at)
     VALUES ($1, $2, NOW()) ON CONFLICT (session_id, user_id) DO NOTHING`,
    [session.id, req.user?.id],
  );

  // Return WebSocket connection info
  res.json({
    sessionId: session.id,
    wsUrl: process.env.WS_URL || null,
    userId: req.user?.id,
  });
});

// Leave collaboration session
router.post("/:projectId/leave", async (req: Request, res: Response) => {
  const { projectId } = req.params;

  await db.query(
    `DELETE FROM session_participants 
     WHERE user_id = $1 AND session_id IN (
       SELECT id FROM collaboration_sessions WHERE project_id = $2
     )`,
    [req.user?.id, projectId],
  );

  res.status(204).send();
});

// Get active participants
router.get("/:projectId/participants", async (req: Request, res: Response) => {
  const { projectId } = req.params;

  const { rows } = await db.query(
    `SELECT u.id, u.email, (u.raw_user_meta_data->>'name') AS name, sp.joined_at
     FROM session_participants sp
     JOIN auth.users u ON u.id = sp.user_id
     JOIN collaboration_sessions cs ON cs.id = sp.session_id
     WHERE cs.project_id = $1 AND cs.status = 'active'`,
    [projectId],
  );

  res.json(rows);
});

/**
 * GET /:collaborationId/snapshot/:versionNumber
 * Read a collaboration version snapshot from blob storage.
 *
 * @example
 * GET /collaboration/abc-123/snapshot/5
 */
router.get(
  "/:collaborationId/snapshot/:versionNumber",
  async (req: Request, res: Response) => {
    const { collaborationId, versionNumber } = req.params;

    // Validate UUID format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(collaborationId)) {
      res.status(400).json({ error: "Invalid collaboration ID format" });
      return;
    }

    const version = parseInt(versionNumber, 10);
    if (!Number.isInteger(version) || version < 1) {
      res
        .status(400)
        .json({ error: "Version number must be a positive integer" });
      return;
    }

    // Look up project_id for the collaboration container
    const collabResult = await db.query(
      "SELECT project_id FROM artifact_collaborations WHERE id = $1",
      [collaborationId],
    );
    const projectId = collabResult.rows[0]?.project_id;
    if (!projectId) {
      res.status(404).json({ error: "Collaboration not found" });
      return;
    }

    const content = await getRepoBlobStore().readCollabSnapshot(
      projectId,
      collaborationId,
      version,
    );
    if (content === null) {
      res.status(404).json({ error: "Snapshot not found" });
      return;
    }

    res.json({ content, versionNumber: version, collaborationId });
  },
);

export default router;

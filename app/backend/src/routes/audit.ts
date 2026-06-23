/**
 * Audit Routes - Project audit operations with Tesseract
 */
import { Router, Request, Response } from "express";
import { Errors } from "../middleware/errorHandler";
import db from "../utils/database";
import { v4 as uuidv4 } from "uuid";

const router = Router();

router.get("/:projectId", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { rows } = await db.query(
    "SELECT * FROM audits WHERE project_id = $1 ORDER BY created_at DESC",
    [projectId]
  );
  res.json(rows);
});

router.get("/:projectId/:id", async (req: Request, res: Response) => {
  const { projectId, id } = req.params;
  const { rows } = await db.query(
    "SELECT * FROM audits WHERE id = $1 AND project_id = $2",
    [id, projectId]
  );
  if (rows.length === 0) throw Errors.notFound("Audit");
  res.json(rows[0]);
});

router.post("/:projectId/start", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { type, config } = req.body;
  const id = uuidv4();

  const { rows } = await db.query(
    `INSERT INTO audits (id, project_id, type, config, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'running', NOW(), NOW()) RETURNING *`,
    [id, projectId, type, config]
  );

  // TODO: Trigger async audit processing via Azure Queue/Event Grid
  res.status(201).json(rows[0]);
});

router.patch("/:projectId/:id", async (req: Request, res: Response) => {
  const { projectId, id } = req.params;
  const { status, results, findings } = req.body;

  const { rows } = await db.query(
    `UPDATE audits SET status = COALESCE($3, status), results = COALESCE($4, results), 
     findings = COALESCE($5, findings), updated_at = NOW()
     WHERE id = $1 AND project_id = $2 RETURNING *`,
    [id, projectId, status, results, findings]
  );

  if (rows.length === 0) throw Errors.notFound("Audit");
  res.json(rows[0]);
});

export default router;

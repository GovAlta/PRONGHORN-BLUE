/**
 * Database Routes - Database schema management and queries
 */
import { Router, Request, Response } from "express";
import { Errors } from "../middleware/errorHandler";
import db from "../utils/database";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// List databases for project
router.get("/:projectId", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { rows } = await db.query(
    "SELECT * FROM project_databases WHERE project_id = $1 ORDER BY created_at",
    [projectId],
  );
  res.json(rows);
});

// Get database details
router.get("/:projectId/:databaseId", async (req: Request, res: Response) => {
  const { projectId, databaseId } = req.params;
  const { rows } = await db.query(
    "SELECT * FROM project_databases WHERE id = $1 AND project_id = $2",
    [databaseId, projectId],
  );
  if (rows.length === 0) throw Errors.notFound("Database");
  res.json(rows[0]);
});

// Create database schema
router.post("/:projectId", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { name, type, schema, connection_config } = req.body;
  const id = uuidv4();

  const { rows } = await db.query(
    `INSERT INTO project_databases (id, project_id, name, type, schema, connection_config, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *`,
    [id, projectId, name, type, schema, connection_config],
  );
  res.status(201).json(rows[0]);
});

// Update database schema
router.patch("/:projectId/:databaseId", async (req: Request, res: Response) => {
  const { projectId, databaseId } = req.params;
  const { name, schema, connection_config } = req.body;

  const { rows } = await db.query(
    `UPDATE project_databases SET name = COALESCE($3, name), schema = COALESCE($4, schema), 
     connection_config = COALESCE($5, connection_config), updated_at = NOW()
     WHERE id = $1 AND project_id = $2 RETURNING *`,
    [databaseId, projectId, name, schema, connection_config],
  );

  if (rows.length === 0) throw Errors.notFound("Database");
  res.json(rows[0]);
});

// Delete database
router.delete(
  "/:projectId/:databaseId",
  async (req: Request, res: Response) => {
    const { projectId, databaseId } = req.params;
    await db.query(
      "DELETE FROM project_databases WHERE id = $1 AND project_id = $2",
      [databaseId, projectId],
    );
    res.status(204).send();
  },
);

export default router;

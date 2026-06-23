/**
 * Canvas Routes - Node/Edge operations for visual canvas
 */
import { Router, Request, Response } from "express";
import db from "../utils/database";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// Get all nodes for a project
router.get("/:projectId/nodes", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { rows } = await db.query(
    "SELECT * FROM canvas_nodes WHERE project_id = $1 ORDER BY created_at",
    [projectId]
  );
  res.json(rows);
});

// Get all edges for a project
router.get("/:projectId/edges", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { rows } = await db.query(
    "SELECT * FROM canvas_edges WHERE project_id = $1",
    [projectId]
  );
  res.json(rows);
});

// Create node
router.post("/:projectId/nodes", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { id: clientId, type, position, data, layer_id } = req.body;
  const id = clientId || uuidv4();

  const { rows } = await db.query(
    `INSERT INTO canvas_nodes (id, project_id, type, position, data, layer_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       position = COALESCE(EXCLUDED.position, canvas_nodes.position),
       data = COALESCE(EXCLUDED.data, canvas_nodes.data),
       layer_id = COALESCE(EXCLUDED.layer_id, canvas_nodes.layer_id),
       updated_at = NOW()
     RETURNING *`,
    [id, projectId, type, position, data, layer_id]
  );
  res.status(201).json(rows[0]);
});

// Update node (upsert - creates if not found)
router.patch("/:projectId/nodes/:nodeId", async (req: Request, res: Response) => {
  const { projectId, nodeId } = req.params;
  const { type, position, data, layer_id } = req.body;

  // Try update first
  const { rows } = await db.query(
    `UPDATE canvas_nodes SET position = COALESCE($3, position), data = COALESCE($4, data), 
     updated_at = NOW() WHERE id = $1 AND project_id = $2 RETURNING *`,
    [nodeId, projectId, position, data]
  );

  if (rows.length > 0) {
    res.json(rows[0]);
    return;
  }

  // Node doesn't exist - create it (upsert behavior)
  const nodeType = type || (data as any)?.type || "OTHER";
  const { rows: created } = await db.query(
    `INSERT INTO canvas_nodes (id, project_id, type, position, data, layer_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *`,
    [nodeId, projectId, nodeType, position || { x: 0, y: 0 }, data || {}, layer_id || null]
  );
  res.status(201).json(created[0]);
});

// Delete node
router.delete("/:projectId/nodes/:nodeId", async (req: Request, res: Response) => {
  const { projectId, nodeId } = req.params;
  const { rowCount } = await db.query(
    "DELETE FROM canvas_nodes WHERE id = $1 AND project_id = $2",
    [nodeId, projectId]
  );
  // Also delete edges connected to this node
  await db.query(
    "DELETE FROM canvas_edges WHERE project_id = $1 AND (source = $2 OR target = $2)",
    [projectId, nodeId]
  );
  res.json({ success: true, deleted: rowCount });
});

// Create edge
router.post("/:projectId/edges", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { id: clientId, source, target, sourceHandle, targetHandle, type, label, data } = req.body;
  const id = clientId || uuidv4();

  const { rows } = await db.query(
    `INSERT INTO canvas_edges (id, project_id, source, target, source_handle, target_handle, type, label, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       source = COALESCE(EXCLUDED.source, canvas_edges.source),
       target = COALESCE(EXCLUDED.target, canvas_edges.target),
       type = COALESCE(EXCLUDED.type, canvas_edges.type),
       label = COALESCE(EXCLUDED.label, canvas_edges.label),
       data = COALESCE(EXCLUDED.data, canvas_edges.data),
       updated_at = NOW()
     RETURNING *`,
    [id, projectId, source, target, sourceHandle, targetHandle, type || "default", label, data]
  );
  res.status(201).json(rows[0]);
});

// Delete edge
router.delete("/:projectId/edges/:edgeId", async (req: Request, res: Response) => {
  const { projectId, edgeId } = req.params;
  const { rowCount } = await db.query(
    "DELETE FROM canvas_edges WHERE id = $1 AND project_id = $2",
    [edgeId, projectId]
  );
  res.json({ success: true, deleted: rowCount });
});

export default router;

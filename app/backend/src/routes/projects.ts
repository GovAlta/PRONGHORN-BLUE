/**
 * Projects Routes - CRUD operations for projects
 * @swagger
 * tags:
 *   name: Projects
 *   description: Project management endpoints
 */
import { Router, Request, Response } from "express";
import { Errors } from "../middleware/errorHandler";
import { logger } from "../utils/logger";
import db from "../utils/database";
import { v4 as uuidv4 } from "uuid";

const router = Router();

/**
 * @swagger
 * /projects:
 *   get:
 *     summary: List all projects for authenticated user
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of projects
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Project'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/", async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.json([]);
  }
  // Match the get_user_projects RPC logic - fetch projects owned by user via created_by OR via owner token
  const { rows } = await db.query(
    `SELECT DISTINCT ON (p.id)
      p.id, p.name, p.description, p.organization, p.budget, p.scope,
      p.status, p.splash_image_url, p.created_at, p.updated_at,
      (SELECT COUNT(*) FROM artifacts WHERE project_id = p.id) as artifact_count,
      (SELECT COUNT(*) FROM requirements WHERE project_id = p.id) as requirement_count
     FROM projects p 
     LEFT JOIN project_tokens pt ON pt.project_id = p.id AND pt.role = 'owner'
     WHERE p.created_by = $1 
        OR pt.created_by = $1
     ORDER BY p.id, p.updated_at DESC`,
    [userId]
  );
  // Sort by updated_at descending after distinct
  const sorted = rows.sort((a: any, b: any) => 
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
  return res.json(sorted);
});

/**
 * @swagger
 * /projects/{id}:
 *   get:
 *     summary: Get a single project by ID
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Project UUID
 *       - in: query
 *         name: shareToken
 *         schema:
 *           type: string
 *         description: Optional share token for shared projects
 *     responses:
 *       200:
 *         description: Project details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Project'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { shareToken } = req.query;

  const { rows } = await db.query(
    `SELECT p.* FROM projects p 
     WHERE p.id = $1 
     AND (p.created_by = $2 OR EXISTS (
       SELECT 1 FROM project_tokens pt WHERE pt.project_id = p.id AND pt.token = $3
     ))`,
    [id, req.user?.id, shareToken]
  );

  if (rows.length === 0) {
    throw Errors.notFound("Project");
  }

  res.json(rows[0]);
});

/**
 * @swagger
 * /projects:
 *   post:
 *     summary: Create a new project
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               visibility:
 *                 type: string
 *                 enum: [private, public, shared]
 *                 default: private
 *     responses:
 *       201:
 *         description: Project created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Project'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 */
router.post("/", async (req: Request, res: Response) => {
  const { name, description, org_id, organization, budget, scope, status = "DESIGN" } = req.body;

  if (!name) {
    throw Errors.badRequest("Project name is required");
  }

  const id = uuidv4();

  const { rows } = await db.query(
    `INSERT INTO projects (id, name, description, org_id, organization, budget, scope, status, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     RETURNING *`,
    [id, name, description, org_id || null, organization || null, budget || null, scope || null, status, req.user?.id]
  );

  logger.info(`Project created: ${id}`, { userId: req.user?.id, name });
  res.status(201).json(rows[0]);
});

/**
 * @swagger
 * /projects/{id}:
 *   patch:
 *     summary: Update a project
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               visibility:
 *                 type: string
 *               settings:
 *                 type: object
 *     responses:
 *       200:
 *         description: Project updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Project'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.patch("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const updates = req.body;

  // Build dynamic update query - use actual database columns
  const allowedFields = ["name", "description", "organization", "budget", "scope", "status", "splash_image_url", "github_repo", "github_branch", "priority", "tags", "timeline_start", "timeline_end", "selected_model", "max_tokens", "thinking_enabled", "thinking_budget"];
  const updateFields = Object.keys(updates).filter(k => allowedFields.includes(k));

  if (updateFields.length === 0) {
    throw Errors.badRequest("No valid fields to update");
  }

  const setClause = updateFields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const values = updateFields.map(f => updates[f]);

  const { rows } = await db.query(
    `UPDATE projects SET ${setClause}, updated_at = NOW()
     WHERE id = $1 AND created_by = $2
     RETURNING *`,
    [id, req.user?.id, ...values]
  );

  if (rows.length === 0) {
    throw Errors.notFound("Project");
  }

  res.json(rows[0]);
});

/**
 * @swagger
 * /projects/{id}:
 *   delete:
 *     summary: Delete a project
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Project deleted
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  const { rowCount } = await db.query(
    "DELETE FROM projects WHERE id = $1 AND created_by = $2",
    [id, req.user?.id]
  );

  if (rowCount === 0) {
    throw Errors.notFound("Project");
  }

  logger.info(`Project deleted: ${id}`, { userId: req.user?.id });
  res.status(204).send();
});

/**
 * @swagger
 * /projects/{id}/clone:
 *   post:
 *     summary: Clone a project
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name for the cloned project
 *     responses:
 *       201:
 *         description: Project cloned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Project'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.post("/:id/clone", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name } = req.body;

  // Get source project
  const { rows: sourceRows } = await db.query(
    "SELECT * FROM projects WHERE id = $1 AND (created_by = $2 OR status = $3)",
    [id, req.user?.id, "PUBLISHED"]
  );

  if (sourceRows.length === 0) {
    throw Errors.notFound("Project");
  }

  const source = sourceRows[0];
  const newId = uuidv4();

  // Clone project
  const { rows } = await db.query(
    `INSERT INTO projects (id, name, description, org_id, organization, budget, scope, status, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'DESIGN', $8, NOW(), NOW())
     RETURNING *`,
    [newId, name || `${source.name} (Copy)`, source.description, source.org_id, source.organization, source.budget, source.scope, req.user?.id]
  );

  logger.info(`Project cloned: ${id} -> ${newId}`, { userId: req.user?.id });
  res.status(201).json(rows[0]);
});

export default router;

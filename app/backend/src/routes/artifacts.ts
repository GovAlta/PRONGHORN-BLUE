/**
 * Artifacts Routes - CRUD for project artifacts (documents, images, files)
 */
import { Router, Request, Response } from "express";
import { Errors } from "../middleware/errorHandler";
import db from "../utils/database";
import { v4 as uuidv4 } from "uuid";
import { getArtifactContent, putArtifactContent, deleteArtifactContent } from "../staging/artifactContentStore";

const router = Router();

router.get("/:projectId", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { rows } = await db.query(
    "SELECT id, project_id, ai_title, ai_summary, source_type, source_id, image_url, provenance_id, provenance_path, provenance_page, provenance_total_pages, parent_id, is_folder, content_length, created_at, updated_at, created_by FROM artifacts WHERE project_id = $1 ORDER BY created_at DESC",
    [projectId]
  );
  res.json(rows);
});

router.get("/:projectId/:id", async (req: Request, res: Response) => {
  const { projectId, id } = req.params;
  const { rows } = await db.query(
    "SELECT id, project_id, ai_title, ai_summary, source_type, source_id, image_url, provenance_id, provenance_path, provenance_page, provenance_total_pages, parent_id, is_folder, content_length, created_at, updated_at, created_by FROM artifacts WHERE id = $1 AND project_id = $2",
    [id, projectId]
  );
  if (rows.length === 0) throw Errors.notFound("Artifact");
  const row = rows[0];
  const content = await getArtifactContent(projectId, id);
  res.json({ ...row, content: content ?? "" });
});

router.post("/:projectId", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { name, content } = req.body;
  const id = uuidv4();

  const contentLength = content ? Buffer.byteLength(content, "utf8") : 0;
  if (content) {
    await putArtifactContent(projectId, id, content);
  }

  const { rows } = await db.query(
    `INSERT INTO artifacts (id, project_id, ai_title, content_length, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING *`,
    [id, projectId, name, contentLength]
  );
  res.status(201).json({ ...rows[0], content: content ?? "" });
});

router.patch("/:projectId/:id", async (req: Request, res: Response) => {
  const { projectId, id } = req.params;
  const { name, content } = req.body;

  if (content !== undefined && content !== null) {
    const { contentLength } = await putArtifactContent(projectId, id, content);
    const { rows } = await db.query(
      `UPDATE artifacts SET ai_title = COALESCE($3, ai_title), content_length = $4, updated_at = NOW()
       WHERE id = $1 AND project_id = $2 RETURNING *`,
      [id, projectId, name, contentLength]
    );
    if (rows.length === 0) throw Errors.notFound("Artifact");
    res.json({ ...rows[0], content });
  } else {
    const { rows } = await db.query(
      `UPDATE artifacts SET ai_title = COALESCE($3, ai_title), updated_at = NOW()
       WHERE id = $1 AND project_id = $2 RETURNING *`,
      [id, projectId, name]
    );
    if (rows.length === 0) throw Errors.notFound("Artifact");
    res.json(rows[0]);
  }
});

router.delete("/:projectId/:id", async (req: Request, res: Response) => {
  const { projectId, id } = req.params;

  const { rowCount } = await db.query(
    "DELETE FROM artifacts WHERE id = $1 AND project_id = $2",
    [id, projectId]
  );

  if (rowCount === 0) throw Errors.notFound("Artifact");
  await deleteArtifactContent(projectId, id);
  res.status(204).send();
});

export default router;

/**
 * Storage Proxy Routes - Azure Blob Storage or local file system
 *
 * @swagger
 * tags:
 *   name: Storage
 *   description: File storage operations
 */
import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { Errors } from "../middleware/errorHandler";
import fs from "fs";
import path from "path";

const router = Router();

// Storage base directory (for local dev - in production, use Azure Blob Storage)
const STORAGE_BASE =
  process.env.STORAGE_BASE_PATH || path.join(process.cwd(), "storage");

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_BASE)) {
  fs.mkdirSync(STORAGE_BASE, { recursive: true });
}

// Helper to get bucket path
function getBucketPath(bucketName: string): string {
  // Reject bucket names containing path separators or traversal sequences so a
  // caller cannot escape STORAGE_BASE (e.g. "../../etc").
  if (
    typeof bucketName !== "string" ||
    bucketName.length === 0 ||
    !/^[A-Za-z0-9._-]+$/.test(bucketName) ||
    bucketName === "." ||
    bucketName === ".." ||
    /^\.+$/.test(bucketName) ||
    bucketName.startsWith(".")
  ) {
    throw Errors.badRequest("Invalid bucket name");
  }

  const base = path.resolve(STORAGE_BASE);
  const bucketPath = path.resolve(base, bucketName);
  if (bucketPath !== path.join(base, bucketName)) {
    throw Errors.badRequest("Invalid bucket name");
  }

  if (!fs.existsSync(bucketPath)) {
    fs.mkdirSync(bucketPath, { recursive: true });
  }
  return bucketPath;
}

// Helper to safely join paths and prevent directory traversal
function safePath(bucketPath: string, filePath: string): string {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw Errors.badRequest("Invalid path");
  }

  const base = path.resolve(bucketPath);
  const fullPath = path.resolve(base, filePath);

  // Containment check using path.relative: a path that stays inside `base`
  // produces a relative path that is neither absolute nor begins with "..".
  const relative = path.relative(base, fullPath);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw Errors.badRequest("Invalid path");
  }

  return fullPath;
}

/**
 * @swagger
 * /storage/{bucketName}/list:
 *   post:
 *     summary: List files in a bucket/folder
 *     tags: [Storage]
 */
router.post("/:bucketName/list", async (req: Request, res: Response) => {
  const { bucketName } = req.params;
  const { path: folderPath } = req.body;

  try {
    const bucketPath = getBucketPath(bucketName);
    const targetPath = folderPath
      ? safePath(bucketPath, folderPath)
      : bucketPath;

    if (!fs.existsSync(targetPath)) {
      res.json({ data: [], error: null });
      return;
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      res.json({ data: [], error: null });
      return;
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filePath = path.join(targetPath, entry.name);
        const stats = fs.statSync(filePath);
        return {
          name: entry.name,
          id: entry.name,
          updated_at: stats.mtime.toISOString(),
          created_at: stats.birthtime.toISOString(),
          last_accessed_at: stats.atime.toISOString(),
          metadata: { size: stats.size },
        };
      });

    res.json({ data: files, error: null });
  } catch (error: any) {
    if (error.statusCode) {
      throw error;
    }
    logger.error("Storage list error:", error);
    res.status(500).json({ data: null, error: { message: error.message } });
  }
});

/**
 * @swagger
 * /storage/{bucketName}/upload:
 *   post:
 *     summary: Upload a file to a bucket (expects base64 encoded file in body)
 *     tags: [Storage]
 */
router.post("/:bucketName/upload", async (req: Request, res: Response) => {
  const { bucketName } = req.params;
  const { path: filePath, content } = req.body;

  if (!filePath) {
    throw Errors.badRequest("File path is required");
  }

  if (!content) {
    throw Errors.badRequest("File content is required (base64 encoded)");
  }

  try {
    const bucketPath = getBucketPath(bucketName);
    const targetPath = safePath(bucketPath, filePath);

    // Ensure directory exists
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Decode base64 content and write file
    const buffer = Buffer.from(content, "base64");
    fs.writeFileSync(targetPath, buffer);

    logger.info(`File uploaded: ${bucketName}/${filePath}`);

    res.json({
      data: {
        path: filePath,
        fullPath: `${bucketName}/${filePath}`,
        id: filePath,
      },
      error: null,
    });
  } catch (error: any) {
    if (error.statusCode) {
      throw error;
    }
    logger.error("Storage upload error:", error);
    res.status(500).json({ data: null, error: { message: error.message } });
  }
});

/**
 * @swagger
 * /storage/{bucketName}/download:
 *   get:
 *     summary: Download a file from a bucket
 *     tags: [Storage]
 */
router.get("/:bucketName/download", async (req: Request, res: Response) => {
  const { bucketName } = req.params;
  const filePath = req.query.path as string;

  if (!filePath) {
    throw Errors.badRequest("File path is required");
  }

  try {
    const bucketPath = getBucketPath(bucketName);
    const targetPath = safePath(bucketPath, filePath);

    if (!fs.existsSync(targetPath)) {
      throw Errors.notFound("File not found");
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      throw Errors.badRequest("Path is not a file");
    }

    const fileName = path.basename(filePath);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", stat.size);

    const readStream = fs.createReadStream(targetPath);
    readStream.pipe(res);
  } catch (error: any) {
    if (error.statusCode) {
      throw error;
    }
    logger.error("Storage download error:", error);
    res.status(500).json({ error: { message: error.message } });
  }
});

/**
 * @swagger
 * /storage/{bucketName}/public/{path}:
 *   get:
 *     summary: Get public file
 *     tags: [Storage]
 */
router.get("/:bucketName/public/*", async (req: Request, res: Response) => {
  const { bucketName } = req.params;
  const filePath = req.params[0]; // Get everything after /public/

  if (!filePath) {
    throw Errors.badRequest("File path is required");
  }

  try {
    const bucketPath = getBucketPath(bucketName);
    const targetPath = safePath(bucketPath, filePath);

    if (!fs.existsSync(targetPath)) {
      throw Errors.notFound("File not found");
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      throw Errors.badRequest("Path is not a file");
    }

    // Determine content type based on file extension
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".json": "application/json",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
    };

    const contentType = contentTypes[ext] || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "public, max-age=31536000");

    const readStream = fs.createReadStream(targetPath);
    readStream.pipe(res);
  } catch (error: any) {
    if (error.statusCode) {
      throw error;
    }
    logger.error("Storage public access error:", error);
    res.status(500).json({ error: { message: error.message } });
  }
});

/**
 * @swagger
 * /storage/{bucketName}/remove:
 *   post:
 *     summary: Remove files from a bucket
 *     tags: [Storage]
 */
router.post("/:bucketName/remove", async (req: Request, res: Response) => {
  const { bucketName } = req.params;
  const { paths } = req.body;

  if (!paths || !Array.isArray(paths)) {
    throw Errors.badRequest("paths array is required");
  }

  try {
    const bucketPath = getBucketPath(bucketName);
    const errors: string[] = [];

    for (const filePath of paths) {
      try {
        const targetPath = safePath(bucketPath, filePath);
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
          logger.info(`File removed: ${bucketName}/${filePath}`);
        }
      } catch (err: any) {
        errors.push(`${filePath}: ${err.message}`);
      }
    }

    if (errors.length > 0) {
      res.json({
        data: null,
        error: {
          message: `Some files could not be removed: ${errors.join(", ")}`,
        },
      });
    } else {
      res.json({ data: { message: "Files removed" }, error: null });
    }
  } catch (error: any) {
    if (error.statusCode) {
      throw error;
    }
    logger.error("Storage remove error:", error);
    res.status(500).json({ data: null, error: { message: error.message } });
  }
});

export default router;

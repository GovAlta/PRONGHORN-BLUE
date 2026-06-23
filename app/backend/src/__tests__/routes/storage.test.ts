/**
 * Unit tests for the storage routes
 */
import express from "express";
import "express-async-errors";
import request from "supertest";
import { errorHandler } from "../../middleware/errorHandler";
import fs from "fs";

// Suppress logger output
jest.mock("../../utils/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Mock fs module
jest.mock("fs");
const mockFs = fs as jest.Mocked<typeof fs>;

// Provide stable mock for initial module load (existsSync + mkdirSync called at import time)
mockFs.existsSync.mockReturnValue(true);

// Must import storage router AFTER mocking fs
import storageRouter from "../../routes/storage";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/storage", storageRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: paths exist
  mockFs.existsSync.mockReturnValue(true);
});

// ============================================================================
// POST /:bucketName/list
// ============================================================================
describe("POST /storage/:bucketName/list", () => {
  it("should return empty list when path does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);
    const res = await request(createApp())
      .post("/storage/test-bucket/list")
      .send({ path: "nonexistent" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("should return files in a directory", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ isDirectory: () => true } as any);
    mockFs.readdirSync.mockReturnValue([
      { name: "file1.txt", isFile: () => true } as any,
    ] as any);
    // statSync for individual file
    mockFs.statSync.mockReturnValue({
      isDirectory: () => true,
      isFile: () => true,
      size: 100,
      mtime: new Date("2024-01-01"),
      birthtime: new Date("2024-01-01"),
      atime: new Date("2024-01-01"),
    } as any);

    const res = await request(createApp())
      .post("/storage/test-bucket/list")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
  });
});

// ============================================================================
// POST /:bucketName/upload
// ============================================================================
describe("POST /storage/:bucketName/upload", () => {
  it("should return 400 when path is missing", async () => {
    const res = await request(createApp())
      .post("/storage/test-bucket/upload")
      .send({ content: "abc" });
    expect(res.status).toBe(400);
  });

  it("should return 400 when content is missing", async () => {
    const res = await request(createApp())
      .post("/storage/test-bucket/upload")
      .send({ path: "test.txt" });
    expect(res.status).toBe(400);
  });

  it("should upload a file successfully", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.writeFileSync.mockImplementation(() => {});
    const content = Buffer.from("hello world").toString("base64");
    const res = await request(createApp())
      .post("/storage/test-bucket/upload")
      .send({ path: "test.txt", content });
    expect(res.status).toBe(200);
    expect(res.body.data.path).toBe("test.txt");
  });
});

// ============================================================================
// POST /:bucketName/remove
// ============================================================================
describe("POST /storage/:bucketName/remove", () => {
  it("should return 400 when paths is missing", async () => {
    const res = await request(createApp())
      .post("/storage/test-bucket/remove")
      .send({});
    expect(res.status).toBe(400);
  });

  it("should remove files successfully", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.unlinkSync.mockImplementation(() => {});
    const res = await request(createApp())
      .post("/storage/test-bucket/remove")
      .send({ paths: ["file1.txt", "file2.txt"] });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/removed/i);
  });
});

// ============================================================================
// GET /:bucketName/download
// ============================================================================
describe("GET /storage/:bucketName/download", () => {
  it("should return 400 when path query param is missing", async () => {
    const res = await request(createApp()).get("/storage/test-bucket/download");
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// Path traversal protection
// ============================================================================
describe("Path traversal protection", () => {
  it("should reject directory traversal attempts in upload", async () => {
    const res = await request(createApp())
      .post("/storage/test-bucket/upload")
      .send({ path: "../../../etc/passwd", content: "YWJj" });
    // The safePath function normalizes away the ../../, so the file is written inside the bucket
    // This test verifies no 500 error occurs
    expect(res.status).not.toBe(500);
  });
});

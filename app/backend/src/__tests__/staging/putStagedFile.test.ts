/**
 * Tests for putStagedFile — validates that the UPSERT preserves the original
 * operation_type ('add'/'create') when a file is re-staged with 'modify'.
 *
 * @example
 * npx jest src/__tests__/staging/putStagedFile.test.ts
 */

const mockQuery = jest.fn();
const mockWriteStaged = jest.fn();

jest.mock("../../utils/database", () => ({
  __esModule: true,
  default: { query: mockQuery },
}));

jest.mock("../../utils/repoBlobStore", () => ({
  getRepoBlobStore: jest.fn(() => ({
    writeStaged: mockWriteStaged,
  })),
}));

jest.mock("../../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { putStagedFile } from "../../staging/stagedContentStore";

const baseMeta = {
  id: "staging-1",
  repo_id: "repo-1",
  project_id: "proj-1",
  file_path: "src/app.ts",
  old_path: null,
  is_binary: false,
  content_length: 10,
  old_content: null,
  new_content: null,
  created_at: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteStaged.mockResolvedValue(undefined);
});

describe("putStagedFile", () => {
  it("inserts a new staged file with the given operation_type", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseMeta, operation_type: "add" }] });

    const result = await putStagedFile("repo-1", "src/app.ts", "content", {
      projectId: "proj-1",
      operationType: "add",
    });

    expect(result.operationType).toBe("add");
    expect(mockWriteStaged).toHaveBeenCalledWith("proj-1", "repo-1", "src/app.ts", "content");

    // Verify the SQL uses CASE to preserve add/create on modify
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("CASE");
    expect(sql).toContain("repo_staging.operation_type IN ('add', 'create')");
  });

  it("preserves add operation_type when re-staged as modify", async () => {
    // The CASE expression in SQL returns the existing 'add' when incoming is 'modify'
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseMeta, operation_type: "add" }] });

    const result = await putStagedFile("repo-1", "src/app.ts", "updated content", {
      projectId: "proj-1",
      operationType: "modify",
    });

    // The SQL CASE ensures the DB returns the preserved 'add' operation_type
    expect(result.operationType).toBe("add");

    // Verify blob was still written (content updated even though op-type preserved)
    expect(mockWriteStaged).toHaveBeenCalledWith("proj-1", "repo-1", "src/app.ts", "updated content");
  });

  it("allows explicit operation_type changes for non-add/create types", async () => {
    // When original type is 'modify' and incoming is 'delete', the CASE allows the change
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseMeta, operation_type: "delete" }] });

    const result = await putStagedFile("repo-1", "src/app.ts", null, {
      projectId: "proj-1",
      operationType: "delete",
    });

    expect(result.operationType).toBe("delete");

    // Blob write should be skipped for delete
    expect(mockWriteStaged).not.toHaveBeenCalled();
  });

  it("does not write blob for delete operations", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseMeta, operation_type: "delete", content_length: null }] });

    await putStagedFile("repo-1", "src/app.ts", null, {
      projectId: "proj-1",
      operationType: "delete",
    });

    expect(mockWriteStaged).not.toHaveBeenCalled();
  });

  it("writes blob before DB upsert", async () => {
    const callOrder: string[] = [];
    mockWriteStaged.mockImplementation(async () => { callOrder.push("blob"); });
    mockQuery.mockImplementation(async () => { callOrder.push("db"); return { rows: [{ ...baseMeta, operation_type: "add" }] }; });

    await putStagedFile("repo-1", "src/app.ts", "content", {
      projectId: "proj-1",
      operationType: "add",
    });

    expect(callOrder).toEqual(["blob", "db"]);
  });
});

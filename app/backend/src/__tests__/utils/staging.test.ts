/**
 * Unit test scaffold for staging utility behavior.
 *
 * @example
 * mockQuery.mockResolvedValue({ rows: [{ id: 'stage-1' }] });
 */
const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockGetClient = jest.fn();
const mockWriteContent = jest.fn();
const mockWriteBatch = jest.fn();
const mockReadContent = jest.fn();
const mockWriteCommitted = jest.fn();
const mockReadCommitted = jest.fn();
const mockDeleteCommitted = jest.fn();
const mockDeleteStaged = jest.fn();

jest.mock("../../utils/database", () => ({
    __esModule: true,
    default: {
        query: mockQuery,
        getClient: mockGetClient,
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock("../../utils/repoBlobStore", () => ({
    getRepoBlobStore: jest.fn(() => ({
        writeStaged: mockWriteContent,
        writeStagedBatch: mockWriteBatch,
        readStaged: mockReadContent,
        writeCommitted: mockWriteCommitted,
        readCommitted: mockReadCommitted,
        deleteCommitted: mockDeleteCommitted,
        deleteStaged: mockDeleteStaged,
    })),
}));

beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    mockGetClient.mockReset();
    mockWriteContent.mockReset();
    mockWriteBatch.mockReset();
    mockReadContent.mockReset();
    mockWriteCommitted.mockReset();
    mockReadCommitted.mockReset();
    mockDeleteCommitted.mockReset();
    mockDeleteStaged.mockReset();

    mockGetClient.mockResolvedValue({
        query: mockClientQuery,
        release: mockClientRelease,
    });
});

import {
    batchStageFiles,
    commitStagedWithToken,
    getFileContentByPathWithToken,
    getStagedChangesWithToken,
    stageFileChangeWithToken,
} from "../../utils/rpcHelpers";

const repoRow = { project_id: "project-1" };
const stagedRow = {
    id: "stage-1",
    repo_id: "repo-1",
    project_id: "project-1",
    file_path: "src/example.ts",
    operation_type: "edit",
};

const stageFile = async (
    oldContent: string | null = "old text",
    operationType = "edit",
    newContent: string | null = "new text",
) => {
    mockQuery
        .mockResolvedValueOnce({ rows: [repoRow] })
        .mockResolvedValueOnce({ rows: [stagedRow] });

    return stageFileChangeWithToken(
        "repo-1",
        null,
        "src/example.ts",
        operationType,
        oldContent,
        newContent,
        null,
    );
};

const prepareBatchSuccess = () => {
    mockClientQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: "stage-1" }] })
        .mockResolvedValueOnce({ rows: [{ id: "stage-2" }] })
        .mockResolvedValueOnce({ rows: [{ count: "2" }] })
        .mockResolvedValueOnce(undefined);
};

describe("staging utility behavior", () => {
    it("writes blob content before the staging UPSERT", async () => {
        await stageFile();

        expect(mockWriteContent).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts", "new text");
        expect(mockWriteContent.mock.invocationCallOrder[0]).toBeLessThan(mockQuery.mock.invocationCallOrder[1]);
    });

    it("staging UPSERT does not write old_content or new_content columns", async () => {
        await stageFile();

        const upsertSql = mockQuery.mock.calls[1][0] as string;
        expect(upsertSql).not.toContain("old_content");
        expect(upsertSql).not.toContain("new_content");
    });

    it("documents that staging uses UPSERT for re-stage of the same file", async () => {
        await stageFile();

        expect(mockWriteContent).toHaveBeenCalledTimes(1);
        expect(mockQuery.mock.calls[1][0]).toContain("ON CONFLICT (repo_id, file_path) DO UPDATE SET");
    });

    it("skips blob writes for delete staging operations", async () => {
        await stageFile(null, "delete", null);

        expect(mockWriteContent).not.toHaveBeenCalled();
        expect(mockQuery.mock.calls[1][1][3]).toBe("delete");
    });

    it("aborts before the staging UPSERT when blob write fails", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
        mockWriteContent.mockRejectedValueOnce(new Error("blob write failed"));

        await expect(stageFileChangeWithToken(
            "repo-1",
            null,
            "src/example.ts",
            "edit",
            "old text",
            "new text",
            null,
        )).rejects.toThrow("blob write failed");

        expect(mockWriteContent).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts", "new text");
    });

    it("surfaces DB UPSERT failure after successful blob write", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [repoRow] })
            .mockRejectedValueOnce(new Error("staging UPSERT failed"));

        await expect(stageFileChangeWithToken(
            "repo-1",
            null,
            "src/example.ts",
            "edit",
            "old text",
            "new text",
            null,
        )).rejects.toThrow("staging UPSERT failed");

        expect(mockWriteContent).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts", "new text");
    });

    it("documents that stageFileChangeWithToken returns the UPSERT row", async () => {
        const result = await stageFile();

        expect(mockQuery.mock.calls[1][0]).toContain("RETURNING *");
        expect(result).toEqual(expect.objectContaining({
            filePath: "src/example.ts",
            repoId: "repo-1",
            projectId: "project-1",
            operationType: "edit",
            oldContent: null,
            newContent: null,
        }));
    });

    it("documents getStagedChangesWithToken returns staged rows", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [stagedRow] });

        const result = await getStagedChangesWithToken("repo-1");

        expect(result[0]).toEqual(expect.objectContaining({
            file_path: "src/example.ts",
            operation_type: "edit",
        }));
    });

    it("documents one staging UPSERT query per stageFileChangeWithToken invocation", async () => {
        await stageFile();

        const upsertCalls = mockQuery.mock.calls.filter(([sql]) =>
            String(sql).includes("INSERT INTO repo_staging"),
        );
        expect(upsertCalls).toHaveLength(1);
    });

    it("returns committed content from blob storage for an existing file path", async () => {
        // First query: getStagedContent returns no staged row
        mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] });
        // Fallback: readCommitted from blob storage
        mockReadCommitted.mockResolvedValueOnce("committed baseline");

        const result = await getFileContentByPathWithToken("repo-1", "src/example.ts");

        expect(mockReadCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts");
        expect(result).toEqual({
            content: "committed baseline",
            is_binary: false,
            content_length: "committed baseline".length,
        });
    });

    it("returns null for a non-existent file path", async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] });
        mockReadCommitted.mockResolvedValueOnce(null);

        const result = await getFileContentByPathWithToken("repo-1", "src/new-file.ts");

        expect(result).toBeNull();
    });

    it("returns blob-backed staged content when repo_staging.new_content is null", async () => {
        mockReadContent.mockResolvedValueOnce("blob staged content");
        mockQuery.mockResolvedValueOnce({
            rows: [{
                repo_id: "repo-1",
                file_path: "src/example.ts",
                operation_type: "edit",
                new_content: null,
                is_binary: false,
                project_id: "project-1",
            }],
        });

        const result = await getFileContentByPathWithToken("repo-1", "src/example.ts");

        expect(mockReadContent).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts");
        expect(result).toEqual({
            content: "blob staged content",
            is_binary: false,
            content_length: Buffer.byteLength("blob staged content"),
        });
    });

    it("batchStageFiles writes all non-delete blobs before opening the DB transaction", async () => {
        prepareBatchSuccess();

        await batchStageFiles("repo-1", null, [
            { filePath: "src/one.ts", operationType: "create", newContent: "one" },
            { filePath: "src/two.ts", operationType: "modify", newContent: "two" },
        ], "project-1");

        expect(mockWriteBatch).toHaveBeenCalledWith("project-1", "repo-1", [
            { filePath: "src/one.ts", operationType: "create", content: "one" },
            { filePath: "src/two.ts", operationType: "modify", content: "two" },
        ]);
        expect(mockWriteBatch.mock.invocationCallOrder[0]).toBeLessThan(mockClientQuery.mock.invocationCallOrder[0]);
        expect(mockClientQuery.mock.calls[0][0]).toBe("BEGIN");
    });

    it("batchStageFiles only writes blobs for non-delete entries", async () => {
        prepareBatchSuccess();

        await batchStageFiles("repo-1", null, [
            { filePath: "src/one.ts", operationType: "create", newContent: "one" },
            { filePath: "src/deleted.ts", operationType: "delete", newContent: null },
        ], "project-1");

        expect(mockWriteBatch).toHaveBeenCalledWith("project-1", "repo-1", [
            { filePath: "src/one.ts", operationType: "create", content: "one" },
            { filePath: "src/deleted.ts", operationType: "delete", content: null },
        ]);
    });

    it("batchStageFiles aborts before DB transaction when blob batch write fails", async () => {
        mockWriteBatch.mockRejectedValueOnce(new Error("blob batch failed"));

        await expect(batchStageFiles("repo-1", null, [
            { filePath: "src/one.ts", operationType: "create", newContent: "one" },
        ], "project-1")).rejects.toThrow("blob batch failed");

        expect(mockGetClient).not.toHaveBeenCalled();
        expect(mockClientQuery).not.toHaveBeenCalled();
    });

    it("batchStageFiles stores metadata-only repo_staging rows without content columns", async () => {
        prepareBatchSuccess();

        await batchStageFiles("repo-1", null, [
            { filePath: "src/one.ts", operationType: "create", newContent: "one" },
            { filePath: "src/two.ts", operationType: "modify", newContent: "two" },
        ], "project-1");

        const upsertCalls = mockClientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO repo_staging"));
        expect(upsertCalls).toHaveLength(2);
        // SQL should not contain old_content or new_content columns
        expect(upsertCalls[0][0]).not.toContain("old_content");
        expect(upsertCalls[0][0]).not.toContain("new_content");
    });

    it("batchStageFiles repo_staging UPSERT has no old_content or new_content columns", async () => {
        prepareBatchSuccess();

        await batchStageFiles("repo-1", null, [
            { filePath: "src/one.ts", operationType: "create", newContent: "one" },
        ], "project-1");

        const upsertCall = mockClientQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO repo_staging"));
        expect(upsertCall?.[0]).not.toContain("old_content");
        expect(upsertCall?.[0]).not.toContain("new_content");
    });

    it("commits staged rows to repo_files and clears staging", async () => {
        const commitRow = { id: "commit-1", files_changed: 1 };
        mockReadContent.mockResolvedValueOnce("new text");
        mockWriteCommitted.mockResolvedValueOnce(undefined);
        mockDeleteStaged.mockResolvedValueOnce(undefined);
        mockClientQuery
            .mockResolvedValueOnce({ rows: [repoRow] })
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ rows: [stagedRow] })
            .mockResolvedValueOnce({ rows: [commitRow] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce(undefined);

        const result = await commitStagedWithToken("repo-1", null, "Commit staged changes", "main");

        expect(result).toEqual(commitRow);
        // Verify writeCommitted is called with the blob content
        expect(mockWriteCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts", "new text");
        // Verify the INSERT INTO repo_files is metadata-only (no content column)
        const insertCall = mockClientQuery.mock.calls.find(([sql]) =>
            String(sql).includes("INSERT INTO repo_files"),
        );
        expect(insertCall).toBeDefined();
        expect(insertCall![0]).not.toContain("content,");
        expect(insertCall![0]).toContain("is_binary");
        expect(insertCall![0]).toContain("content_length");
        // Staged blob cleaned up after commit
        expect(mockDeleteStaged).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts");
        expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });

    it("commits folder rename rows by updating all child file paths and copying committed blobs", async () => {
        const commitRow = { id: "commit-1", files_changed: 1 };
        mockReadCommitted.mockResolvedValueOnce("renamed content");
        mockWriteCommitted.mockResolvedValueOnce(undefined);
        mockDeleteCommitted.mockResolvedValueOnce(undefined);
        mockClientQuery
            .mockResolvedValueOnce({ rows: [repoRow] })
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({
                rows: [{
                    ...stagedRow,
                    file_path: "src/new-folder",
                    old_path: "src/old-folder",
                    operation_type: "rename",
                }],
            })
            .mockResolvedValueOnce({ rows: [commitRow] })
            .mockResolvedValueOnce({ rowCount: 2 })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce(undefined);

        const result = await commitStagedWithToken("repo-1", null, "Rename folder", "main");

        expect(result).toEqual(commitRow);
        expect(mockClientQuery.mock.calls[4][0]).toContain("path LIKE $2 || '/%'");
        // Committed blob copy: read old → write new → delete old
        expect(mockReadCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/old-folder");
        expect(mockWriteCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/new-folder", "renamed content");
        expect(mockDeleteCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/old-folder");
        expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });

    it("commits only selected staged file paths and leaves unselected rows staged", async () => {
        const commitRow = { id: "commit-1", files_changed: 1 };
        mockReadContent.mockResolvedValueOnce("selected content");
        mockWriteCommitted.mockResolvedValueOnce(undefined);
        mockDeleteStaged.mockResolvedValueOnce(undefined);
        mockClientQuery
            .mockResolvedValueOnce({ rows: [repoRow] })
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ rows: [{ ...stagedRow, file_path: "src/selected.ts" }] })
            .mockResolvedValueOnce({ rows: [commitRow] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce(undefined);

        const result = await commitStagedWithToken("repo-1", null, "Commit selected changes", "main", ["src/selected.ts"]);

        expect(result).toEqual(commitRow);
        expect(mockClientQuery.mock.calls[2]).toEqual([
            "SELECT * FROM repo_staging WHERE repo_id = $1 AND file_path = ANY($2)",
            ["repo-1", ["src/selected.ts"]],
        ]);
        expect(mockClientQuery.mock.calls[5]).toEqual([
            "DELETE FROM repo_staging WHERE repo_id = $1 AND file_path = ANY($2)",
            ["repo-1", ["src/selected.ts"]],
        ]);
        expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });

    it("rolls back commitStagedWithToken on failure and cleans up committed blobs", async () => {
        mockReadContent.mockResolvedValueOnce("blob content");
        mockWriteCommitted.mockResolvedValueOnce(undefined);
        mockDeleteCommitted.mockResolvedValueOnce(undefined);
        mockClientQuery
            .mockResolvedValueOnce({ rows: [repoRow] })
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ rows: [stagedRow] })
            .mockResolvedValueOnce({ rows: [{ id: "commit-1" }] })
            .mockRejectedValueOnce(new Error("repo_files write failed"))
            .mockResolvedValueOnce(undefined);

        await expect(commitStagedWithToken("repo-1", null, "Commit staged changes", "main"))
            .rejects.toThrow("repo_files write failed");

        // DB was rolled back
        expect(mockClientQuery.mock.calls.map((call) => call[0])).toContain("ROLLBACK");
        // Committed blob was cleaned up after failure (blob rollback)
        expect(mockDeleteCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts");
        expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["add"],
        ["create"],
        ["edit"],
    ])('commitStagedWithToken reads staged blob and writes committed blob for op "%s"', async (operationType) => {
        const commitRow = { id: "commit-1", files_changed: 1 };
        mockReadContent.mockResolvedValueOnce(`blob content for ${operationType}`);
        mockWriteCommitted.mockResolvedValueOnce(undefined);
        mockDeleteStaged.mockResolvedValueOnce(undefined);
        mockClientQuery
            .mockResolvedValueOnce({ rows: [repoRow] })   // project lookup
            .mockResolvedValueOnce(undefined)  // BEGIN
            .mockResolvedValueOnce({ rows: [{ ...stagedRow, operation_type: operationType }] })
            .mockResolvedValueOnce({ rows: [commitRow] })
            .mockResolvedValueOnce({ rows: [] })  // INSERT INTO repo_files
            .mockResolvedValueOnce({ rows: [] })  // DELETE FROM repo_staging
            .mockResolvedValueOnce(undefined);    // COMMIT

        const result = await commitStagedWithToken("repo-1", null, "Commit", "main");

        expect(result).toEqual(commitRow);
        expect(mockReadContent).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts");
        // Committed blob is written with staged content
        expect(mockWriteCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts", `blob content for ${operationType}`);
        // repo_files INSERT is metadata-only
        const insertCall = mockClientQuery.mock.calls.find(([sql]) =>
            String(sql).includes("INSERT INTO repo_files"),
        );
        expect(insertCall).toBeDefined();
        expect(insertCall![0]).not.toContain("content,");
        // Staged blob cleaned up after commit
        expect(mockDeleteStaged).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts");
    });
});
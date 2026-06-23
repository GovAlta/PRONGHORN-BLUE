import "express-async-errors";
import express from "express";
import request from "supertest";

const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockGetClient = jest.fn();
const mockReadContent = jest.fn();
const mockDeleteContent = jest.fn();
const mockWriteCommitted = jest.fn();
const mockReadCommitted = jest.fn();
const mockDeleteCommitted = jest.fn();
const mockBroadcast = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("../../utils/database", () => ({
    __esModule: true,
    default: {
        getClient: mockGetClient,
        query: jest.fn(),
    },
}));

jest.mock("../../utils/repoBlobStore", () => ({
    getRepoBlobStore: jest.fn(() => ({
        readStaged: mockReadContent,
        deleteStaged: mockDeleteContent,
        writeCommitted: mockWriteCommitted,
        readCommitted: mockReadCommitted,
        deleteCommitted: mockDeleteCommitted,
    })),
}));

jest.mock("../../websocket", () => ({
    broadcast: mockBroadcast,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        info: jest.fn(),
        warn: mockLoggerWarn,
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import rpcRouter from "../../routes/rpc";

const app = express();
app.use(express.json());
app.use("/rpc", rpcRouter);
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ data: null, error: error.message });
});

const commitRow = { id: "commit-1", files_changed: 1 };
const repoRow = { project_id: "project-1" };

const stagedFile = (overrides: Record<string, unknown> = {}) => ({
    repo_id: "repo-1",
    file_path: "src/example.ts",
    operation_type: "modify",
    new_content: null,
    old_path: null,
    ...overrides,
});

beforeEach(() => {
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    mockGetClient.mockReset();
    mockReadContent.mockReset();
    mockDeleteContent.mockReset();
    mockWriteCommitted.mockReset();
    mockReadCommitted.mockReset();
    mockDeleteCommitted.mockReset();
    mockBroadcast.mockReset();
    mockLoggerWarn.mockReset();

    mockGetClient.mockResolvedValue({
        query: mockClientQuery,
        release: mockClientRelease,
    });
});

const commitRequest = (filePaths?: string[]) => request(app)
    .post("/rpc/commit_staged_with_token")
    .send({
        p_repo_id: "repo-1",
        p_commit_message: "Commit staged changes",
        p_branch: "main",
        ...(filePaths ? { p_file_paths: filePaths } : {}),
    });

const prepareSuccessfulCommit = (stagedRows = [stagedFile()]) => {
    mockClientQuery
        .mockResolvedValueOnce({ rows: [repoRow] })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: stagedRows })
        .mockResolvedValueOnce({ rows: [commitRow] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce(undefined);
};

describe("commit_staged_with_token blob-backed content", () => {
    it("reads staged blob, writes committed blob, and upserts metadata-only repo_files", async () => {
        mockReadContent.mockResolvedValueOnce("blob content");
        mockWriteCommitted.mockResolvedValueOnce(undefined);
        mockDeleteContent.mockResolvedValueOnce(undefined);
        prepareSuccessfulCommit();

        const response = await commitRequest();

        expect(response.status).toBe(200);
        expect(mockReadContent).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts");
        expect(mockWriteCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts", "blob content");
        const insertSql = mockClientQuery.mock.calls[4][0] as string;
        expect(insertSql).toContain("INSERT INTO repo_files");
        // Metadata-only: no content column in SQL
        expect(insertSql).not.toMatch(/\bcontent\b,/);
        expect(insertSql).toContain("is_binary");
        expect(insertSql).toContain("content_length");
    });

    it("rolls back when blob content is missing for a non-delete staged row", async () => {
        mockReadContent.mockResolvedValueOnce(null);
        mockClientQuery
            .mockResolvedValueOnce({ rows: [repoRow] })
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ rows: [stagedFile()] })
            .mockResolvedValueOnce({ rows: [commitRow] })
            .mockResolvedValueOnce(undefined);

        const response = await commitRequest();

        expect(response.status).toBe(500);
        expect(response.body.error).toContain("Missing staged blob content for src/example.ts");
        expect(mockClientQuery.mock.calls.map((call) => call[0])).toEqual([
            expect.stringContaining("SELECT project_id FROM project_repos"),
            "BEGIN",
            expect.stringContaining("SELECT * FROM repo_staging"),
            expect.stringContaining("INSERT INTO repo_commits"),
            "ROLLBACK",
        ]);
        expect(mockDeleteContent).not.toHaveBeenCalled();
    });

    it("does not read blob content for delete-operation staged rows", async () => {
        mockDeleteCommitted.mockResolvedValueOnce(undefined);
        prepareSuccessfulCommit([stagedFile({ operation_type: "delete" })]);

        const response = await commitRequest();

        expect(response.status).toBe(200);
        expect(mockReadContent).not.toHaveBeenCalled();
        expect(mockClientQuery.mock.calls[4]).toEqual([
            "DELETE FROM repo_files WHERE repo_id = $1 AND path = $2",
            ["repo-1", "src/example.ts"],
        ]);
        // Committed blob also deleted for delete ops
        expect(mockDeleteCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts");
    });

    it("deletes staged blobs only for committed non-delete file paths after successful partial commit", async () => {
        mockReadContent.mockResolvedValueOnce("selected blob content");
        mockWriteCommitted.mockResolvedValueOnce(undefined);
        mockDeleteContent.mockResolvedValueOnce(undefined);
        prepareSuccessfulCommit([stagedFile({ file_path: "src/selected.ts" })]);

        const response = await commitRequest(["src/selected.ts"]);

        expect(response.status).toBe(200);
        expect(mockDeleteContent).toHaveBeenCalledTimes(1);
        expect(mockDeleteContent).toHaveBeenCalledWith("project-1", "repo-1", "src/selected.ts");
        expect(mockClientQuery.mock.calls[5]).toEqual([
            "DELETE FROM repo_staging WHERE repo_id = $1 AND file_path = ANY($2)",
            ["repo-1", ["src/selected.ts"]],
        ]);
    });

    it("logs post-commit staged blob cleanup failure without rolling back successful commit", async () => {
        mockReadContent.mockResolvedValueOnce("blob content");
        mockWriteCommitted.mockResolvedValueOnce(undefined);
        mockDeleteContent.mockRejectedValueOnce(new Error("cleanup failed"));
        prepareSuccessfulCommit();

        const response = await commitRequest();

        expect(response.status).toBe(200);
        expect(mockClientQuery).toHaveBeenCalledWith("COMMIT");
        expect(mockClientQuery).not.toHaveBeenCalledWith("ROLLBACK");
        expect(mockLoggerWarn).toHaveBeenCalledWith("Failed to clean up committed staged blob", expect.objectContaining({
            repo_id: "repo-1",
            file_path: "src/example.ts",
        }));
    });
});

describe("commit_staged_with_token content-operation type coverage", () => {
    /**
     * All four content-bearing operation types — add, create, edit, modify — must
     * read from blob storage and write the bytes to repo_files.  Previously only
     * "modify" was tested; the route handler's CONTENT_OPS set now includes all
     * four, so each type gets an explicit test here.
     */
    it.each([
        ["add",    "src/new-file.ts"],
        ["create", "src/created-file.ts"],
        ["edit",   "src/edited-file.ts"],
        ["modify", "src/modified-file.ts"],
    ])('reads staged blob and writes committed blob for operation_type "%s"', async (operationType, filePath) => {
        mockReadContent.mockResolvedValueOnce(`${operationType} blob content`);
        mockWriteCommitted.mockResolvedValueOnce(undefined);
        mockDeleteContent.mockResolvedValueOnce(undefined);
        prepareSuccessfulCommit([stagedFile({ operation_type: operationType, file_path: filePath })]);

        const response = await commitRequest();

        expect(response.status).toBe(200);
        expect(mockReadContent).toHaveBeenCalledWith("project-1", "repo-1", filePath);
        expect(mockWriteCommitted).toHaveBeenCalledWith("project-1", "repo-1", filePath, `${operationType} blob content`);
        const insertSql = mockClientQuery.mock.calls[4][0] as string;
        expect(insertSql).toContain("INSERT INTO repo_files");
        // Metadata-only: no content column
        expect(insertSql).not.toMatch(/\bcontent\b,/);
    });

    it("updates child file paths in repo_files for rename operations and copies committed blob", async () => {
        mockReadCommitted.mockResolvedValueOnce("renamed content");
        mockWriteCommitted.mockResolvedValueOnce(undefined);
        mockDeleteCommitted.mockResolvedValueOnce(undefined);
        prepareSuccessfulCommit([stagedFile({
            operation_type: "rename",
            file_path: "src/new-name.ts",
            old_path: "src/old-name.ts",
        })]);

        const response = await commitRequest();

        expect(response.status).toBe(200);
        expect(mockReadContent).not.toHaveBeenCalled();
        expect(mockClientQuery.mock.calls[4][0]).toContain("UPDATE repo_files");
        // Committed blob copy: read old → write new → delete old
        expect(mockReadCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/old-name.ts");
        expect(mockWriteCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/new-name.ts", "renamed content");
        expect(mockDeleteCommitted).toHaveBeenCalledWith("project-1", "repo-1", "src/old-name.ts");
    });
});
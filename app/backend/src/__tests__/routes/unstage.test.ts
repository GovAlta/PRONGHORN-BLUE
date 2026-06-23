import express from "express";
import request from "supertest";

const mockDbQuery = jest.fn();
const mockDeleteContent = jest.fn();
const mockDeleteAllContent = jest.fn();
const mockBroadcast = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("../../utils/database", () => ({
    __esModule: true,
    default: {
        query: mockDbQuery,
    },
}));

jest.mock("../../utils/repoBlobStore", () => ({
    getRepoBlobStore: jest.fn(() => ({
        deleteStaged: mockDeleteContent,
        deleteAllStaged: mockDeleteAllContent,
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

beforeEach(() => {
    mockDbQuery.mockReset();
    mockDeleteContent.mockReset();
    mockDeleteAllContent.mockReset();
    mockBroadcast.mockReset();
    mockLoggerWarn.mockReset();
});

describe("staging discard blob cleanup", () => {
    it("unstage_file_with_token deletes the matching staged blob and DB row", async () => {
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] })
            .mockResolvedValueOnce({ rows: [{ id: "stage-1" }] });

        const response = await request(app)
            .post("/rpc/unstage_file_with_token")
            .send({ p_repo_id: "repo-1", p_file_path: "src/example.ts" });

        expect(response.status).toBe(200);
        expect(mockDbQuery).toHaveBeenCalledWith(
            "DELETE FROM repo_staging WHERE repo_id = $1 AND file_path = $2 RETURNING id",
            ["repo-1", "src/example.ts"],
        );
        expect(mockDeleteContent).toHaveBeenCalledWith("project-1", "repo-1", "src/example.ts");
    });

    it("reset_repo_files_with_token deletes all staged blobs under the repo prefix and all staging rows", async () => {
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] })
            .mockResolvedValueOnce({ rowCount: 3 });

        const response = await request(app)
            .post("/rpc/reset_repo_files_with_token")
            .send({ p_repo_id: "repo-1" });

        expect(response.status).toBe(200);
        expect(mockDbQuery).toHaveBeenCalledWith("DELETE FROM repo_staging WHERE repo_id = $1", ["repo-1"]);
        expect(mockDeleteAllContent).toHaveBeenCalledWith("project-1", "repo-1");
    });

    it("keeps DB row removal successful when single-file blob cleanup fails", async () => {
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] })
            .mockResolvedValueOnce({ rows: [{ id: "stage-1" }] });
        mockDeleteContent.mockRejectedValueOnce(new Error("cleanup failed"));

        const response = await request(app)
            .post("/rpc/unstage_file_with_token")
            .send({ p_repo_id: "repo-1", p_file_path: "src/example.ts" });

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual({ id: "stage-1" });
        expect(mockLoggerWarn).toHaveBeenCalledWith("Failed to clean up discarded staged blob", expect.objectContaining({
            repo_id: "repo-1",
            file_path: "src/example.ts",
        }));
    });

    it("discarding a single file does not delete the repo prefix", async () => {
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ project_id: "project-1" }] })
            .mockResolvedValueOnce({ rows: [{ id: "stage-1" }] });

        await request(app)
            .post("/rpc/unstage_file_with_token")
            .send({ p_repo_id: "repo-1", p_file_path: "src/one.ts" });

        expect(mockDeleteContent).toHaveBeenCalledWith("project-1", "repo-1", "src/one.ts");
        expect(mockDeleteAllContent).not.toHaveBeenCalled();
    });
});
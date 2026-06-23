const uploadMock = jest.fn();
const downloadToBufferMock = jest.fn();
const deleteIfExistsMock = jest.fn();
const deleteBlobMock = jest.fn();
const listBlobsFlatMock = jest.fn();

jest.mock("@azure/storage-blob", () => ({
    BlobServiceClient: jest.fn(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
}));

const createIfNotExistsMock = jest.fn().mockResolvedValue({});

import { RepoBlobStore } from "../../utils/repoBlobStore";

const createStore = (blobNames: string[] = []) => new RepoBlobStore({
    getContainerClient: () => ({
        getBlockBlobClient: (blobName: string) => {
            blobNames.push(blobName);

            return {
                name: blobName,
                upload: uploadMock,
                downloadToBuffer: downloadToBufferMock,
                deleteIfExists: deleteIfExistsMock,
            };
        },
        listBlobsFlat: listBlobsFlatMock,
        deleteBlob: deleteBlobMock,
        createIfNotExists: createIfNotExistsMock,
    }),
});

async function* blobList(names: string[]) {
    for (const name of names) {
        yield { name };
    }
}

describe("RepoBlobStore validation", () => {
    it("requires a blob service client", () => {
        expect(() => new RepoBlobStore(null as never)).toThrow("Blob service client is required");
    });

    it("requires non-empty repo and file path values", async () => {
        const store = createStore();

        await expect(store.writeStaged("", "repo-1", "src/example.ts", "content")).rejects.toThrow("Project ID is required");
        await expect(store.writeStaged("proj-1", "", "src/example.ts", "content")).rejects.toThrow("Repository ID is required");
        await expect(store.writeStaged("proj-1", "repo-1", "", "content")).rejects.toThrow("File path is required");
    });
});

describe("RepoBlobStore.writeStaged", () => {
    beforeEach(() => {
        uploadMock.mockReset();
    });

    it("uploads content to deterministic staged blob path with overwrite semantics", async () => {
        const blobNames: string[] = [];
        const store = createStore(blobNames);

        await store.writeStaged("proj-1", "repo-1", "src/example.ts", 'console.log("hello");');

        expect(blobNames).toEqual(["repo-1/staged/src/example.ts"]);
        expect(uploadMock).toHaveBeenCalledWith(
            'console.log("hello");',
            Buffer.byteLength('console.log("hello");'),
            { blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" } },
        );
    });

    it("throws when upload fails", async () => {
        uploadMock.mockRejectedValueOnce(new Error("upload failed"));
        const store = createStore();

        await expect(store.writeStaged("proj-1", "repo-1", "src/example.ts", "content")).rejects.toThrow("upload failed");
    });
});

describe("RepoBlobStore.readStaged", () => {
    beforeEach(() => {
        downloadToBufferMock.mockReset();
    });

    it("returns text content from the deterministic staged blob path", async () => {
        const blobNames: string[] = [];
        downloadToBufferMock.mockResolvedValueOnce(Buffer.from("staged content"));
        const store = createStore(blobNames);

        const content = await store.readStaged("proj-1", "repo-1", "src/example.ts");

        expect(blobNames).toEqual(["repo-1/staged/src/example.ts"]);
        expect(content).toBe("staged content");
    });

    it("returns null when the blob does not exist", async () => {
        downloadToBufferMock.mockRejectedValueOnce({ statusCode: 404 });
        const store = createStore();

        await expect(store.readStaged("proj-1", "repo-1", "missing.ts")).resolves.toBeNull();
    });

    it("throws non-404 storage errors", async () => {
        downloadToBufferMock.mockRejectedValueOnce({ statusCode: 500, message: "storage unavailable" });
        const store = createStore();

        await expect(store.readStaged("proj-1", "repo-1", "src/example.ts")).rejects.toMatchObject({ statusCode: 500 });
    });
});

describe("RepoBlobStore.deleteStaged", () => {
    beforeEach(() => {
        deleteIfExistsMock.mockReset();
    });

    it("deletes the deterministic staged blob path", async () => {
        const blobNames: string[] = [];
        deleteIfExistsMock.mockResolvedValueOnce({ succeeded: true });
        const store = createStore(blobNames);

        await store.deleteStaged("proj-1", "repo-1", "src/example.ts");

        expect(blobNames).toEqual(["repo-1/staged/src/example.ts"]);
        expect(deleteIfExistsMock).toHaveBeenCalledTimes(1);
    });

    it("does not throw when the blob is already missing", async () => {
        deleteIfExistsMock.mockResolvedValueOnce({ succeeded: false });
        const store = createStore();

        await expect(store.deleteStaged("proj-1", "repo-1", "missing.ts")).resolves.toBeUndefined();
    });

    it("throws storage errors from delete operations", async () => {
        deleteIfExistsMock.mockRejectedValueOnce(new Error("delete failed"));
        const store = createStore();

        await expect(store.deleteStaged("proj-1", "repo-1", "src/example.ts")).rejects.toThrow("delete failed");
    });
});

describe("RepoBlobStore.writeStagedBatch", () => {
    beforeEach(() => {
        uploadMock.mockReset();
    });

    it("writes all content-bearing files in parallel", async () => {
        const pendingUploads: Array<() => void> = [];
        uploadMock.mockImplementation(() => new Promise<void>((resolve) => pendingUploads.push(resolve)));
        const store = createStore();

        const batchPromise = store.writeStagedBatch("proj-1", "repo-1", [
            { filePath: "src/one.ts", content: "one" },
            { filePath: "src/two.ts", content: "two" },
        ]);

        // Flush microtasks so createIfNotExists resolves before uploads start
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(uploadMock).toHaveBeenCalledTimes(2);
        pendingUploads.forEach((resolve) => resolve());
        await expect(batchPromise).resolves.toBeUndefined();
    });

    it("skips delete operations passed without content", async () => {
        uploadMock.mockResolvedValue({});
        const store = createStore();

        await store.writeStagedBatch("proj-1", "repo-1", [
            { filePath: "src/one.ts", content: "one" },
            { filePath: "src/deleted.ts", content: null, operationType: "delete" },
        ]);

        expect(uploadMock).toHaveBeenCalledTimes(1);
    });

    it("rejects when any content write fails", async () => {
        uploadMock
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error("batch upload failed"));
        const store = createStore();

        await expect(store.writeStagedBatch("proj-1", "repo-1", [
            { filePath: "src/one.ts", content: "one" },
            { filePath: "src/two.ts", content: "two" },
        ])).rejects.toThrow("batch upload failed");
    });

    it("requires files to be an array", async () => {
        const store = createStore();

        await expect(store.writeStagedBatch("proj-1", "repo-1", null as never)).rejects.toThrow("Files must be an array");
    });
});

describe("RepoBlobStore.deleteAllStaged", () => {
    beforeEach(() => {
        deleteBlobMock.mockReset();
        listBlobsFlatMock.mockReset();
    });

    it("deletes all blobs under the repo staged prefix", async () => {
        listBlobsFlatMock.mockReturnValueOnce(blobList([
            "repo-1/staged/src/one.ts",
            "repo-1/staged/src/two.ts",
        ]));
        deleteBlobMock.mockResolvedValue({});
        const store = createStore();

        await store.deleteAllStaged("proj-1", "repo-1");

        expect(listBlobsFlatMock).toHaveBeenCalledWith({ prefix: "repo-1/staged/" });
        expect(deleteBlobMock).toHaveBeenCalledWith("repo-1/staged/src/one.ts");
        expect(deleteBlobMock).toHaveBeenCalledWith("repo-1/staged/src/two.ts");
    });

    it("does not call delete when the repo prefix is empty", async () => {
        listBlobsFlatMock.mockReturnValueOnce(blobList([]));
        const store = createStore();

        await store.deleteAllStaged("proj-empty", "repo-empty");

        expect(deleteBlobMock).not.toHaveBeenCalled();
    });
});

// =============================================================================
// Committed blob methods
// =============================================================================

describe("RepoBlobStore.writeCommitted", () => {
    beforeEach(() => {
        uploadMock.mockReset();
    });

    it("uploads content to deterministic committed blob path", async () => {
        const blobNames: string[] = [];
        const store = createStore(blobNames);

        await store.writeCommitted("proj-1", "repo-1", "src/app.ts", "committed content");

        expect(blobNames).toEqual(["repo-1/committed/src/app.ts"]);
        expect(uploadMock).toHaveBeenCalledWith(
            "committed content",
            Buffer.byteLength("committed content"),
            { blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" } },
        );
    });
});

describe("RepoBlobStore.readCommitted", () => {
    beforeEach(() => {
        downloadToBufferMock.mockReset();
    });

    it("returns text content from the deterministic committed blob path", async () => {
        const blobNames: string[] = [];
        downloadToBufferMock.mockResolvedValueOnce(Buffer.from("committed content"));
        const store = createStore(blobNames);

        const content = await store.readCommitted("proj-1", "repo-1", "src/app.ts");

        expect(blobNames).toEqual(["repo-1/committed/src/app.ts"]);
        expect(content).toBe("committed content");
    });

    it("returns null when the committed blob does not exist", async () => {
        downloadToBufferMock.mockRejectedValueOnce({ statusCode: 404 });
        const store = createStore();

        await expect(store.readCommitted("proj-1", "repo-1", "missing.ts")).resolves.toBeNull();
    });
});

describe("RepoBlobStore.deleteCommitted", () => {
    beforeEach(() => {
        deleteIfExistsMock.mockReset();
    });

    it("deletes the deterministic committed blob path", async () => {
        const blobNames: string[] = [];
        deleteIfExistsMock.mockResolvedValueOnce({ succeeded: true });
        const store = createStore(blobNames);

        await store.deleteCommitted("proj-1", "repo-1", "src/app.ts");

        expect(blobNames).toEqual(["repo-1/committed/src/app.ts"]);
        expect(deleteIfExistsMock).toHaveBeenCalledTimes(1);
    });
});

describe("RepoBlobStore.deleteAllCommitted", () => {
    beforeEach(() => {
        deleteBlobMock.mockReset();
        listBlobsFlatMock.mockReset();
    });

    it("deletes all blobs under the repo committed prefix", async () => {
        listBlobsFlatMock.mockReturnValueOnce(blobList([
            "repo-1/committed/src/one.ts",
            "repo-1/committed/src/two.ts",
        ]));
        deleteBlobMock.mockResolvedValue({});
        const store = createStore();

        await store.deleteAllCommitted("proj-1", "repo-1");

        expect(listBlobsFlatMock).toHaveBeenCalledWith({ prefix: "repo-1/committed/" });
        expect(deleteBlobMock).toHaveBeenCalledWith("repo-1/committed/src/one.ts");
        expect(deleteBlobMock).toHaveBeenCalledWith("repo-1/committed/src/two.ts");
    });

    it("does not call delete when the repo prefix is empty", async () => {
        listBlobsFlatMock.mockReturnValueOnce(blobList([]));
        const store = createStore();

        await store.deleteAllCommitted("proj-empty", "repo-empty");

        expect(deleteBlobMock).not.toHaveBeenCalled();
    });
});

// =============================================================================
// Committed write/read round-trip
// =============================================================================

describe("RepoBlobStore committed write/read round-trip", () => {
    beforeEach(() => {
        uploadMock.mockReset();
        downloadToBufferMock.mockReset();
    });

    it("round-trips committed content through write and read", async () => {
        const store = createStore();
        const content = "export const x = 42;";

        uploadMock.mockResolvedValueOnce({});
        await store.writeCommitted("proj-1", "repo-1", "src/x.ts", content);

        downloadToBufferMock.mockResolvedValueOnce(Buffer.from(content));
        const result = await store.readCommitted("proj-1", "repo-1", "src/x.ts");

        expect(result).toBe(content);
    });
});

// =============================================================================
// Collaboration blob methods
// =============================================================================

describe("RepoBlobStore.writeCollabCurrent / readCollabCurrent", () => {
    beforeEach(() => {
        uploadMock.mockReset();
        downloadToBufferMock.mockReset();
    });

    it("writes and reads collaboration current content", async () => {
        const blobNames: string[] = [];
        const store = createStore(blobNames);
        const content = "current doc";

        uploadMock.mockResolvedValueOnce({});
        await store.writeCollabCurrent("proj-1", "collab-1", content);

        expect(blobNames).toEqual(["collaboration/collab-1/current"]);

        downloadToBufferMock.mockResolvedValueOnce(Buffer.from(content));
        blobNames.length = 0;
        const result = await store.readCollabCurrent("proj-1", "collab-1");

        expect(blobNames).toEqual(["collaboration/collab-1/current"]);
        expect(result).toBe(content);
    });

    it("returns null when current blob is missing", async () => {
        downloadToBufferMock.mockRejectedValueOnce({ statusCode: 404 });
        const store = createStore();

        await expect(store.readCollabCurrent("proj-1", "collab-1")).resolves.toBeNull();
    });
});

describe("RepoBlobStore.writeCollabBase / readCollabBase", () => {
    beforeEach(() => {
        uploadMock.mockReset();
        downloadToBufferMock.mockReset();
    });

    it("writes and reads collaboration base content", async () => {
        const blobNames: string[] = [];
        const store = createStore(blobNames);
        const content = "base doc";

        uploadMock.mockResolvedValueOnce({});
        await store.writeCollabBase("proj-1", "collab-1", content);

        expect(blobNames).toEqual(["collaboration/collab-1/base"]);

        downloadToBufferMock.mockResolvedValueOnce(Buffer.from(content));
        blobNames.length = 0;
        const result = await store.readCollabBase("proj-1", "collab-1");

        expect(blobNames).toEqual(["collaboration/collab-1/base"]);
        expect(result).toBe(content);
    });

    it("returns null when base blob is missing", async () => {
        downloadToBufferMock.mockRejectedValueOnce({ statusCode: 404 });
        const store = createStore();

        await expect(store.readCollabBase("proj-1", "collab-1")).resolves.toBeNull();
    });
});

describe("RepoBlobStore.writeCollabSnapshot / readCollabSnapshot", () => {
    beforeEach(() => {
        uploadMock.mockReset();
        downloadToBufferMock.mockReset();
    });

    it("writes and reads collaboration snapshot at a version number", async () => {
        const blobNames: string[] = [];
        const store = createStore(blobNames);
        const content = "snapshot v5";

        uploadMock.mockResolvedValueOnce({});
        await store.writeCollabSnapshot("proj-1", "collab-1", 5, content);

        expect(blobNames).toEqual(["collaboration/collab-1/snapshots/5"]);

        downloadToBufferMock.mockResolvedValueOnce(Buffer.from(content));
        blobNames.length = 0;
        const result = await store.readCollabSnapshot("proj-1", "collab-1", 5);

        expect(blobNames).toEqual(["collaboration/collab-1/snapshots/5"]);
        expect(result).toBe(content);
    });

    it("returns null when snapshot blob is missing", async () => {
        downloadToBufferMock.mockRejectedValueOnce({ statusCode: 404 });
        const store = createStore();

        await expect(store.readCollabSnapshot("proj-1", "collab-1", 99)).resolves.toBeNull();
    });
});

// =============================================================================
// Artifact blob methods
// =============================================================================

describe("RepoBlobStore.writeArtifact / readArtifact", () => {
    beforeEach(() => {
        uploadMock.mockReset();
        downloadToBufferMock.mockReset();
    });

    it("writes and reads artifact content using projectId container", async () => {
        const blobNames: string[] = [];
        const store = createStore(blobNames);
        const content = "# Artifact content";

        uploadMock.mockResolvedValueOnce({});
        await store.writeArtifact("proj-1", "art-1", content);

        expect(blobNames).toEqual(["artifacts/art-1"]);
        expect(uploadMock).toHaveBeenCalledWith(
            content,
            Buffer.byteLength(content),
            { blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" } },
        );

        downloadToBufferMock.mockResolvedValueOnce(Buffer.from(content));
        blobNames.length = 0;
        const result = await store.readArtifact("proj-1", "art-1");

        expect(blobNames).toEqual(["artifacts/art-1"]);
        expect(result).toBe(content);
    });

    it("returns null when artifact blob is missing", async () => {
        downloadToBufferMock.mockRejectedValueOnce({ statusCode: 404 });
        const store = createStore();

        await expect(store.readArtifact("proj-1", "missing")).resolves.toBeNull();
    });

    it("throws non-404 storage errors on read", async () => {
        downloadToBufferMock.mockRejectedValueOnce({ statusCode: 500, message: "storage error" });
        const store = createStore();

        await expect(store.readArtifact("proj-1", "art-1")).rejects.toMatchObject({ statusCode: 500 });
    });

    it("validates projectId and artifactId are non-empty", async () => {
        const store = createStore();

        await expect(store.writeArtifact("", "art-1", "c")).rejects.toThrow("Project ID is required");
        await expect(store.writeArtifact("proj-1", "", "c")).rejects.toThrow("Artifact ID is required");
        await expect(store.readArtifact("", "art-1")).rejects.toThrow("Project ID is required");
        await expect(store.readArtifact("proj-1", "")).rejects.toThrow("Artifact ID is required");
    });
});

describe("RepoBlobStore.deleteArtifact", () => {
    beforeEach(() => {
        deleteIfExistsMock.mockReset();
    });

    it("deletes the artifact blob", async () => {
        const blobNames: string[] = [];
        deleteIfExistsMock.mockResolvedValueOnce({ succeeded: true });
        const store = createStore(blobNames);

        await store.deleteArtifact("proj-1", "art-1");

        expect(blobNames).toEqual(["artifacts/art-1"]);
        expect(deleteIfExistsMock).toHaveBeenCalledTimes(1);
    });
});

describe("RepoBlobStore.deleteAllArtifacts", () => {
    beforeEach(() => {
        deleteBlobMock.mockReset();
        listBlobsFlatMock.mockReset();
    });

    it("deletes all blobs under the artifacts prefix", async () => {
        listBlobsFlatMock.mockReturnValueOnce(blobList([
            "artifacts/art-1",
            "artifacts/art-2",
        ]));
        deleteBlobMock.mockResolvedValue({});
        const store = createStore();

        await store.deleteAllArtifacts("proj-1");

        expect(listBlobsFlatMock).toHaveBeenCalledWith({ prefix: "artifacts/" });
        expect(deleteBlobMock).toHaveBeenCalledWith("artifacts/art-1");
        expect(deleteBlobMock).toHaveBeenCalledWith("artifacts/art-2");
    });

    it("does not call delete when no artifacts exist", async () => {
        listBlobsFlatMock.mockReturnValueOnce(blobList([]));
        const store = createStore();

        await store.deleteAllArtifacts("proj-1");

        expect(deleteBlobMock).not.toHaveBeenCalled();
    });
});

import { BlobServiceClient } from "@azure/storage-blob";
import { getAzureCredential } from "./azureCredential";
import { logger } from "./logger";

interface UploadOptions {
    blobHTTPHeaders?: {
        blobContentType?: string;
    };
}

interface BlockBlobClientLike {
    upload(content: string, length: number, options?: UploadOptions): Promise<unknown>;
    downloadToBuffer(): Promise<Buffer>;
    deleteIfExists(): Promise<unknown>;
}

interface ContainerClientLike {
    getBlockBlobClient(blobName: string): BlockBlobClientLike;
    listBlobsFlat(options?: { prefix?: string }): AsyncIterable<{ name: string }>;
    deleteBlob(blobName: string): Promise<unknown>;
    createIfNotExists(): Promise<unknown>;
}

interface BlobServiceClientLike {
    getContainerClient(containerName: string): ContainerClientLike;
}

interface StorageErrorLike {
    statusCode?: number;
}

export interface StagedBlobWriteInput {
    filePath: string;
    content?: string | null;
    operationType?: string | null;
}

interface ContentBearingStagedBlobWriteInput extends StagedBlobWriteInput {
    content: string;
}

function hasWritableContent(file: StagedBlobWriteInput): file is ContentBearingStagedBlobWriteInput {
    return file.content !== null && file.content !== undefined && file.operationType !== "delete";
}

const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const AZURE_STORAGE_ACCOUNT_NAME_ENV = "AZURE_STORAGE_ACCOUNT_NAME";
const BLOB_OPERATION_COMPLETED_MESSAGE = "Blob staging operation completed";
const STAGED_PREFIX = "staged/";
const COMMITTED_PREFIX = "committed/";
const COLLABORATION_PREFIX = "collaboration/";
const ARTIFACTS_PREFIX = "artifacts/";
const DEFAULT_AZURE_STORAGE_TIMEOUT_MS = 3000;
const AZURE_STORAGE_TIMEOUT_MS = Number.parseInt(
  process.env.AZURE_STORAGE_TIMEOUT_MS ||
    `${DEFAULT_AZURE_STORAGE_TIMEOUT_MS}`,
  10,
);

type BlobOperationName =
    | "writeStaged" | "readStaged" | "deleteStaged" | "deleteAllStaged"
    | "writeCommitted" | "readCommitted" | "deleteCommitted" | "deleteAllCommitted"
    | "writeCollabCurrent" | "readCollabCurrent"
    | "writeCollabBase" | "readCollabBase"
    | "writeCollabSnapshot" | "readCollabSnapshot"
    | "writeArtifact" | "readArtifact" | "deleteArtifact" | "deleteAllArtifacts";

let repoBlobStore: RepoBlobStore | null = null;

function requireNonEmpty(value: string, fieldName: string): string {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
        throw new Error(`${fieldName} is required`);
    }

    return trimmedValue;
}

/**
 * Encodes each path segment with `encodeURIComponent` so that file paths
 * containing special characters are safely stored as blob names.
 *
 * @example
 * encodeBlobPath('src/my file.ts'); // 'src/my%20file.ts'
 */
function encodeBlobPath(filePath: string): string {
    return filePath.split("/").map(encodeURIComponent).join("/");
}

function stagedBlobPath(repoId: string, filePath: string): string {
    return `${repoId}/${STAGED_PREFIX}${encodeBlobPath(filePath.replace(/^\/+/, ""))}`;
}

function committedBlobPath(repoId: string, filePath: string): string {
    return `${repoId}/${COMMITTED_PREFIX}${encodeBlobPath(filePath.replace(/^\/+/, ""))}`;
}

function collabCurrentPath(collaborationId: string): string {
    return `${COLLABORATION_PREFIX}${collaborationId}/current`;
}

function collabBasePath(collaborationId: string): string {
    return `${COLLABORATION_PREFIX}${collaborationId}/base`;
}

function collabSnapshotPath(collaborationId: string, versionNumber: number): string {
    return `${COLLABORATION_PREFIX}${collaborationId}/snapshots/${versionNumber}`;
}

function artifactBlobPath(artifactId: string): string {
    return `${ARTIFACTS_PREFIX}${artifactId}`;
}

/**
 * Reads the configured Azure Storage account name for managed-identity blob access.
 *
 * @example
 * const accountName = getRequiredStorageAccountName();
 */
function getRequiredStorageAccountName(): string {
    const accountName = process.env[AZURE_STORAGE_ACCOUNT_NAME_ENV];

    if (!accountName?.trim()) {
        throw new Error(`${AZURE_STORAGE_ACCOUNT_NAME_ENV} is required`);
    }

    return accountName.trim();
}

function elapsedMilliseconds(startTime: number): number {
    return Date.now() - startTime;
}

function getBlobOperationTimeoutMs(): number {
    return Number.isInteger(AZURE_STORAGE_TIMEOUT_MS) && AZURE_STORAGE_TIMEOUT_MS > 0
        ? AZURE_STORAGE_TIMEOUT_MS
        : DEFAULT_AZURE_STORAGE_TIMEOUT_MS;
}

function createBlobOperationTimeoutError(operation: BlobOperationName | "ensureContainer", context: string): Error {
    return new Error(
        `Azure Blob Storage ${operation} timed out after ${getBlobOperationTimeoutMs()}ms (${context}). ` +
        "Verify local network/firewall access to the storage account or set AZURE_STORAGE_TIMEOUT_MS.",
    );
}

async function withBlobOperationTimeout<T>(
    operation: BlobOperationName | "ensureContainer",
    context: string,
    promise: Promise<T>,
): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(createBlobOperationTimeoutError(operation, context));
        }, getBlobOperationTimeoutMs());
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

/**
 * Manages repository file content stored in Azure Blob Storage.
 * Each project uses its own container (container name = projectId).
 * Staged files: `{repoId}/staged/{encodedFilePath}` within the project container.
 * Committed files: `{repoId}/committed/{encodedFilePath}` within the project container.
 * Collaboration content: `collaboration/{collaborationId}/current|base|snapshots/{v}`
 * within the `{projectId}` container.
 *
 * @example
 * const store = new RepoBlobStore(blobServiceClient);
 * await store.writeStaged('proj-1', 'repo-1', 'src/index.ts', 'export {};');
 */
export class RepoBlobStore {
    private readonly serviceClient: BlobServiceClientLike;
    private readonly ensuredContainers: Set<string> = new Set();

    /**
     * Creates a repo blob store using the provided Azure Blob service client.
     *
     * @example
     * const store = new RepoBlobStore(blobServiceClient);
     */
    constructor(serviceClient: BlobServiceClientLike) {
        if (!serviceClient) {
            throw new Error("Blob service client is required");
        }

        this.serviceClient = serviceClient;
    }

    /**
     * Writes staged file content to the deterministic blob path for a repo/file pair.
     * Path format: `{repoId}/staged/{encodedFilePath}` in the `{projectId}` container.
     *
     * @example
     * await store.writeStaged('proj-1', 'repo-1', 'src/app.ts', 'console.log("hi");');
     */
    async writeStaged(projectId: string, repoId: string, filePath: string, content: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedRepoId = requireNonEmpty(repoId, "Repository ID");
        const validatedFilePath = requireNonEmpty(filePath, "File path");
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(stagedBlobPath(validatedRepoId, validatedFilePath));
        const bytes = Buffer.byteLength(content);

        await withBlobOperationTimeout("writeStaged", validatedFilePath, blockBlobClient.upload(content, bytes, {
            blobHTTPHeaders: { blobContentType: TEXT_CONTENT_TYPE },
        }));

        this.logOperation("writeStaged", repoId, filePath, bytes, startTime);
    }

    /**
     * Reads staged file content from the deterministic blob path for a repo/file pair.
     * Returns null if the blob does not exist.
     *
     * @example
     * const content = await store.readStaged('proj-1', 'repo-1', 'src/app.ts');
     */
    async readStaged(projectId: string, repoId: string, filePath: string): Promise<string | null> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedRepoId = requireNonEmpty(repoId, "Repository ID");
        const validatedFilePath = requireNonEmpty(filePath, "File path");
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(stagedBlobPath(validatedRepoId, validatedFilePath));

        try {
            const contentBuffer = await withBlobOperationTimeout(
                "readStaged",
                validatedFilePath,
                blockBlobClient.downloadToBuffer(),
            );
            this.logOperation("readStaged", repoId, filePath, contentBuffer.byteLength, startTime);
            return contentBuffer.toString("utf8");
        } catch (error) {
            if (isMissingBlobError(error)) {
                this.logOperation("readStaged", repoId, filePath, 0, startTime);
                return null;
            }

            throw error;
        }
    }

    /**
     * Deletes staged file content from the deterministic blob path for a repo/file pair.
     *
     * @example
     * await store.deleteStaged('proj-1', 'repo-1', 'src/app.ts');
     */
    async deleteStaged(projectId: string, repoId: string, filePath: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedRepoId = requireNonEmpty(repoId, "Repository ID");
        const validatedFilePath = requireNonEmpty(filePath, "File path");
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(stagedBlobPath(validatedRepoId, validatedFilePath));

        await withBlobOperationTimeout("deleteStaged", validatedFilePath, blockBlobClient.deleteIfExists());
        this.logOperation("deleteStaged", repoId, filePath, 0, startTime);
    }

    /**
     * Writes multiple staged file contents in parallel for a repository.
     *
     * @example
     * await store.writeStagedBatch('proj-1', 'repo-1', [{ filePath: 'src/app.ts', content: 'export {};' }]);
     */
    async writeStagedBatch(projectId: string, repoId: string, files: StagedBlobWriteInput[]): Promise<void> {
        if (!Array.isArray(files)) {
            throw new Error("Files must be an array");
        }

        const contentWrites = files
            .filter(hasWritableContent)
            .map((file) => this.writeStaged(projectId, repoId, file.filePath, file.content));

        await Promise.all(contentWrites);
    }

    /**
     * Deletes all staged file content under a repository staged prefix.
     *
     * @example
     * await store.deleteAllStaged('proj-1', 'repo-1');
     */
    async deleteAllStaged(projectId: string, repoId: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedRepoId = requireNonEmpty(repoId, "Repository ID");
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);

        for await (const blob of containerClient.listBlobsFlat({ prefix: `${validatedRepoId}/${STAGED_PREFIX}` })) {
            await containerClient.deleteBlob(blob.name);
        }

        this.logOperation("deleteAllStaged", validatedRepoId, "*", 0, startTime);
    }

    // =========================================================================
    // Committed blob methods
    // =========================================================================

    /**
     * Writes committed file content to the deterministic blob path for a repo/file pair.
     * Path format: `{repoId}/committed/{encodedFilePath}` in the `{projectId}` container.
     *
     * @example
     * await store.writeCommitted('proj-1', 'repo-1', 'src/app.ts', 'console.log("hi");');
     */
    async writeCommitted(projectId: string, repoId: string, filePath: string, content: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedRepoId = requireNonEmpty(repoId, "Repository ID");
        const validatedFilePath = requireNonEmpty(filePath, "File path");
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(committedBlobPath(validatedRepoId, validatedFilePath));
        const bytes = Buffer.byteLength(content);

        await withBlobOperationTimeout("writeCommitted", validatedFilePath, blockBlobClient.upload(content, bytes, {
            blobHTTPHeaders: { blobContentType: TEXT_CONTENT_TYPE },
        }));

        this.logOperation("writeCommitted", repoId, filePath, bytes, startTime);
    }

    /**
     * Reads committed file content from the deterministic blob path for a repo/file pair.
     * Returns null if the blob does not exist.
     *
     * @example
     * const content = await store.readCommitted('proj-1', 'repo-1', 'src/app.ts');
     */
    async readCommitted(projectId: string, repoId: string, filePath: string): Promise<string | null> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedRepoId = requireNonEmpty(repoId, "Repository ID");
        const validatedFilePath = requireNonEmpty(filePath, "File path");
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(committedBlobPath(validatedRepoId, validatedFilePath));

        try {
            const contentBuffer = await withBlobOperationTimeout(
                "readCommitted",
                validatedFilePath,
                blockBlobClient.downloadToBuffer(),
            );
            this.logOperation("readCommitted", repoId, filePath, contentBuffer.byteLength, startTime);
            return contentBuffer.toString("utf8");
        } catch (error) {
            if (isMissingBlobError(error)) {
                this.logOperation("readCommitted", repoId, filePath, 0, startTime);
                return null;
            }

            throw error;
        }
    }

    /**
     * Deletes committed file content from the deterministic blob path for a repo/file pair.
     *
     * @example
     * await store.deleteCommitted('proj-1', 'repo-1', 'src/app.ts');
     */
    async deleteCommitted(projectId: string, repoId: string, filePath: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedRepoId = requireNonEmpty(repoId, "Repository ID");
        const validatedFilePath = requireNonEmpty(filePath, "File path");
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(committedBlobPath(validatedRepoId, validatedFilePath));

        await withBlobOperationTimeout("deleteCommitted", validatedFilePath, blockBlobClient.deleteIfExists());
        this.logOperation("deleteCommitted", repoId, filePath, 0, startTime);
    }

    /**
     * Deletes all committed file content under a repository committed prefix.
     *
     * @example
     * await store.deleteAllCommitted('proj-1', 'repo-1');
     */
    async deleteAllCommitted(projectId: string, repoId: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedRepoId = requireNonEmpty(repoId, "Repository ID");
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);

        for await (const blob of containerClient.listBlobsFlat({ prefix: `${validatedRepoId}/${COMMITTED_PREFIX}` })) {
            await containerClient.deleteBlob(blob.name);
        }

        this.logOperation("deleteAllCommitted", validatedRepoId, "*", 0, startTime);
    }

    // =========================================================================
    // Collaboration blob methods
    // =========================================================================

    /**
     * Writes the current collaboration document content.
     * Stored at `collaboration/{collaborationId}/current` in the `{projectId}` container.
     *
     * @example
     * await store.writeCollabCurrent('proj-1', 'collab-1', 'document content');
     */
    async writeCollabCurrent(projectId: string, collaborationId: string, content: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedId = requireNonEmpty(collaborationId, "Collaboration ID");
        const blobName = collabCurrentPath(validatedId);
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        const bytes = Buffer.byteLength(content);

        await blockBlobClient.upload(content, bytes, {
            blobHTTPHeaders: { blobContentType: TEXT_CONTENT_TYPE },
        });

        this.logOperation("writeCollabCurrent", validatedId, "current", bytes, startTime);
    }

    /**
     * Reads the current collaboration document content.
     * Returns null if the blob does not exist.
     *
     * @example
     * const content = await store.readCollabCurrent('proj-1', 'collab-1');
     */
    async readCollabCurrent(projectId: string, collaborationId: string): Promise<string | null> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedId = requireNonEmpty(collaborationId, "Collaboration ID");
        const blobName = collabCurrentPath(validatedId);
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        try {
            const contentBuffer = await blockBlobClient.downloadToBuffer();
            this.logOperation("readCollabCurrent", validatedId, "current", contentBuffer.byteLength, startTime);
            return contentBuffer.toString("utf8");
        } catch (error) {
            if (isMissingBlobError(error)) {
                this.logOperation("readCollabCurrent", validatedId, "current", 0, startTime);
                return null;
            }

            throw error;
        }
    }

    /**
     * Writes the base (merge baseline) collaboration document content.
     * Stored at `collaboration/{collaborationId}/base` in the `{projectId}` container.
     *
     * @example
     * await store.writeCollabBase('proj-1', 'collab-1', 'base content');
     */
    async writeCollabBase(projectId: string, collaborationId: string, content: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedId = requireNonEmpty(collaborationId, "Collaboration ID");
        const blobName = collabBasePath(validatedId);
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        const bytes = Buffer.byteLength(content);

        await blockBlobClient.upload(content, bytes, {
            blobHTTPHeaders: { blobContentType: TEXT_CONTENT_TYPE },
        });

        this.logOperation("writeCollabBase", validatedId, "base", bytes, startTime);
    }

    /**
     * Reads the base (merge baseline) collaboration document content.
     * Returns null if the blob does not exist.
     *
     * @example
     * const content = await store.readCollabBase('proj-1', 'collab-1');
     */
    async readCollabBase(projectId: string, collaborationId: string): Promise<string | null> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedId = requireNonEmpty(collaborationId, "Collaboration ID");
        const blobName = collabBasePath(validatedId);
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        try {
            const contentBuffer = await blockBlobClient.downloadToBuffer();
            this.logOperation("readCollabBase", validatedId, "base", contentBuffer.byteLength, startTime);
            return contentBuffer.toString("utf8");
        } catch (error) {
            if (isMissingBlobError(error)) {
                this.logOperation("readCollabBase", validatedId, "base", 0, startTime);
                return null;
            }

            throw error;
        }
    }

    /**
     * Writes a collaboration version snapshot.
     * Stored at `collaboration/{collaborationId}/snapshots/{versionNumber}` in the `{projectId}` container.
     *
     * @example
     * await store.writeCollabSnapshot('proj-1', 'collab-1', 5, 'snapshot content');
     */
    async writeCollabSnapshot(projectId: string, collaborationId: string, versionNumber: number, content: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedId = requireNonEmpty(collaborationId, "Collaboration ID");
        const blobName = collabSnapshotPath(validatedId, versionNumber);
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        const bytes = Buffer.byteLength(content);

        await blockBlobClient.upload(content, bytes, {
            blobHTTPHeaders: { blobContentType: TEXT_CONTENT_TYPE },
        });

        this.logOperation("writeCollabSnapshot", validatedId, `snapshot/${versionNumber}`, bytes, startTime);
    }

    /**
     * Reads a collaboration version snapshot.
     * Returns null if the blob does not exist.
     *
     * @example
     * const content = await store.readCollabSnapshot('proj-1', 'collab-1', 5);
     */
    async readCollabSnapshot(projectId: string, collaborationId: string, versionNumber: number): Promise<string | null> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedId = requireNonEmpty(collaborationId, "Collaboration ID");
        const blobName = collabSnapshotPath(validatedId, versionNumber);
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        try {
            const contentBuffer = await blockBlobClient.downloadToBuffer();
            this.logOperation("readCollabSnapshot", validatedId, `snapshot/${versionNumber}`, contentBuffer.byteLength, startTime);
            return contentBuffer.toString("utf8");
        } catch (error) {
            if (isMissingBlobError(error)) {
                this.logOperation("readCollabSnapshot", validatedId, `snapshot/${versionNumber}`, 0, startTime);
                return null;
            }

            throw error;
        }
    }

    // =========================================================================
    // Artifact blob methods
    // =========================================================================

    /**
     * Writes artifact content to blob storage.
     * Stored at `artifacts/{artifactId}` in the `{projectId}` container.
     *
     * @example
     * await store.writeArtifact('proj-1', 'artifact-1', 'document content');
     */
    async writeArtifact(projectId: string, artifactId: string, content: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedId = requireNonEmpty(artifactId, "Artifact ID");
        const blobName = artifactBlobPath(validatedId);
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        const bytes = Buffer.byteLength(content);

        await blockBlobClient.upload(content, bytes, {
            blobHTTPHeaders: { blobContentType: TEXT_CONTENT_TYPE },
        });

        this.logOperation("writeArtifact", validatedProjectId, validatedId, bytes, startTime);
    }

    /**
     * Reads artifact content from blob storage.
     * Returns null if the blob does not exist.
     *
     * @example
     * const content = await store.readArtifact('proj-1', 'artifact-1');
     */
    async readArtifact(projectId: string, artifactId: string): Promise<string | null> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedId = requireNonEmpty(artifactId, "Artifact ID");
        const blobName = artifactBlobPath(validatedId);
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        try {
            const contentBuffer = await blockBlobClient.downloadToBuffer();
            this.logOperation("readArtifact", validatedProjectId, validatedId, contentBuffer.byteLength, startTime);
            return contentBuffer.toString("utf8");
        } catch (error) {
            if (isMissingBlobError(error)) {
                this.logOperation("readArtifact", validatedProjectId, validatedId, 0, startTime);
                return null;
            }

            throw error;
        }
    }

    /**
     * Deletes artifact content from blob storage.
     *
     * @example
     * await store.deleteArtifact('proj-1', 'artifact-1');
     */
    async deleteArtifact(projectId: string, artifactId: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const validatedId = requireNonEmpty(artifactId, "Artifact ID");
        const blobName = artifactBlobPath(validatedId);
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        await blockBlobClient.deleteIfExists();
        this.logOperation("deleteArtifact", validatedProjectId, validatedId, 0, startTime);
    }

    /**
     * Deletes all artifact blobs under the `artifacts/` prefix in a project container.
     *
     * @example
     * await store.deleteAllArtifacts('proj-1');
     */
    async deleteAllArtifacts(projectId: string): Promise<void> {
        const startTime = Date.now();
        const validatedProjectId = requireNonEmpty(projectId, "Project ID");
        const containerClient = await this.getEnsuredContainerClient(validatedProjectId);

        for await (const blob of containerClient.listBlobsFlat({ prefix: ARTIFACTS_PREFIX })) {
            await containerClient.deleteBlob(blob.name);
        }

        this.logOperation("deleteAllArtifacts", validatedProjectId, "*", 0, startTime);
    }

    private async getEnsuredContainerClient(containerName: string): Promise<ContainerClientLike> {
        const containerClient = this.serviceClient.getContainerClient(containerName);

        if (!this.ensuredContainers.has(containerName)) {
            await withBlobOperationTimeout("ensureContainer", containerName, containerClient.createIfNotExists());
            this.ensuredContainers.add(containerName);
        }

        return containerClient;
    }

    private logOperation(blobOperation: BlobOperationName, repoId: string, filePath: string, bytes: number, startTime: number): void {
        logger.info(BLOB_OPERATION_COMPLETED_MESSAGE, {
            blob_op: blobOperation,
            repo_id: repoId,
            file_path: filePath,
            duration_ms: elapsedMilliseconds(startTime),
            bytes,
        });
    }
}

function isMissingBlobError(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && (error as StorageErrorLike).statusCode === 404);
}

/**
 * Initializes the singleton repo blob store from environment configuration.
 *
 * @example
 * const store = initRepoBlobStore();
 */
export function initRepoBlobStore(): RepoBlobStore {
    if (repoBlobStore) {
        return repoBlobStore;
    }

    const storageAccountName = getRequiredStorageAccountName();
    const serviceClient = new BlobServiceClient(
        `https://${storageAccountName}.blob.core.windows.net`,
        getAzureCredential(),
    );
    repoBlobStore = new RepoBlobStore(serviceClient);

    return repoBlobStore;
}

/**
 * Returns the initialized singleton repo blob store.
 *
 * @example
 * const store = getRepoBlobStore();
 */
export function getRepoBlobStore(): RepoBlobStore {
    if (!repoBlobStore) {
        throw new Error("Blob staging store has not been initialized");
    }

    return repoBlobStore;
}

/**
 * Resets singleton state for tests.
 *
 * @example
 * resetRepoBlobStoreForTests();
 */
export function resetRepoBlobStoreForTests(): void {
    repoBlobStore = null;
}

/**
 * Failure-mode tests for the docker deployment actions (T031, US4).
 *
 * Contract: spec FR-004, FR-008.
 *
 * Covers:
 *   - Pre-push throws (deploy) → row marked `failed`, `last_failure_cause`
 *     starts with `'pre-push-failed: '`, `dispatchGenappWorkflow` NOT
 *     called, 502 response, broadcast emitted.
 *   - `dispatchGenappWorkflow` throws (deploy/create/destroy) → row marked
 *     `failed`, `last_failure_cause` starts with `'dispatch-http-'`, 502
 *     response, broadcast emitted.
 */

const mockQuery = jest.fn();
jest.mock("../../../../../utils/database", () => ({
  __esModule: true,
  default: { query: mockQuery },
}));

jest.mock("../../../../../utils/logger", () => ({
  __esModule: true,
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGetDeployment = jest.fn();
const mockGetRepoById = jest.fn();
const mockGetProjectRepos = jest.fn();
const mockGetRepoFiles = jest.fn();
const mockUpdateDeployment = jest.fn();
jest.mock("../../../../../utils/rpcHelpers", () => ({
  __esModule: true,
  getDeploymentWithSecretsWithToken: (...args: any[]) =>
    mockGetDeployment(...args),
  getRepoByIdWithToken: (...args: any[]) => mockGetRepoById(...args),
  getProjectReposWithToken: (...args: any[]) => mockGetProjectRepos(...args),
  getRepoFilesWithToken: (...args: any[]) => mockGetRepoFiles(...args),
  updateDeploymentWithToken: (...args: any[]) => mockUpdateDeployment(...args),
}));

const mockResolveGitHubToken = jest.fn();
jest.mock("../../../../../utils/githubAuth", () => ({
  __esModule: true,
  resolveGitHubToken: (...args: any[]) => mockResolveGitHubToken(...args),
  gitHubApiHeaders: jest.fn(() => ({})),
  gitHubCloneUrl: jest.fn(() => "https://github.com/o/r"),
}));

const mockBroadcast = jest.fn();
jest.mock("../../../../../websocket", () => ({
  __esModule: true,
  broadcast: (...args: any[]) => mockBroadcast(...args),
}));

const mockReadCommitted = jest.fn();
jest.mock("../../../../../utils/repoBlobStore", () => ({
  __esModule: true,
  getRepoBlobStore: () => ({ readCommitted: mockReadCommitted }),
}));

const mockDispatch = jest.fn();
jest.mock(
  "../../../../../services/deployment/docker/genappWorkflowClient",
  () => ({
    __esModule: true,
    dispatchGenappWorkflow: (...args: any[]) => mockDispatch(...args),
    pollWorkflowStatus: jest.fn(),
    findWorkflowRunByAppId: jest.fn(),
  }),
);

jest.mock("../../../../../services/deployment/docker/genappKeyVault", () => ({
  __esModule: true,
  ensureGenappKeyVault: jest.fn().mockResolvedValue({
    name: "kv-ga-0123456789abcdef01",
    uri: "https://kv-ga-0123456789abcdef01.vault.azure.net",
    resourceGroup: "Pronghorn-App",
  }),
  deriveGenappKeyVaultName: () => "kv-ga-0123456789abcdef01",
  genappKeyVaultResourceGroup: () => "Pronghorn-App",
}));

import { deployAction } from "../../../../../services/deployment/docker/actions/deploy";
import { createAction } from "../../../../../services/deployment/docker/actions/create";
import { destroyAction } from "../../../../../services/deployment/docker/actions/destroy";
import type { DockerDeploymentContext } from "../../../../../services/deployment/docker/types";

type MockRes = { status: jest.Mock; json: jest.Mock };

const makeCtx = (
  action: string,
): { ctx: DockerDeploymentContext; res: MockRes } => {
  const res: MockRes = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const ctx = {
    req: {
      user: { id: "user-123" },
    } as unknown as DockerDeploymentContext["req"],
    res: res as unknown as DockerDeploymentContext["res"],
    body: {
      action,
      deploymentId: "dep-1",
      shareToken: null,
    } as DockerDeploymentContext["body"],
  };
  return { ctx, res };
};

const runningDeployment = {
  id: "dep-1",
  project_id: "proj-1",
  repo_id: "repo-1",
  name: "myapp",
  environment: "dev",
  branch: "main",
  dockerfile_path: "Dockerfile",
  env_vars: {},
  status: "running",
  azure_container_app_name: "dev-myapp-12345678",
  azure_resource_group: "rg-genapp-myapp-12345678-dev",
  workflow_run_id: null,
};

const originalFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  mockGetDeployment.mockResolvedValue(runningDeployment);
  mockGetRepoById.mockResolvedValue({
    id: "repo-1",
    organization: "myorg",
    repo: "myrepo",
    is_prime: true,
  });
  mockResolveGitHubToken.mockResolvedValue({
    token: "ghs",
    source: "github_app",
  });
  mockGetRepoFiles.mockResolvedValue([]);
  mockReadCommitted.mockResolvedValue(null);
  mockDispatch.mockResolvedValue(123);
  mockUpdateDeployment.mockResolvedValue({ id: "dep-1" });
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ object: { sha: "abc" }, tree: { sha: "t" } }),
    text: async () => "",
  } as unknown as Response) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** Find the first UPDATE that sets status='failed'. */
function findFailedUpdate(): unknown[] | undefined {
  return mockQuery.mock.calls.find((c) => {
    const sql = String(c[0]);
    const params = (c[1] as unknown[]) ?? [];
    return (
      sql.includes("UPDATE project_deployments") &&
      sql.includes("status") &&
      sql.includes("last_failure_cause") &&
      params.includes("failed")
    );
  });
}

describe("deployAction — pre-push failure (US4, FR-004)", () => {
  it("marks the row failed with last_failure_cause='pre-push-failed: <msg>' and does NOT dispatch", async () => {
    mockGetRepoFiles.mockRejectedValueOnce(new Error("upstream unreachable"));

    const { ctx, res } = makeCtx("deploy");
    await deployAction(ctx);

    expect(mockDispatch).not.toHaveBeenCalled();

    const failedUpdate = findFailedUpdate();
    expect(failedUpdate).toBeDefined();
    const params = (failedUpdate![1] as unknown[]) ?? [];
    expect(params).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^pre-push-failed: /),
        "failed",
        "dep-1",
      ]),
    );

    expect(res.status).toHaveBeenCalledWith(502);
    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        action: "status_updated",
        deploymentId: "dep-1",
        status: "failed",
      }),
    );
  });
});

describe("deployAction — dispatch HTTP failure (US4, FR-008)", () => {
  it("marks the row failed with last_failure_cause starting 'dispatch-http-' and returns 502", async () => {
    mockDispatch.mockRejectedValueOnce(
      new Error("Workflow dispatch failed: 401 unauthorized"),
    );

    const { ctx, res } = makeCtx("deploy");
    await deployAction(ctx);

    const failedUpdate = findFailedUpdate();
    expect(failedUpdate).toBeDefined();
    const params = (failedUpdate![1] as unknown[]) ?? [];
    expect(params).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^dispatch-http-/),
        "failed",
        "dep-1",
      ]),
    );

    expect(res.status).toHaveBeenCalledWith(502);
    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        action: "status_updated",
        status: "failed",
      }),
    );
  });
});

describe("createAction — dispatch HTTP failure (US4, FR-008)", () => {
  it("marks the row failed with last_failure_cause starting 'dispatch-http-' (response already 202'd)", async () => {
    mockGetDeployment.mockResolvedValueOnce({
      ...runningDeployment,
      status: "failed", // create accepts any non-transitional row
    });
    mockDispatch.mockRejectedValueOnce(
      new Error("Workflow dispatch failed: 500 server error"),
    );

    const { ctx, res } = makeCtx("create");
    await createAction(ctx);

    const failedUpdate = findFailedUpdate();
    expect(failedUpdate).toBeDefined();
    const params = (failedUpdate![1] as unknown[]) ?? [];
    expect(params).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^dispatch-http-/),
        "failed",
        "dep-1",
      ]),
    );

    // create acknowledges with 202 BEFORE provisioning/dispatch, so a dispatch
    // failure no longer returns 502 — it is recorded loudly on the row and
    // broadcast instead.
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.status).not.toHaveBeenCalledWith(502);
    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        action: "status_updated",
        status: "failed",
      }),
    );
  });
});

describe("destroyAction — dispatch HTTP failure (US4, FR-008)", () => {
  it("marks the row failed with last_failure_cause starting 'dispatch-http-' and returns 502", async () => {
    mockDispatch.mockRejectedValueOnce(
      new Error("Workflow dispatch failed: 403 forbidden"),
    );

    const { ctx, res } = makeCtx("destroy");
    await destroyAction(ctx);

    const failedUpdate = findFailedUpdate();
    expect(failedUpdate).toBeDefined();
    const params = (failedUpdate![1] as unknown[]) ?? [];
    expect(params).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^dispatch-http-/),
        "failed",
        "dep-1",
      ]),
    );

    expect(res.status).toHaveBeenCalledWith(502);
    expect(mockBroadcast).toHaveBeenCalled();
  });
});

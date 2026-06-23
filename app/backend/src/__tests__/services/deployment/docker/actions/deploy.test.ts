/**
 * Tests for the `deploy` docker deployment action (T013, US1).
 *
 * Happy-path-only per the task description; failure paths land under US4.
 * Covers: pre-push runs BEFORE dispatch; resource names preserved when set;
 * dispatched_action='deploy' persisted; workflow_run_id persisted;
 * deployment_refresh broadcast with action='status_updated'; 202 response.
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
jest.mock("../../../../../utils/rpcHelpers", () => ({
  __esModule: true,
  getDeploymentWithSecretsWithToken: (...args: unknown[]) =>
    mockGetDeployment(...args),
  getRepoByIdWithToken: (...args: unknown[]) => mockGetRepoById(...args),
  getProjectReposWithToken: (...args: unknown[]) =>
    mockGetProjectRepos(...args),
  getRepoFilesWithToken: (...args: unknown[]) => mockGetRepoFiles(...args),
}));

const mockResolveGitHubToken = jest.fn();
const mockGitHubApiHeaders = jest.fn(() => ({}));
jest.mock("../../../../../utils/githubAuth", () => ({
  __esModule: true,
  resolveGitHubToken: (...args: any[]) => mockResolveGitHubToken(...args),
  gitHubApiHeaders: (...args: any[]) => (mockGitHubApiHeaders as any)(...args),
  gitHubCloneUrl: jest.fn(() => "https://github.com/o/r"),
}));

const mockBroadcast = jest.fn();
jest.mock("../../../../../websocket", () => ({
  __esModule: true,
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
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
    dispatchGenappWorkflow: (...args: unknown[]) => mockDispatch(...args),
    pushTerraformTemplates: jest.fn(),
    pollWorkflowStatus: jest.fn(),
    findWorkflowRunByAppId: jest.fn(),
  }),
);

const mockEnsureKeyVault = jest.fn();
jest.mock("../../../../../services/deployment/docker/genappKeyVault", () => ({
  __esModule: true,
  ensureGenappKeyVault: (...args: unknown[]) => mockEnsureKeyVault(...args),
}));

import { deployAction } from "../../../../../services/deployment/docker/actions/deploy";
import type { DockerDeploymentContext } from "../../../../../services/deployment/docker/types";

type MockRes = { status: jest.Mock; json: jest.Mock };

const makeCtx = (): { ctx: DockerDeploymentContext; res: MockRes } => {
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
      action: "deploy",
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
  env_vars: { FOO: "bar" },
  status: "running", // accepts deploy without clearing
  azure_container_app_name: "dev-myapp-existing",
  azure_resource_group: "rg-genapp-myapp-existing-dev",
  workflow_run_id: 42,
};

// Stub fetch for the pre-deploy auto-push branch
const originalFetch = global.fetch;
let fetchMock: jest.Mock;
const okJson = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Map() as unknown as Headers,
  }) as unknown as Response;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDeployment.mockResolvedValue(runningDeployment);
  mockGetRepoById.mockResolvedValue({
    id: "repo-1",
    organization: "myorg",
    repo: "myrepo",
    is_prime: true,
    is_default: false,
  });
  mockResolveGitHubToken.mockResolvedValue({
    token: "ghs",
    source: "github_app",
  });
  mockGetRepoFiles.mockResolvedValue([]); // empty list — skip blob push body but still passes pre-push
  mockReadCommitted.mockResolvedValue(null);
  mockDispatch.mockResolvedValue(123);
  mockEnsureKeyVault.mockResolvedValue({
    name: "kv-ga-0123456789abcdef01",
    uri: "https://kv-ga-0123456789abcdef01.vault.azure.net",
    resourceGroup: "Pronghorn-App",
  });
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

  fetchMock = jest
    .fn()
    .mockResolvedValue(
      okJson(200, { object: { sha: "abc" }, tree: { sha: "t" } }),
    );
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("deployAction — happy path (US1, FR-001, FR-004, FR-005)", () => {
  it("preserves existing resource names when already set on the row (idempotent compute)", async () => {
    const { ctx } = makeCtx();
    await deployAction(ctx);

    // The dispatch payload's appName must match the persisted name, NOT a recompute that drifts.
    const dispatched = mockDispatch.mock.calls[0][0];
    expect(dispatched.appName).toBe("dev-myapp-existing");
  });

  it("persists dispatched_action='deploy' + dispatched_by_user_id + dispatched_at on the row", async () => {
    const { ctx } = makeCtx();
    await deployAction(ctx);

    const setStatusCall = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes("UPDATE project_deployments") &&
        sql.includes("dispatched_action") &&
        sql.includes("dispatched_at")
      );
    });
    expect(setStatusCall).toBeDefined();
    expect(setStatusCall![1]).toEqual(
      expect.arrayContaining(["deploy", "user-123", "dep-1"]),
    );
  });

  it("dispatches the workflow with action='deploy'", async () => {
    const { ctx } = makeCtx();
    await deployAction(ctx);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatched = mockDispatch.mock.calls[0][0];
    expect(dispatched.action).toBe("deploy");
    expect(dispatched.appId).toBe("dep-1");
    expect(dispatched.keyVaultName).toBe("kv-ga-0123456789abcdef01");
  });

  it("persists workflow_run_id from dispatchGenappWorkflow's return value", async () => {
    const { ctx } = makeCtx();
    await deployAction(ctx);

    // Find the dedicated UPDATE that ONLY writes workflow_run_id (post-dispatch),
    // not the pre-dispatch UPDATE that nulls it as part of the status flip.
    const persistRunIdCall = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes("UPDATE project_deployments") &&
        /SET\s+workflow_run_id\s*=\s*\$1/.test(sql)
      );
    });
    expect(persistRunIdCall).toBeDefined();
    expect(persistRunIdCall![1]).toEqual(
      expect.arrayContaining([123, "dep-1"]),
    );
  });

  it("broadcasts deployment_refresh with action='status_updated'", async () => {
    const { ctx } = makeCtx();
    await deployAction(ctx);

    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        action: "status_updated",
        deploymentId: "dep-1",
      }),
    );
  });

  it("responds 202 with workflowRunId", async () => {
    const { ctx, res } = makeCtx();
    await deployAction(ctx);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({
        status: "pending",
        workflowRunId: 123,
      }),
    });
  });

  it("runs the pre-deploy GitHub auto-push attempt BEFORE dispatching the workflow (FR-004)", async () => {
    const { ctx } = makeCtx();
    await deployAction(ctx);

    // The pre-push code path calls resolveGitHubToken at least once for the push,
    // and any GitHub fetch (if files were present) would happen before dispatch.
    expect(mockResolveGitHubToken.mock.invocationCallOrder[0]).toBeLessThan(
      mockDispatch.mock.invocationCallOrder[0],
    );
  });
});

describe("deployAction — concurrency rejection (US5 AS1, FR-009, T038)", () => {
  it.each(["pending", "building", "deploying"] as const)(
    "rejects with 409 'Deployment already in progress' when current status is %s",
    async (status) => {
      mockGetDeployment.mockResolvedValueOnce({
        ...runningDeployment,
        status,
      });

      const { ctx, res } = makeCtx();
      await deployAction(ctx);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "Deployment already in progress",
        }),
      );

      // No dispatch, no broadcast, no UPDATE that flips status.
      expect(mockDispatch).not.toHaveBeenCalled();
      expect(mockBroadcast).not.toHaveBeenCalled();
      const statusFlip = mockQuery.mock.calls.find((c) => {
        const sql = String(c[0]);
        return (
          sql.includes("UPDATE project_deployments") &&
          /status\s*=\s*'pending'/i.test(sql)
        );
      });
      expect(statusFlip).toBeUndefined();
    },
  );
});

describe("deployAction — retry from failed (US5 AS2, T038)", () => {
  it("clears last_failure_cause, workflow_run_url, workflow_run_id, and url in the same UPDATE that sets status='pending'", async () => {
    mockGetDeployment.mockResolvedValueOnce({
      ...runningDeployment,
      status: "failed",
      workflow_run_url: "https://github.com/o/r/actions/runs/old",
      url: "https://old.example.com",
    });

    const { ctx } = makeCtx();
    await deployAction(ctx);

    const statusFlip = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes("UPDATE project_deployments") &&
        /status\s*=\s*'pending'/i.test(sql)
      );
    });
    expect(statusFlip).toBeDefined();
    const sql = String(statusFlip![0]);
    expect(sql).toMatch(/last_failure_cause\s*=\s*NULL/i);
    expect(sql).toMatch(/workflow_run_url\s*=\s*NULL/i);
    expect(sql).toMatch(/workflow_run_id\s*=\s*NULL/i);
    expect(sql).toMatch(/\burl\s*=\s*NULL/i);

    // The dispatch still happens after the retry-clear UPDATE.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

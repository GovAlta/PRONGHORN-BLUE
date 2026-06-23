/**
 * Tests for the `destroy` docker deployment action (T023, US2).
 *
 * Contract: `specs/006-docker-deploy-via-genapp-workflow/contracts/deployment-service-api.md` § destroy
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
const mockUpdateDeployment = jest.fn();
jest.mock("../../../../../utils/rpcHelpers", () => ({
  __esModule: true,
  getDeploymentWithSecretsWithToken: (...args: any[]) =>
    mockGetDeployment(...args),
  getRepoByIdWithToken: (...args: any[]) => mockGetRepoById(...args),
  getProjectReposWithToken: (...args: any[]) => mockGetProjectRepos(...args),
  updateDeploymentWithToken: (...args: any[]) => mockUpdateDeployment(...args),
}));

const mockResolveGitHubToken = jest.fn();
jest.mock("../../../../../utils/githubAuth", () => ({
  __esModule: true,
  resolveGitHubToken: (...args: any[]) => mockResolveGitHubToken(...args),
}));

const mockBroadcast = jest.fn();
jest.mock("../../../../../websocket", () => ({
  __esModule: true,
  broadcast: (...args: any[]) => mockBroadcast(...args),
}));

const mockDispatch = jest.fn();
jest.mock(
  "../../../../../services/deployment/docker/genappWorkflowClient",
  () => ({
    __esModule: true,
    dispatchGenappWorkflow: (...args: any[]) => mockDispatch(...args),
    pushTerraformTemplates: jest.fn(),
    pollWorkflowStatus: jest.fn(),
    findWorkflowRunByAppId: jest.fn(),
  }),
);

jest.mock("../../../../../services/deployment/docker/genappKeyVault", () => ({
  __esModule: true,
  deriveGenappKeyVaultName: () => "kv-ga-0123456789abcdef01",
  genappKeyVaultResourceGroup: () => "Pronghorn-App",
}));

import { destroyAction } from "../../../../../services/deployment/docker/actions/destroy";
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
      action: "destroy",
      deploymentId: "dep-1",
      shareToken: null,
    } as DockerDeploymentContext["body"],
  };
  return { ctx, res };
};

const baseDeployment = {
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
  workflow_run_id: 42,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDeployment.mockResolvedValue(baseDeployment);
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
  mockDispatch.mockResolvedValue(999);
  mockUpdateDeployment.mockResolvedValue({ id: "dep-1" });
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("destroyAction — happy path (US2 AS1, FR-001, FR-018)", () => {
  it("dispatches the workflow with action='destroy' carrying persisted resource names", async () => {
    const { ctx } = makeCtx();
    await destroyAction(ctx);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatched = mockDispatch.mock.calls[0][0];
    expect(dispatched.action).toBe("destroy");
    expect(dispatched.appName).toBe("dev-myapp-12345678");
    expect(dispatched.appId).toBe("dep-1");
  });

  it("persists dispatched_action='destroy' + dispatched_by_user_id + dispatched_at BEFORE dispatch", async () => {
    const { ctx } = makeCtx();
    await destroyAction(ctx);

    const setDispatchCall = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes("UPDATE project_deployments") &&
        sql.includes("dispatched_action") &&
        sql.includes("dispatched_at")
      );
    });
    expect(setDispatchCall).toBeDefined();
    expect(setDispatchCall![1]).toEqual(
      expect.arrayContaining(["destroy", "user-123", "dep-1"]),
    );

    // ordering: pre-dispatch UPDATE must run before dispatch
    expect(mockQuery.mock.invocationCallOrder[0]).toBeLessThan(
      mockDispatch.mock.invocationCallOrder[0],
    );
  });

  it("persists workflow_run_id from dispatchGenappWorkflow", async () => {
    const { ctx } = makeCtx();
    await destroyAction(ctx);

    const persistRunIdCall = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes("UPDATE project_deployments") &&
        /SET\s+workflow_run_id\s*=\s*\$1/.test(sql)
      );
    });
    expect(persistRunIdCall).toBeDefined();
    expect(persistRunIdCall![1]).toEqual(
      expect.arrayContaining([999, "dep-1"]),
    );
  });

  it("broadcasts deployment_refresh with action='status_updated' (NOT 'deleted' — poller does that)", async () => {
    const { ctx } = makeCtx();
    await destroyAction(ctx);

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        action: "status_updated",
        deploymentId: "dep-1",
      }),
    );
  });

  it("responds 202 with { status: 'pending', workflowRunId }", async () => {
    const { ctx, res } = makeCtx();
    await destroyAction(ctx);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({
        status: "pending",
        workflowRunId: 999,
      }),
    });
  });

  it("leaves the row in a transitional state — does NOT set status='deleted' itself", async () => {
    const { ctx } = makeCtx();
    await destroyAction(ctx);

    // No UPDATE should set status='deleted' from this action.
    const deletedUpdate = mockQuery.mock.calls.find((c) => {
      const params = (c[1] as unknown[]) ?? [];
      return params.includes("deleted");
    });
    expect(deletedUpdate).toBeUndefined();
  });
});

describe("destroyAction — short-circuit when nothing to destroy (contract § destroy preconditions)", () => {
  it("when azure_container_app_name is null, skips dispatch and marks status='deleted' directly", async () => {
    mockGetDeployment.mockResolvedValueOnce({
      ...baseDeployment,
      azure_container_app_name: null,
    });

    const { ctx, res } = makeCtx();
    await destroyAction(ctx);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockUpdateDeployment).toHaveBeenCalledWith(
      "dep-1",
      null,
      expect.objectContaining({ status: "deleted" }),
    );

    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        action: "deleted",
        deploymentId: "dep-1",
      }),
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({ status: "deleted" }),
    });
  });
});

describe("destroyAction — concurrency / preconditions", () => {
  it("rejects with 409 when the row is already in a transitional state (FR-009)", async () => {
    mockGetDeployment.mockResolvedValueOnce({
      ...baseDeployment,
      status: "building",
    });

    const { ctx, res } = makeCtx();
    await destroyAction(ctx);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("rejects with 409 when the row is already deleted (US6 — cannot re-destroy)", async () => {
    mockGetDeployment.mockResolvedValueOnce({
      ...baseDeployment,
      status: "deleted",
    });

    const { ctx, res } = makeCtx();
    await destroyAction(ctx);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("404 when the deployment row is not found", async () => {
    mockGetDeployment.mockResolvedValueOnce(null);
    const { ctx, res } = makeCtx();
    await destroyAction(ctx);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("destroyAction — retry from failed destroy (US6 AS2, T042)", () => {
  it("accepts a destroy against a 'failed' row, clears failure attrs in the same status-flip UPDATE, dispatches a fresh run, and responds 202", async () => {
    mockGetDeployment.mockResolvedValueOnce({
      ...baseDeployment,
      status: "failed",
      dispatched_action: "destroy",
      workflow_run_id: 41, // stale id from the prior failed run
      workflow_run_url: "https://github.com/o/r/actions/runs/41",
    });
    mockDispatch.mockResolvedValueOnce(1001); // fresh run id

    const { ctx, res } = makeCtx();
    await destroyAction(ctx);

    // The retry-flip UPDATE clears workflow_run_url, workflow_run_id, url,
    // last_failure_cause inside the same statement that sets status='pending'.
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

    // A fresh dispatch is issued with the same persisted app name.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        action: "destroy",
        appName: "dev-myapp-12345678",
      }),
    );

    // The new workflow_run_id is persisted post-dispatch.
    const persistRunId = mockQuery.mock.calls.find((c) => {
      const s = String(c[0]);
      return (
        s.includes("UPDATE project_deployments") &&
        /SET\s+workflow_run_id\s*=\s*\$1/.test(s)
      );
    });
    expect(persistRunId).toBeDefined();
    expect(persistRunId![1] as unknown[]).toEqual(
      expect.arrayContaining([1001, "dep-1"]),
    );

    expect(res.status).toHaveBeenCalledWith(202);
  });
});

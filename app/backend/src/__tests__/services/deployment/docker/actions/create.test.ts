/**
 * Tests for the `create` docker deployment action (T012, US1).
 *
 * Covers the happy path documented in
 * `specs/006-docker-deploy-via-genapp-workflow/contracts/deployment-service-api.md`
 * § create — write order, dispatch metadata, broadcast, response shape.
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
jest.mock("../../../../../utils/rpcHelpers", () => ({
  __esModule: true,
  getDeploymentWithSecretsWithToken: (...args: unknown[]) =>
    mockGetDeployment(...args),
  getRepoByIdWithToken: (...args: unknown[]) => mockGetRepoById(...args),
  getProjectReposWithToken: (...args: unknown[]) =>
    mockGetProjectRepos(...args),
}));

const mockResolveGitHubToken = jest.fn();
jest.mock("../../../../../utils/githubAuth", () => ({
  __esModule: true,
  resolveGitHubToken: (...args: unknown[]) => mockResolveGitHubToken(...args),
  gitHubApiHeaders: jest.fn(() => ({})),
  gitHubCloneUrl: jest.fn(() => "https://github.com/o/r"),
}));

const mockBroadcast = jest.fn();
jest.mock("../../../../../websocket", () => ({
  __esModule: true,
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
}));

const mockDispatch = jest.fn();
jest.mock(
  "../../../../../services/deployment/docker/genappWorkflowClient",
  () => ({
    __esModule: true,
    dispatchGenappWorkflow: (...args: unknown[]) => mockDispatch(...args),
    pollWorkflowStatus: jest.fn(),
    findWorkflowRunByAppId: jest.fn(),
  }),
);

const mockEnsureKeyVault = jest.fn();
jest.mock("../../../../../services/deployment/docker/genappKeyVault", () => ({
  __esModule: true,
  ensureGenappKeyVault: (...args: unknown[]) => mockEnsureKeyVault(...args),
}));

import { createAction } from "../../../../../services/deployment/docker/actions/create";
import type { DockerDeploymentContext } from "../../../../../services/deployment/docker/types";

type MockRes = {
  status: jest.Mock;
  json: jest.Mock;
};

const makeCtx = (
  overrides?: Partial<DockerDeploymentContext>,
): {
  ctx: DockerDeploymentContext;
  res: MockRes;
} => {
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
      action: "create",
      deploymentId: "dep-1",
      shareToken: null,
    } as DockerDeploymentContext["body"],
    ...overrides,
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
  env_vars: { FOO: "bar" },
  status: "pending",
  azure_container_app_name: null,
  azure_resource_group: null,
  workflow_run_id: null,
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
    token: "ghs_token",
    source: "github_app",
  });
  mockDispatch.mockResolvedValue(987);
  mockEnsureKeyVault.mockResolvedValue({
    name: "kv-ga-0123456789abcdef01",
    uri: "https://kv-ga-0123456789abcdef01.vault.azure.net",
    resourceGroup: "Pronghorn-App",
  });
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("createAction — happy path (US1 AS1, FR-001, FR-002, FR-005)", () => {
  it("persists computed resource names + dispatch metadata BEFORE calling dispatchGenappWorkflow", async () => {
    const { ctx } = makeCtx();
    await createAction(ctx);

    // First UPDATE call sets names + dispatch metadata
    expect(mockQuery).toHaveBeenCalled();
    const updateNamesCall = mockQuery.mock.calls[0];
    const sql = updateNamesCall[0] as string;
    expect(sql).toMatch(/UPDATE project_deployments/i);
    expect(sql).toContain("azure_container_app_name");
    expect(sql).toContain("azure_resource_group");
    expect(sql).toContain("dispatched_by_user_id");
    expect(sql).toContain("dispatched_at");
    expect(sql).toContain("dispatched_action");

    const params = updateNamesCall[1] as unknown[];
    expect(params).toEqual(
      expect.arrayContaining([
        "dev-myapp-dep1", // computed appName: env-name-8charid (dashes stripped from "dep-1" → "dep1")
        "rg-genapp-myapp-dep1-dev", // resource group
        "create", // dispatched_action
        "user-123", // dispatched_by_user_id
        "dep-1", // id
      ]),
    );

    // Sequencing: name UPDATE must occur BEFORE dispatch
    const updateNamesOrder = mockQuery.mock.invocationCallOrder[0];
    const dispatchOrder = mockDispatch.mock.invocationCallOrder[0];
    expect(updateNamesOrder).toBeLessThan(dispatchOrder);
  });

  it("calls dispatchGenappWorkflow with action='create' and the computed appName", async () => {
    const { ctx } = makeCtx();
    await createAction(ctx);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatched = mockDispatch.mock.calls[0][0];
    expect(dispatched.action).toBe("create");
    expect(dispatched.appName).toBe("dev-myapp-dep1");
    expect(dispatched.appId).toBe("dep-1");
    expect(dispatched.repoUrl).toBe("myorg/myrepo");
    expect(dispatched.branch).toBe("main");
    expect(dispatched.environment).toBe("dev");
    expect(dispatched.keyVaultName).toBe("kv-ga-0123456789abcdef01");
    expect(dispatched.githubToken).toBe("ghs_token");
  });

  it("persists workflow_run_id from dispatchGenappWorkflow's return value", async () => {
    const { ctx } = makeCtx();
    await createAction(ctx);

    expect(mockQuery).toHaveBeenCalled();
    const persistRunIdCall = mockQuery.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes("workflow_run_id") &&
        !sql.includes("azure_container_app_name")
      );
    });
    expect(persistRunIdCall).toBeDefined();
    expect(persistRunIdCall![1]).toEqual(
      expect.arrayContaining([987, "dep-1"]),
    );
  });

  it("broadcasts deployment_refresh with action='created' on deployments-{projectId}", async () => {
    const { ctx } = makeCtx();
    await createAction(ctx);

    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        action: "created",
        deploymentId: "dep-1",
        status: "pending",
      }),
    );
  });

  it("responds 202 with { success: true, data: { status: 'pending', workflowRunId } }", async () => {
    const { ctx, res } = makeCtx();
    await createAction(ctx);

    expect(res.status).toHaveBeenCalledWith(202);
    // The 202 is sent BEFORE the workflow is dispatched (provisioning runs
    // server-side after the response is flushed), so the run id is not yet
    // known and the body carries workflowRunId: null. The real run id is
    // persisted to the row and surfaced via the status/polling path.
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { status: "pending", workflowRunId: null },
    });
  });
});

describe("createAction — preconditions", () => {
  it("responds 404 when the deployment row is not found", async () => {
    mockGetDeployment.mockResolvedValueOnce(null);
    const { ctx, res } = makeCtx();
    await createAction(ctx);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("falls back to the project's prime repo when repo_id lookup misses", async () => {
    mockGetRepoById.mockResolvedValueOnce(null);
    mockGetProjectRepos.mockResolvedValueOnce([
      {
        id: "alt-repo",
        organization: "alt",
        repo: "secondary",
        is_prime: false,
      },
      {
        id: "prime-repo",
        organization: "primorg",
        repo: "primrepo",
        is_prime: true,
      },
    ]);
    const { ctx } = makeCtx();
    await createAction(ctx);

    const dispatched = mockDispatch.mock.calls[0][0];
    expect(dispatched.repoUrl).toBe("primorg/primrepo");
  });
});

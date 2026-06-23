/**
 * Tests for the `updateServiceConfig` docker deployment action (T028, US3).
 *
 * Contract: `specs/006-docker-deploy-via-genapp-workflow/contracts/deployment-service-api.md`
 * § updateServiceConfig. Closes the silent-400 gap from the frontend
 * deploy dialog's existing Save button.
 */

const mockQuery = jest.fn();
jest.mock("../../../../../utils/database", () => ({
  __esModule: true,
  default: { query: mockQuery },
}));

jest.mock("../../../../../utils/logger", () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetDeployment = jest.fn();
jest.mock("../../../../../utils/rpcHelpers", () => ({
  __esModule: true,
  getDeploymentWithSecretsWithToken: (...args: any[]) => mockGetDeployment(...args),
}));

const mockBroadcast = jest.fn();
jest.mock("../../../../../websocket", () => ({
  __esModule: true,
  broadcast: (...args: any[]) => mockBroadcast(...args),
}));

const mockDispatch = jest.fn();
const mockPushTemplates = jest.fn();
jest.mock("../../../../../services/deployment/docker/genappWorkflowClient", () => ({
  __esModule: true,
  dispatchGenappWorkflow: (...args: any[]) => mockDispatch(...args),
  pushTerraformTemplates: (...args: any[]) => mockPushTemplates(...args),
  pollWorkflowStatus: jest.fn(),
  findWorkflowRunByAppId: jest.fn(),
}));

import { updateServiceConfigAction } from "../../../../../services/deployment/docker/actions/updateServiceConfig";
import type { DockerDeploymentContext } from "../../../../../services/deployment/docker/types";

type MockRes = { status: jest.Mock; json: jest.Mock };

const makeCtx = (body: Record<string, unknown>): { ctx: DockerDeploymentContext; res: MockRes } => {
  const res: MockRes = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const ctx = {
    req: { user: { id: "user-123" } } as unknown as DockerDeploymentContext["req"],
    res: res as unknown as DockerDeploymentContext["res"],
    body: {
      action: "updateServiceConfig",
      deploymentId: "dep-1",
      shareToken: null,
      ...body,
    } as DockerDeploymentContext["body"],
  };
  return { ctx, res };
};

const baseDeployment = {
  id: "dep-1",
  project_id: "proj-1",
  status: "running",
  run_command: "npm run dev",
  build_command: "npm run build",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDeployment.mockResolvedValue(baseDeployment);
  mockQuery.mockResolvedValue({
    rows: [
      {
        id: "dep-1",
        run_command: "npm start",
        build_command: "npm run build",
        install_command: null,
        dockerfile_path: "Dockerfile",
        branch: "main",
        run_folder: "/",
        build_folder: "dist",
      },
    ],
    rowCount: 1,
  });
});

describe("updateServiceConfigAction — happy path (US3, FR-010)", () => {
  it("persists only the seven whitelisted keys and responds 200", async () => {
    const { ctx, res } = makeCtx({
      config: {
        run_command: "npm start",
        build_command: "npm run build",
        install_command: "npm ci",
        dockerfile_path: "Dockerfile.prod",
        branch: "release",
        run_folder: "/app",
        build_folder: "out",
      },
    });

    await updateServiceConfigAction(ctx);

    expect(mockQuery).toHaveBeenCalled();
    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE project_deployments"),
    );
    expect(updateCall).toBeDefined();
    const sql = String(updateCall![0]);
    // All seven columns appear in the SET clause.
    [
      "run_command",
      "build_command",
      "install_command",
      "dockerfile_path",
      "branch",
      "run_folder",
      "build_folder",
    ].forEach((col) => {
      expect(sql).toContain(col);
    });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({ id: "dep-1" }),
    });
  });

  it("does NOT dispatch the workflow or push templates (FR-010 — no Azure call)", async () => {
    const { ctx } = makeCtx({ config: { run_command: "npm start" } });
    await updateServiceConfigAction(ctx);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockPushTemplates).not.toHaveBeenCalled();
  });

  it("broadcasts deployment_refresh with action='config_updated'", async () => {
    const { ctx } = makeCtx({ config: { run_command: "npm start" } });
    await updateServiceConfigAction(ctx);

    expect(mockBroadcast).toHaveBeenCalledWith(
      "deployments-proj-1",
      "deployment_refresh",
      expect.objectContaining({
        action: "config_updated",
        deploymentId: "dep-1",
      }),
    );
  });

  it("is a 200 no-op (no UPDATE) when body has no `config`", async () => {
    const { ctx, res } = makeCtx({});
    await updateServiceConfigAction(ctx);

    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE project_deployments"),
    );
    expect(updateCall).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("updateServiceConfigAction — input validation (US3, FR-011)", () => {
  it.each([
    "envVars",
    "newEnvVars",
    "keysToDelete",
    "azure_container_app_name",
    "status",
    "url",
    "workflow_run_id",
    "secrets",
  ])("rejects `config.%s` with 400 (unsupported config field)", async (key) => {
    const { ctx, res } = makeCtx({ config: { [key]: "x" } });
    await updateServiceConfigAction(ctx);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: `unsupported config field: ${key}`,
    });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockPushTemplates).not.toHaveBeenCalled();
    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE project_deployments"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("returns 404 when the deployment row is not found", async () => {
    mockGetDeployment.mockResolvedValueOnce(null);
    const { ctx, res } = makeCtx({ config: { run_command: "npm start" } });
    await updateServiceConfigAction(ctx);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

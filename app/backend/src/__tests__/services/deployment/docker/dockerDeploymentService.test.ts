/**
 * Tests for the docker deployment-service entry-point router (T015).
 *
 * Verifies that `handle` dispatches `body.action` through the action
 * registry, falls through to the injected fallback for unregistered
 * actions, and that the fallback is NOT invoked for actions registered by
 * the action modules.
 */

// Stub the action handler modules BEFORE importing the service so its
// static `import` registrations resolve to mocks.
const mockCreateHandler = jest.fn(async () => "create-result");
const mockDeployHandler = jest.fn(async () => "deploy-result");
const mockDestroyHandler = jest.fn(async () => "destroy-result");
const mockStatusHandler = jest.fn(async () => "status-result");
const mockUpdateConfigHandler = jest.fn(async () => "config-result");
const mockLifecycleArmHandler = jest.fn(async () => "lifecycle-result");
const mockLogsHandler = jest.fn(async () => "logs-result");
const mockEnvVarsHandler = jest.fn(async () => "env-result");

jest.mock("../../../../services/deployment/docker/actions/create", () => ({
  __esModule: true,
  createAction: (...args: any[]) => (mockCreateHandler as any)(...args),
}));
jest.mock("../../../../services/deployment/docker/actions/deploy", () => ({
  __esModule: true,
  deployAction: (...args: any[]) => (mockDeployHandler as any)(...args),
}));
jest.mock("../../../../services/deployment/docker/actions/destroy", () => ({
  __esModule: true,
  destroyAction: (...args: any[]) => (mockDestroyHandler as any)(...args),
}));
jest.mock("../../../../services/deployment/docker/actions/status", () => ({
  __esModule: true,
  statusAction: (...args: any[]) => (mockStatusHandler as any)(...args),
}));
jest.mock("../../../../services/deployment/docker/actions/updateServiceConfig", () => ({
  __esModule: true,
  updateServiceConfigAction: (...args: any[]) => (mockUpdateConfigHandler as any)(...args),
}));
jest.mock("../../../../services/deployment/docker/actions/lifecycleArm", () => ({
  __esModule: true,
  lifecycleArmAction: (...args: any[]) => (mockLifecycleArmHandler as any)(...args),
}));
jest.mock("../../../../services/deployment/docker/actions/logs", () => ({
  __esModule: true,
  logsAction: (...args: any[]) => (mockLogsHandler as any)(...args),
}));
jest.mock("../../../../services/deployment/docker/actions/envVars", () => ({
  __esModule: true,
  envVarsAction: (...args: any[]) => (mockEnvVarsHandler as any)(...args),
}));

jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  handle,
  registerDockerDeploymentAction,
  _resetDockerDeploymentActionsForTests,
  _getRegisteredDockerDeploymentActions,
} from "../../../../services/deployment/docker/dockerDeploymentService";

const dummyReq = { user: { id: "u" } } as unknown as Parameters<typeof handle>[0];
const dummyRes = {
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
} as unknown as Parameters<typeof handle>[1];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("dockerDeploymentService.handle — dispatch + fallback contract", () => {
  it("invokes the registered handler for a known action and does NOT call the fallback", async () => {
    const fallback = jest.fn(async () => "legacy");
    const result = await handle(dummyReq, dummyRes, { action: "create", deploymentId: "d" }, fallback);

    expect(mockCreateHandler).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(result).toBe("create-result");
  });

  it("invokes the fallback when no handler is registered for the action", async () => {
    const fallback = jest.fn(async () => "legacy");
    // `not-a-real-verb` is intentionally outside DockerDeploymentAction
    const result = await handle(
      dummyReq,
      dummyRes,
      { action: "not-a-real-verb", deploymentId: "d" } as Record<string, unknown>,
      fallback,
    );

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result).toBe("legacy");
  });

  it("invokes the fallback when body.action is missing", async () => {
    const fallback = jest.fn(async () => "legacy");
    await handle(dummyReq, dummyRes, { deploymentId: "d" } as Record<string, unknown>, fallback);

    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("ships with all Docker deployment verbs pre-registered (T020/T026/T030/T049 contract)", () => {
    const registered = _getRegisteredDockerDeploymentActions();
    expect(registered).toEqual(
      expect.arrayContaining([
        "create",
        "deploy",
        "destroy",
        "status",
        "updateServiceConfig",
        "start",
        "stop",
        "restart",
        "logs",
        "getEvents",
        "getEnvVars",
        "updateEnvVars",
        "syncEnvVars",
      ]),
    );
  });

  it("maps wire-format `delete` → registered `destroy` handler (frontend backwards-compat)", async () => {
    const fallback = jest.fn(async () => "legacy");
    const result = await handle(dummyReq, dummyRes, { action: "delete", deploymentId: "d" }, fallback);

    expect(mockDestroyHandler).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(result).toBe("destroy-result");
  });

  it("registerDockerDeploymentAction adds a handler that handle() routes to", async () => {
    const customHandler = jest.fn(async () => "custom");
    registerDockerDeploymentAction("restart", customHandler);
    const fallback = jest.fn(async () => "legacy");

    const result = await handle(dummyReq, dummyRes, { action: "restart", deploymentId: "d" }, fallback);

    expect(customHandler).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(result).toBe("custom");
  });

  it("_resetDockerDeploymentActionsForTests clears the registry; handle() then delegates everything to the fallback", async () => {
    _resetDockerDeploymentActionsForTests();
    const fallback = jest.fn(async () => "legacy");

    await handle(dummyReq, dummyRes, { action: "create", deploymentId: "d" }, fallback);
    expect(mockCreateHandler).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

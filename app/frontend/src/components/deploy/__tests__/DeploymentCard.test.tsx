import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import DeploymentCard from "../DeploymentCard";

// Mock pronghornApi client — we only assert that the auto-refresh interval calls
// `pronghornApi.functions.invoke` once 10 s have elapsed for a transitional
// status (T054 / spec 006 US7).
const mockInvoke = vi.fn(async () => ({
  data: { success: true, data: { status: "pending" } },
  error: null,
}));
vi.mock("@/integrations/pronghorn-api/client", () => ({
  pronghornApi: {
    functions: { invoke: (...args: any[]) => (mockInvoke as any)(...args) },
  },
}));

// Children we do not need to exercise — they import other heavy modules.
vi.mock("../DeploymentDialog", () => ({
  default: () => null,
}));
vi.mock("../DeploymentLogsDialog", () => ({
  default: () => null,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeDeployment(overrides: Record<string, unknown> = {}): any {
  return {
    id: "dep-1",
    project_id: "proj-1",
    status: "pending",
    azure_container_app_name: "ca-test",
    deployment_platform: "pronghorn_cloud",
    deployment_name: "Test",
    url: null,
    workflow_run_url: null,
    last_failure_cause: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("DeploymentCard transitional auto-refresh (T054, US7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("schedules a 10s status-sync interval when status === 'pending' and Container App name is set", async () => {
    render(
      <DeploymentCard
        deployment={makeDeployment({ status: "pending" })}
        shareToken={null}
        onUpdate={() => {}}
      />,
    );

    // Initial render: no invoke yet
    expect(mockInvoke).not.toHaveBeenCalled();

    // Advance one interval tick
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [name, opts] = mockInvoke.mock.calls[0] as [string, any];
    expect(name).toBe("cloud-deployment");
    expect(opts?.body?.action).toBe("status");
    expect(opts?.body?.deploymentId).toBe("dep-1");
  });

  it("does NOT schedule the interval when the status is terminal", async () => {
    render(
      <DeploymentCard
        deployment={makeDeployment({ status: "running" })}
        shareToken={null}
        onUpdate={() => {}}
      />,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("does NOT schedule the interval when no Container App name is set yet", async () => {
    render(
      <DeploymentCard
        deployment={makeDeployment({
          status: "pending",
          azure_container_app_name: null,
        })}
        shareToken={null}
        onUpdate={() => {}}
      />,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

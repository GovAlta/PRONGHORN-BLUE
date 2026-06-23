/**
 * Tests for the deployment status machine guards.
 *
 * Covers every enum value × {deploy, destroy} pair documented in
 * data-model.md state machine (FR-009, FR-016, FR-018, US5 AS1, US5 AS2, US6 AS2).
 */
import {
  ConcurrentDeployError,
  assertCanAcceptDeploy,
  assertCanAcceptDestroy,
  isTerminal,
  isTransitional,
} from "../../../../services/deployment/docker/statusMachine";
import { TRANSITIONAL, TERMINAL } from "../../../../services/deployment/docker/types";

describe("isTransitional / isTerminal predicates", () => {
  it("classifies every enum value exactly once", () => {
    for (const s of TRANSITIONAL) {
      expect(isTransitional(s)).toBe(true);
      expect(isTerminal(s)).toBe(false);
    }
    for (const s of TERMINAL) {
      expect(isTerminal(s)).toBe(true);
      expect(isTransitional(s)).toBe(false);
    }
  });
});

describe("assertCanAcceptDeploy", () => {
  it.each(["pending", "building", "deploying"] as const)(
    "rejects transitional status %s with ConcurrentDeployError (FR-009, US5 AS1)",
    (s) => {
      expect(() => assertCanAcceptDeploy(s)).toThrow(ConcurrentDeployError);
    },
  );

  it("accepts 'failed' and requests failure attributes be cleared (US5 AS2)", () => {
    expect(assertCanAcceptDeploy("failed")).toEqual({ clearFailureAttrs: true });
  });

  it("accepts 'running' (redeploy) without clearing failure attrs", () => {
    expect(assertCanAcceptDeploy("running")).toEqual({ clearFailureAttrs: false });
  });

  it("accepts 'deleted' without clearing — orphan trade-off (CR-003)", () => {
    expect(assertCanAcceptDeploy("deleted")).toEqual({ clearFailureAttrs: false });
  });

  it("accepts 'stopped' without clearing", () => {
    expect(assertCanAcceptDeploy("stopped")).toEqual({ clearFailureAttrs: false });
  });
});

describe("assertCanAcceptDestroy", () => {
  it.each(["pending", "building", "deploying"] as const)(
    "rejects transitional status %s with ConcurrentDeployError (FR-009)",
    (s) => {
      expect(() => assertCanAcceptDestroy(s)).toThrow(ConcurrentDeployError);
    },
  );

  it("rejects 'deleted' — cannot re-destroy a deleted row (US6)", () => {
    expect(() => assertCanAcceptDestroy("deleted")).toThrow(ConcurrentDeployError);
  });

  it("accepts 'failed' and requests failure attributes be cleared (FR-018, US6 AS2)", () => {
    expect(assertCanAcceptDestroy("failed")).toEqual({ clearFailureAttrs: true });
  });

  it("accepts 'running' without clearing", () => {
    expect(assertCanAcceptDestroy("running")).toEqual({ clearFailureAttrs: false });
  });

  it("accepts 'stopped' without clearing", () => {
    expect(assertCanAcceptDestroy("stopped")).toEqual({ clearFailureAttrs: false });
  });
});

describe("ConcurrentDeployError", () => {
  it("carries the offending current status for the 409 response builder", () => {
    try {
      assertCanAcceptDeploy("building");
      fail("expected ConcurrentDeployError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConcurrentDeployError);
      expect((err as ConcurrentDeployError).currentStatus).toBe("building");
      expect((err as ConcurrentDeployError).name).toBe("ConcurrentDeployError");
    }
  });
});

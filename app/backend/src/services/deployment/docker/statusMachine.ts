/**
 * Status machine for Docker deployment rows.
 *
 * Single source of truth for the transitional/terminal split and the
 * "may this action proceed now?" decision documented in
 * `specs/006-docker-deploy-via-genapp-workflow/data-model.md` state machine.
 *
 * @example
 *   try {
 *     const { clearFailureAttrs } = assertCanAcceptDeploy(row.status);
 *     // ... proceed with dispatch; clear failure cols if requested
 *   } catch (err) {
 *     if (err instanceof ConcurrentDeployError) return res.status(409).json({ ... });
 *     throw err;
 *   }
 */
import {
  isTerminal,
  isTransitional,
  type DeploymentStatus,
} from "./types";

export { isTransitional, isTerminal };

/**
 * Thrown when an action would race against a transitional row, or when
 * an action is logically impossible (e.g., destroying an already-deleted row).
 */
export class ConcurrentDeployError extends Error {
  public readonly currentStatus: DeploymentStatus | string;
  constructor(currentStatus: DeploymentStatus | string, message?: string) {
    super(message ?? `Deployment already in progress (status=${currentStatus})`);
    this.name = "ConcurrentDeployError";
    this.currentStatus = currentStatus;
  }
}

export interface AssertResult {
  /**
   * When true, the caller's UPDATE that flips status → 'pending' MUST also
   * clear `last_failure_cause`, `workflow_run_url`, `workflow_run_id`, `url`.
   */
  clearFailureAttrs: boolean;
}

/**
 * Decide whether a deploy/create dispatch may proceed for the given current row status.
 *
 * - Transitional rows reject with `ConcurrentDeployError` (FR-009, US5 AS1).
 * - `failed` rows are accepted and request that failure attributes be cleared (US5 AS2).
 * - All other terminal rows (`running`, `stopped`, `deleted`) are accepted without clearing.
 */
export function assertCanAcceptDeploy(
  currentStatus: DeploymentStatus | string,
): AssertResult {
  if (isTransitional(currentStatus)) {
    throw new ConcurrentDeployError(currentStatus, "Deployment already in progress");
  }
  return { clearFailureAttrs: currentStatus === "failed" };
}

/**
 * Decide whether a destroy dispatch may proceed for the given current row status.
 *
 * - Transitional rows reject with `ConcurrentDeployError` (FR-009).
 * - `deleted` rows reject — cannot re-destroy a deleted row (US6).
 * - `failed` rows are accepted with `clearFailureAttrs: true` (FR-018, US6 AS2).
 * - `running` / `stopped` rows are accepted without clearing.
 */
export function assertCanAcceptDestroy(
  currentStatus: DeploymentStatus | string,
): AssertResult {
  if (currentStatus === "deleted") {
    throw new ConcurrentDeployError(currentStatus, "Deployment already deleted");
  }
  if (isTransitional(currentStatus)) {
    throw new ConcurrentDeployError(currentStatus, "Deployment already in progress");
  }
  return { clearFailureAttrs: currentStatus === "failed" };
}

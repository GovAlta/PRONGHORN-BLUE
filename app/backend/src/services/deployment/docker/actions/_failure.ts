/**
 * Shared failure-recording helpers for docker deployment actions (US4).
 *
 * Centralises the UPDATE + broadcast pattern used by `create`, `deploy`,
 * and `destroy` when a dispatch or pre-push step fails (FR-008).
 */
import db from "../../../../utils/database";
import { logger } from "../../../../utils/logger";
import { broadcast } from "../../../../websocket";

/**
 * Extract an HTTP status code from a dispatch error message of the form
 * `"Workflow dispatch failed: <STATUS> <BODY>"`. Returns `'unknown'` when
 * no status can be parsed (e.g., transport-level errors).
 */
export function formatDispatchHttpCause(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /Workflow dispatch failed: (\d{3})/.exec(msg);
  const code = m ? m[1] : "unknown";
  return `dispatch-http-${code}: ${msg}`;
}

/**
 * Persist `status='failed'` + `last_failure_cause` on the row and emit a
 * `deployment_refresh` broadcast carrying the new status and cause.
 */
export async function recordFailure(opts: {
  deploymentId: string;
  projectId: string | null;
  lastFailureCause: string;
}): Promise<void> {
  const { deploymentId, projectId, lastFailureCause } = opts;
  try {
    await db.query(
      `UPDATE project_deployments
       SET status = $1,
           last_failure_cause = $2,
           updated_at = NOW()
       WHERE id = $3`,
      ["failed", lastFailureCause, deploymentId],
    );
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "42703") {
      logger.warn(
        "[recordFailure] migration-008 columns missing — fallback UPDATE",
      );
      await db.query(
        `UPDATE project_deployments
         SET status = $1, updated_at = NOW()
         WHERE id = $2`,
        ["failed", deploymentId],
      );
    } else {
      throw err;
    }
  }

  if (projectId) {
    broadcast(`deployments-${projectId}`, "deployment_refresh", {
      action: "status_updated",
      deploymentId,
      status: "failed",
      lastFailureCause,
    });
  }
}

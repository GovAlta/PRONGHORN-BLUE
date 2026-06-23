/**
 * Shared helper to persist dispatch metadata on `project_deployments`.
 *
 * Attempts the full UPDATE including migration-008 columns
 * (`dispatched_by_user_id`, `dispatched_at`, `dispatched_action`,
 * `last_failure_cause`). If the columns don't exist yet (PG error 42703),
 * falls back to a minimal UPDATE that omits them.
 *
 * This allows the application code to be deployed before or after the
 * migration without breaking.
 *
 * @example
 *   await persistDispatchMetadata({
 *     deploymentId: "abc",
 *     appName: "my-app",
 *     resourceGroup: "rg-my-app",
 *     userId: "user-123",
 *     action: "create",
 *     clearFailureAttrs: false,
 *   });
 */
import db from "../../../../utils/database";
import { logger } from "../../../../utils/logger";

const LOG_PREFIX = "[dispatch-update]";

export interface DispatchUpdateOpts {
  deploymentId: string;
  /** Azure container app name (null for destroy which preserves existing). */
  appName?: string | null;
  /** Azure resource group (null for destroy which preserves existing). */
  resourceGroup?: string | null;
  /** User ID of the person who triggered the dispatch. */
  userId: string | null;
  /** The deployment action being dispatched. */
  action: "create" | "deploy" | "destroy";
  /** When true, also clears workflow_run_url + url (retry from failed). */
  clearFailureAttrs?: boolean;
}

/**
 * Persist dispatch metadata on the deployment row.
 * Falls back gracefully when migration-008 columns are missing.
 */
export async function persistDispatchMetadata(
  opts: DispatchUpdateOpts,
): Promise<void> {
  const {
    deploymentId,
    appName,
    resourceGroup,
    userId,
    action,
    clearFailureAttrs = false,
  } = opts;

  const extraClears = clearFailureAttrs
    ? ", workflow_run_url = NULL, url = NULL"
    : "";

  // Build the full query (with migration-008 columns).
  // For destroy, appName/resourceGroup are not updated.
  const hasResourceNames = appName != null && resourceGroup != null;

  try {
    if (hasResourceNames) {
      await db.query(
        `UPDATE project_deployments
         SET status = 'pending',
             azure_container_app_name = $1,
             azure_resource_group = $2,
             dispatched_by_user_id = $3,
             dispatched_at = NOW(),
             dispatched_action = $4,
             last_failure_cause = NULL,
             workflow_run_id = NULL${extraClears},
             updated_at = NOW()
         WHERE id = $5`,
        [appName, resourceGroup, userId, action, deploymentId],
      );
    } else {
      await db.query(
        `UPDATE project_deployments
         SET status = 'pending',
             dispatched_by_user_id = $1,
             dispatched_at = NOW(),
             dispatched_action = $2,
             last_failure_cause = NULL,
             workflow_run_id = NULL${extraClears},
             updated_at = NOW()
         WHERE id = $3`,
        [userId, action, deploymentId],
      );
    }
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "42703") {
      // Column doesn't exist yet — migration 008 hasn't been applied.
      // Fall back to a query without the dispatch-tracking columns.
      logger.warn(
        `${LOG_PREFIX} migration-008 columns missing — using fallback UPDATE`,
      );
      if (hasResourceNames) {
        await db.query(
          `UPDATE project_deployments
           SET status = 'pending',
               azure_container_app_name = $1,
               azure_resource_group = $2,
               workflow_run_id = NULL${extraClears},
               updated_at = NOW()
           WHERE id = $3`,
          [appName, resourceGroup, deploymentId],
        );
      } else {
        await db.query(
          `UPDATE project_deployments
           SET status = 'pending',
               workflow_run_id = NULL${extraClears},
               updated_at = NOW()
           WHERE id = $1`,
          [deploymentId],
        );
      }
    } else {
      throw err;
    }
  }
}

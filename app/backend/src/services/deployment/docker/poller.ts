/**
 * Docker deployment background poller (T019, US1).
 *
 * Periodically reconciles transitional deployment rows
 * (`status IN ('pending','building','deploying')`) against the GitHub
 * Actions API. Each row is processed inside a per-row transaction with
 * `pg_try_advisory_xact_lock(hashtextextended(id, 0))` so that multiple
 * API replicas can safely run the poller concurrently without
 * double-broadcasting or racing on the same row.
 *
 * Happy-path behavior only in this revision. Stall-window detection,
 * dispatch run-id recovery, and conclusion-failure attribution land
 * under US4.
 *
 * @example
 *   // index.ts
 *   startDockerDeploymentPoller();
 *   // … on shutdown
 *   stopDockerDeploymentPoller();
 */
import db from "../../../utils/database";
import { logger } from "../../../utils/logger";
import { resolveGitHubToken } from "../../../utils/githubAuth";
import { broadcast } from "../../../websocket";
import {
  pollWorkflowStatus,
  findWorkflowRunByAppId,
} from "./genappWorkflowClient";
import type { DeploymentStatus } from "./types";

const LOG_PREFIX = "[docker-deployment:poller]";
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_STALL_WINDOW_MS = 30 * 60 * 1000;
const RUN_ID_RECOVERY_WINDOW_MS = 60_000;

interface TransitionalRow {
  id: string;
  project_id: string;
  workflow_run_id: number | null;
  azure_container_app_name: string | null;
  azure_resource_group: string | null;
  dispatched_by_user_id: string | null;
  dispatched_action: string | null;
  dispatched_at: string | null;
  status: DeploymentStatus;
}

let timer: NodeJS.Timeout | null = null;
let isRunning = false;
let stallWindowMs = DEFAULT_STALL_WINDOW_MS;

/**
 * Run a single reconciliation pass. Exported so unit tests can drive ticks
 * deterministically without relying on real timers.
 */
export async function tickDockerDeploymentPoller(): Promise<void> {
  let selectRes;
  try {
    selectRes = await db.query(
      `SELECT id, project_id, workflow_run_id,
              azure_container_app_name, azure_resource_group,
              dispatched_by_user_id, dispatched_action, dispatched_at, status
         FROM project_deployments
        WHERE status IN ('pending','building','deploying')`,
    );
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "42703") {
      // Migration 008 columns don't exist yet — fall back to minimal SELECT.
      selectRes = await db.query(
        `SELECT id, project_id, workflow_run_id,
                azure_container_app_name, azure_resource_group,
                NULL AS dispatched_by_user_id, NULL AS dispatched_action,
                NULL AS dispatched_at, status
           FROM project_deployments
          WHERE status IN ('pending','building','deploying')`,
      );
    } else {
      throw err;
    }
  }

  const rows = (selectRes.rows ?? []) as TransitionalRow[];
  if (rows.length === 0) return;

  for (const row of rows) {
    await reconcileOne(row).catch((err) => {
      logger.error(
        `${LOG_PREFIX} reconcile error for ${row.id}: ${(err as Error).message}`,
      );
    });
  }
}

/** Mark the row failed inside the open per-row transaction and broadcast. */
async function markFailed(
  row: TransitionalRow,
  cause: string,
  runUrl: string | null = null,
): Promise<void> {
  const sets = ["status = $1", "last_failure_cause = $2", "updated_at = NOW()"];
  const params: unknown[] = ["failed", cause];
  if (runUrl) {
    sets.push(`workflow_run_url = $${params.length + 1}`);
    params.push(runUrl);
  }
  params.push(row.id);
  try {
    await db.query(
      `UPDATE project_deployments SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params,
    );
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "42703") {
      // Migration-008 columns missing — just set status.
      await db.query(
        "UPDATE project_deployments SET status = $1, updated_at = NOW() WHERE id = $2",
        ["failed", row.id],
      );
    } else {
      throw err;
    }
  }
  broadcast(`deployments-${row.project_id}`, "deployment_refresh", {
    action: "status_updated",
    deploymentId: row.id,
    status: "failed",
    lastFailureCause: cause,
    ...(runUrl ? { workflowRunUrl: runUrl } : {}),
  });
}

async function reconcileOne(row: TransitionalRow): Promise<void> {
  await db.query("BEGIN");
  try {
    const lockRes = await db.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS got",
      [row.id],
    );
    const got = lockRes.rows?.[0]?.got === true;
    if (!got) {
      // Another replica is reconciling this row this tick (US5, FR-017).
      logger.debug(`${LOG_PREFIX} skipped (lock not acquired) row=${row.id}`);
      return;
    }

    // T035 (US4): stall-window detection. When the row has been transitional
    // for longer than `stallWindowMs`, mark it failed regardless of what
    // GitHub reports — the dispatch never made meaningful progress.
    if (row.dispatched_at) {
      const dispatchedMs = Date.parse(row.dispatched_at);
      if (
        Number.isFinite(dispatchedMs) &&
        Date.now() - dispatchedMs > stallWindowMs
      ) {
        await markFailed(row, "stall-window-exceeded");
        logger.warn(`${LOG_PREFIX} ${row.id} stall-window exceeded → failed`);
        return;
      }
    }

    const resolvedGh = await resolveGitHubToken({
      userId: row.dispatched_by_user_id ?? undefined,
    });
    if (!resolvedGh) {
      // No token → cannot poll. Re-try next tick.
      return;
    }

    // T037 (US4, D-2): attempt run-id recovery when dispatch returned 0 but
    // we're still inside the 60s correlation window.
    let runId = row.workflow_run_id;
    if (!runId) {
      const recent =
        row.dispatched_at &&
        Date.now() - Date.parse(row.dispatched_at) <= RUN_ID_RECOVERY_WINDOW_MS;
      if (!recent) return;
      const resolved = await findWorkflowRunByAppId(row.id);
      if (!resolved) return;
      runId = resolved;
      await db.query(
        "UPDATE project_deployments SET workflow_run_id = $1, updated_at = NOW() WHERE id = $2",
        [runId, row.id],
      );
    }

    const result = await pollWorkflowStatus(runId, {
      containerAppName: row.azure_container_app_name ?? undefined,
      resourceGroup: row.azure_resource_group ?? undefined,
    });

    const isDestroyRow = row.dispatched_action === "destroy";

    // T036 (US4) / T044 (US6): workflow-conclusion-failure. Destroy gets a
    // distinct cause so operators can spot tear-down failures vs. build
    // failures in the same column.
    if (result.status === "failed") {
      const cause = isDestroyRow
        ? "workflow-conclusion-failure-destroy"
        : "workflow-conclusion-failure";
      await markFailed(row, cause, result.runUrl ?? null);
      logger.warn(
        `${LOG_PREFIX} ${row.id} workflow conclusion=failure → failed (${cause})`,
      );
      return;
    }

    // T025 (US2): destroy success means the resource is gone, not running.
    // pollWorkflowStatus maps conclusion=success → 'running' uniformly; we
    // override here when the row was dispatched for destroy.
    const observedStatus: DeploymentStatus =
      isDestroyRow && result.status === "running" ? "deleted" : result.status;
    const observedUrl = isDestroyRow ? null : result.url;

    if (observedStatus === row.status) {
      // No change → no UPDATE, no broadcast.
      return;
    }

    const sets: string[] = ["status = $1", "updated_at = NOW()"];
    const params: unknown[] = [observedStatus];
    let idx = 2;
    if (observedUrl) {
      sets.push(`url = $${idx}`);
      params.push(observedUrl);
      idx++;
    }
    if (observedStatus === "running") {
      sets.push("last_deployed_at = NOW()");
    }
    params.push(row.id);

    await db.query(
      `UPDATE project_deployments SET ${sets.join(", ")} WHERE id = $${idx}`,
      params,
    );

    broadcast(`deployments-${row.project_id}`, "deployment_refresh", {
      action: "status_updated",
      deploymentId: row.id,
      status: observedStatus,
      ...(observedUrl ? { url: observedUrl } : {}),
    });

    logger.info(
      `${LOG_PREFIX} ${row.id} ${row.status} → ${observedStatus}${observedUrl ? ` (${observedUrl})` : ""}`,
    );
  } finally {
    await db.query("COMMIT");
  }
}

/**
 * Start the background poller. Returns immediately. Idempotent — calling
 * twice is a no-op.
 *
 * @param opts.intervalMs Default 15s. Polls one tick per interval.
 */
export function startDockerDeploymentPoller(opts?: {
  intervalMs?: number;
  stallWindowMs?: number;
}): void {
  if (timer) {
    logger.info(`${LOG_PREFIX} already running; ignoring start request`);
    return;
  }
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  stallWindowMs = opts?.stallWindowMs ?? DEFAULT_STALL_WINDOW_MS;

  const runTick = async (): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    try {
      await tickDockerDeploymentPoller();
    } catch (err) {
      logger.error(`${LOG_PREFIX} tick error: ${(err as Error).message}`);
    } finally {
      isRunning = false;
    }
  };

  timer = setInterval(runTick, intervalMs);
  logger.info(`${LOG_PREFIX} started (intervalMs=${intervalMs})`);
}

/**
 * Stop the background poller. Safe to call when never started.
 */
export function stopDockerDeploymentPoller(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info(`${LOG_PREFIX} stopped`);
}

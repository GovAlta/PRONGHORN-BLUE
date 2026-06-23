/**
 * Database Migration Runner
 *
 * Runs SQL migration files at API startup before the server listens.
 * Migrations are idempotent (CREATE TABLE IF NOT EXISTS) and run in order.
 * A schema_migrations table tracks which files have been applied.
 */
import fs from "fs";
import path from "path";
import { query, getClient } from "./utils/database";
import { logger } from "./utils/logger";

/**
 * Only files whose name begins with a numeric version prefix (e.g. `001_`,
 * `008_`) are treated as schema migrations. Files without a numeric prefix
 * are ignored, leaving room for non-schema scripts (READMEs, ad-hoc DBA
 * snippets) to live alongside migrations without polluting the batch.
 */
const MIGRATION_FILENAME_PATTERN = /^\d+.*\.sql$/;

/**
 * Snapshot of the most recent migration run, exposed via {@link getMigrationStatus}
 * so health checks can surface a half-migrated or failed schema instead of the
 * problem staying silent.
 */
export interface MigrationStatus {
  state: "idle" | "running" | "complete" | "failed";
  appliedCount: number;
  applied: string[];
  pending: string[];
  failed?: {
    file: string;
    code?: string;
    message?: string;
    detail?: string;
  };
  lastRunAt?: string;
}

let migrationStatus: MigrationStatus = {
  state: "idle",
  appliedCount: 0,
  applied: [],
  pending: [],
};

/**
 * Return a snapshot of the last migration run for health/observability.
 *
 * @returns The current {@link MigrationStatus}.
 * @example
 *   const status = getMigrationStatus();
 *   if (status.state === "failed") { /* report degraded *\/ }
 */
export function getMigrationStatus(): MigrationStatus {
  return migrationStatus;
}

/**
 * Resolve the migrations directory by probing known locations in priority
 * order and returning the first that exists. This makes startup migrations
 * "just work" across every runtime context without depending on NODE_ENV:
 *
 *   1. `MIGRATIONS_DIR` env override (explicit escape hatch).
 *   2. `<dir>/../migrations` — the container layout. The Dockerfile copies
 *      migration files next to `dist/`, so from `/app/dist` this is
 *      `/app/migrations`.
 *   3. `<repo-root>/infra/migrations` — local dev (ts-node on `src/`) and
 *      locally compiled `dist/`. Both sit three levels below the repo root
 *      (`app/backend/{src,dist}`), so the same relative walk works for each.
 *
 * @returns Absolute path to the migrations directory, or `null` if none found.
 * @example
 *   const dir = resolveMigrationsDir(); // e.g. "/app/migrations"
 */
function resolveMigrationsDir(): string | null {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(__dirname, "..", "migrations"),
    path.resolve(__dirname, "..", "..", "..", "infra", "migrations"),
  ].filter((dir): dir is string => Boolean(dir));

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

const MIGRATIONS_DIR = resolveMigrationsDir();
/**
 * Run all pending SQL migrations, one transaction per file, in version order.
 *
 * Behaviour (intentional, see docs/refactor):
 *  - Only numerically-prefixed `.sql` files are considered — see
 *    {@link MIGRATION_FILENAME_PATTERN}.
 *  - Each file runs inside its own BEGIN/COMMIT; a failure rolls that file back
 *    and aborts startup with the exact file + SQLSTATE logged (fail fast).
 *  - Already-applied files (recorded in `schema_migrations`) are NOT re-run.
 *  - The run result is published via {@link getMigrationStatus} for /health.
 *
 * @throws Re-throws the underlying error after recording {@link MigrationStatus}
 *   as `failed`, so the caller can decide whether to surface or continue.
 * @example
 *   await runMigrations();
 */
export async function runMigrations(): Promise<MigrationStatus> {
  migrationStatus = {
    state: "running",
    appliedCount: 0,
    applied: [],
    pending: [],
    lastRunAt: new Date().toISOString(),
  };

  // Ensure tracking table exists (schema matches 001_full_schema.sql definition)
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Handle migration from old schema (filename column) to new (version column)
  try {
    const colCheck = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'schema_migrations' AND column_name = 'filename'
    `);
    if (colCheck.rows.length > 0) {
      await query("DROP TABLE schema_migrations");
      await query(`
        CREATE TABLE schema_migrations (
          version TEXT PRIMARY KEY,
          executed_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    }
  } catch {
    // ignore — table is fine
  }

  // Get already-applied migrations
  const applied = await query("SELECT version FROM schema_migrations");
  const appliedSet = new Set(
    applied.rows.map((r: { version: string }) => r.version),
  );

  if (!MIGRATIONS_DIR) {
    logger.warn(
      "Migrations directory not found in any known location, skipping migrations. " +
        "Set MIGRATIONS_DIR to point at the SQL migration files.",
    );
    migrationStatus = { ...migrationStatus, state: "complete" };
    return migrationStatus;
  }

  logger.info("Running database migrations", { dir: MIGRATIONS_DIR });

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => MIGRATION_FILENAME_PATTERN.test(f))
    .sort();

  // Surface duplicate numeric prefixes — ordering between same-prefix files
  // relies on the rest of the filename and is fragile.
  const prefixSeen = new Map<string, string>();
  for (const file of files) {
    const prefix = (file.match(/^\d+/) || [""])[0];
    const existing = prefixSeen.get(prefix);
    if (existing) {
      logger.warn(
        `Duplicate migration prefix "${prefix}" (${existing}, ${file}); ` +
          "ordering is filename-dependent — consider renumbering.",
      );
    } else {
      prefixSeen.set(prefix, file);
    }
  }

  const pending = files.filter((f) => !appliedSet.has(f));
  migrationStatus = {
    ...migrationStatus,
    applied: files.filter((f) => appliedSet.has(f)),
    pending,
  };

  if (pending.length === 0) {
    logger.info("All migrations already applied");
    migrationStatus = { ...migrationStatus, state: "complete" };
    return migrationStatus;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    logger.info(`Applying migration: ${file}`);

    const client = await getClient();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
        [file],
      );
      await client.query("COMMIT");
      migrationStatus.applied.push(file);
      migrationStatus.appliedCount++;
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => {});
      const pgErr = err as {
        message?: string;
        code?: string;
        detail?: string;
        position?: string;
      };

      // Fail fast on ANY error. A duplicate-object error (42P07/42710) here is
      // NOT proof the migration was applied — for a multi-statement file the
      // whole transaction just rolled back, so its other objects were never
      // created. Recording it as applied would silently leave the schema
      // incomplete (see the 008 "relation users does not exist" incident).
      // Migrations must be idempotent; a genuine duplicate means the DB is in
      // an inconsistent state that a human needs to look at.
      logger.error(`Migration ${file} failed — aborting startup migrations`, {
        message: pgErr.message,
        code: pgErr.code,
        detail: pgErr.detail,
        position: pgErr.position,
      });
      migrationStatus = {
        ...migrationStatus,
        state: "failed",
        failed: {
          file,
          code: pgErr.code,
          message: pgErr.message,
          detail: pgErr.detail,
        },
      };
      throw err;
    } finally {
      client.release();
    }
  }

  migrationStatus = {
    ...migrationStatus,
    state: "complete",
    pending: [],
  };
  logger.info(`Applied ${migrationStatus.appliedCount} migration(s)`);
  return migrationStatus;
}

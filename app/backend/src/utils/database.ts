/**
 * PostgreSQL Database Connection Pool
 */
import { Pool, PoolClient, QueryResult } from "pg";
import { logger } from "./logger";

let pool: Pool | null = null;
let activePort: number | null = null;
let poolInitPromise: Promise<Pool> | null = null;

/**
 * Parse a port value and return a safe default when invalid.
 *
 * @example
 * const port = parsePortOrDefault(process.env.POSTGRES_PORT, 5432)
 */
function parsePortOrDefault(portValue: string | undefined, defaultPort: number): number {
  const parsedPort = Number.parseInt(portValue || "", 10);
  if (Number.isNaN(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    return defaultPort;
  }

  return parsedPort;
}

/**
 * Build an ordered list of candidate PostgreSQL ports.
 * Defaults to 5432 first, then tries configured/custom and common fallback 5433.
 *
 * @example
 * const ports = getCandidatePorts()
 */
function getCandidatePorts(): number[] {
  const configuredPort = parsePortOrDefault(process.env.POSTGRES_PORT, 5432);
  const candidatePorts = [5432, configuredPort, 5433];

  return Array.from(new Set(candidatePorts));
}

/**
 * Determine whether a database error is likely related to endpoint/port mismatch.
 *
 * @example
 * if (isConnectionOrTargetError(error)) { ... }
 */
function isConnectionOrTargetError(error: unknown): boolean {
  const errorCode = (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT", "3D000", "28P01"].includes(errorCode || "");
}

/**
 * Create a PostgreSQL connection pool for a specific port.
 *
 * @example
 * const candidatePool = createPoolForPort(5432)
 */
function createPoolForPort(port: number): Pool {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PostgreSQL port: ${port}`);
  }

  const candidatePool = new Pool({
    host: process.env.POSTGRES_HOST,
    port,
    database: process.env.POSTGRES_DATABASE || "pronghorn",
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  candidatePool.on("connect", () => {
    logger.debug("New client connected to PostgreSQL pool", { port });
  });

  candidatePool.on("error", (error) => {
    logger.error("Unexpected error on idle PostgreSQL client", { error, port });
  });

  return candidatePool;
}

/**
 * Initialize and return an active PostgreSQL pool.
 * Tries candidate ports in order and keeps the first healthy one.
 *
 * @example
 * const dbPool = await getPool()
 */
async function getPool(): Promise<Pool> {
  if (pool) {
    return pool;
  }

  if (poolInitPromise) {
    return poolInitPromise;
  }

  poolInitPromise = (async () => {
    const candidatePorts = getCandidatePorts();
    let lastError: unknown;

    for (const candidatePort of candidatePorts) {
      const candidatePool = createPoolForPort(candidatePort);

      try {
        await candidatePool.query("SELECT 1");
        pool = candidatePool;
        activePort = candidatePort;

        if (candidatePort !== 5432) {
          logger.warn("PostgreSQL fallback port activated at runtime", { port: candidatePort, candidatePorts });
        } else {
          logger.info("PostgreSQL connected on default port 5432");
        }

        return candidatePool;
      } catch (error) {
        lastError = error;
        await candidatePool.end().catch(() => undefined);
        logger.warn("PostgreSQL connection attempt failed", {
          port: candidatePort,
          code: (error as { code?: string })?.code,
          message: (error as { message?: string })?.message,
        });

        if (!isConnectionOrTargetError(error)) {
          break;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Unable to initialize PostgreSQL connection on candidate ports.");
  })();

  try {
    return await poolInitPromise;
  } finally {
    poolInitPromise = null;
  }
}

/**
 * Reset active pool so the next operation can re-resolve target port.
 *
 * @example
 * await resetPool()
 */
async function resetPool(): Promise<void> {
  const currentPool = pool;
  pool = null;
  activePort = null;

  if (currentPool) {
    await currentPool.end().catch(() => undefined);
  }
}

/**
 * Execute a query with parameters
 */
export async function query(text: string, params?: any[]): Promise<QueryResult> {
  if (!text || !text.trim()) {
    throw new Error("Query text is required.");
  }

  const start = Date.now();
  const activePool = await getPool();
  try {
    const result = await activePool.query(text, params);
    const duration = Date.now() - start;
    logger.debug(`Query executed in ${duration}ms`, {
      text: text.substring(0, 100),
      rowCount: result.rowCount,
      port: activePort,
    });
    return result;
  } catch (error) {
    if (isConnectionOrTargetError(error)) {
      logger.warn("Database query failed due to connection/target issue. Resetting pool for automatic port re-resolution.", {
        code: (error as { code?: string })?.code,
        port: activePort,
      });
      await resetPool();
    }

    logger.error("Database query error", { error, text: text.substring(0, 100), port: activePort });
    throw error;
  }
}

/**
 * Get a client from the pool for transactions
 */
export async function getClient(): Promise<PoolClient> {
  const activePool = await getPool();
  return activePool.connect();
}

/**
 * Execute a transaction with automatic rollback on error
 */
export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (typeof callback !== "function") {
    throw new Error("Transaction callback is required.");
  }

  const activePool = await getPool();
  const client = await activePool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Health check for database connection
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const activePool = await getPool();
    await activePool.query("SELECT 1");
    return true;
  } catch (error) {
    logger.error("Database health check failed", error);
    return false;
  }
}

/**
 * Return the currently active PostgreSQL port selected by runtime failover.
 *
 * @example
 * const port = getActiveDbPort()
 */
export function getActiveDbPort(): number | null {
  return activePort;
}

/**
 * Close all database connections (for graceful shutdown)
 */
export async function close(): Promise<void> {
  await resetPool();
  await closePoolCache();
  logger.info("Database pool closed");
}

// ============================================================================
// Pool Factory — keyed pool cache for per-database connections
// ============================================================================

/**
 * Server identifier for dual-server routing.
 * - `'app'`      — Pronghorn Application database (system metadata)
 * - `'genapps'`  — Pronghorn Generated Applications database (per-project DBs)
 */
export type PoolServer = "app" | "genapps";

/**
 * Target descriptor for the pool factory. Identifies which server and database
 * to connect to.
 *
 * @example
 * const target: PoolTarget = { database: 'proj_abc123', server: 'genapps' }
 */
export interface PoolTarget {
  /** Database name on the target PostgreSQL server */
  database: string;
  /**
   * Which server to connect to.
   * - `'app'` (default) uses POSTGRES_* env vars (Pronghorn Application server)
   * - `'genapps'` uses POSTGRES_GENAPPS_* env vars (Pronghorn Generated Applications server),
   *    falling back to POSTGRES_* when the GENAPPS vars are not set.
   */
  server?: PoolServer;
}

const poolCache = new Map<string, Pool>();

/**
 * Compute a stable cache key for a pool target.
 *
 * @example
 * const key = poolCacheKey({ database: 'proj_abc', server: 'genapps' }) // => 'genapps:proj_abc'
 */
function poolCacheKey(target: PoolTarget): string {
  const server = target.server || "app";
  return `${server}:${target.database}`;
}

/**
 * Resolve connection parameters for the given server target.
 * For `'genapps'`, reads POSTGRES_GENAPPS_* env vars and falls back to
 * POSTGRES_* when unset, maintaining backward compatibility with single-server
 * setups.
 */
function resolveServerConfig(server: PoolServer): {
  host: string | undefined;
  port: number;
  user: string | undefined;
  password: string | undefined;
  ssl: boolean;
} {
  if (server === "genapps") {
    return {
      host: process.env.POSTGRES_GENAPPS_HOST || process.env.POSTGRES_HOST,
      port: parsePortOrDefault(
        process.env.POSTGRES_GENAPPS_PORT || process.env.POSTGRES_PORT,
        5432,
      ),
      user: process.env.POSTGRES_GENAPPS_USER || process.env.POSTGRES_USER,
      password: process.env.POSTGRES_GENAPPS_PASSWORD || process.env.POSTGRES_PASSWORD,
      ssl: (process.env.POSTGRES_GENAPPS_SSL ?? process.env.POSTGRES_SSL) === "true",
    };
  }

  // Default: Pronghorn Application server
  return {
    host: process.env.POSTGRES_HOST,
    port: getActiveDbPort() || parsePortOrDefault(process.env.POSTGRES_PORT, 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    ssl: process.env.POSTGRES_SSL === "true",
  };
}

/**
 * Get or create a connection pool for the specified target database.
 * Pools are cached by server + database name and reused for identical targets.
 *
 * @example
 * const pool = await getPoolForTarget({ database: 'proj_abc123', server: 'genapps' })
 * const result = await pool.query('SELECT 1')
 */
export async function getPoolForTarget(target: PoolTarget): Promise<Pool> {
  if (!target?.database) {
    throw new Error("PoolTarget.database is required");
  }

  const key = poolCacheKey(target);

  const existing = poolCache.get(key);
  if (existing) {
    return existing;
  }

  const server = target.server || "app";
  const config = resolveServerConfig(server);

  const newPool = new Pool({
    host: config.host,
    port: config.port,
    database: target.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });

  newPool.on("error", (err) => {
    logger.error(`Pool error for database "${target.database}" on ${server} server`, err);
  });

  poolCache.set(key, newPool);
  return newPool;
}

/**
 * Execute a query against a specific target database using the pool factory.
 *
 * @example
 * const result = await queryWithPoolTarget({ database: 'proj_abc', server: 'genapps' }, 'SELECT * FROM users', [])
 */
export async function queryWithPoolTarget(target: PoolTarget, text: string, params?: any[]): Promise<QueryResult> {
  if (!text || !text.trim()) {
    throw new Error("Query text is required.");
  }
  const targetPool = await getPoolForTarget(target);
  return targetPool.query(text, params);
}

/**
 * Get a client from the pool factory for transaction work against a target database.
 *
 * @example
 * const client = await getPoolClient({ database: 'proj_abc', server: 'genapps' })
 * try { await client.query('BEGIN'); ... } finally { client.release(); }
 */
export async function getPoolClient(target: PoolTarget): Promise<PoolClient> {
  const targetPool = await getPoolForTarget(target);
  return targetPool.connect();
}

/**
 * Close all pools in the factory cache. Called during graceful shutdown.
 */
async function closePoolCache(): Promise<void> {
  const pools = Array.from(poolCache.values());
  poolCache.clear();
  await Promise.all(pools.map(p => p.end().catch(() => undefined)));
}

export default {
  query,
  getClient,
  transaction,
  healthCheck,
  getActiveDbPort,
  close,
  getPoolForTarget,
  queryWithPoolTarget,
  getPoolClient,
};

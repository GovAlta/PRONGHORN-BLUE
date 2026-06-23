/**
 * Azure PostgreSQL Migration Runner
 * Executes SQL migration files in order against the database
 */
import { Pool, PoolClient } from "pg";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

interface MigrationOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  migrationsPath?: string;
}

interface MigrationResult {
  success: boolean;
  filesExecuted: string[];
  errors: string[];
  duration: number;
}

interface MigrationRecord {
  filename: string;
  executed_at: Date;
  execution_time_ms: number;
}

interface MigrationStatus {
  pending: string[];
  executed: MigrationRecord[];
}

/**
 * Azure PostgreSQL Migration Runner
 * Executes SQL migration files in order against the database
 */
export class MigrationRunner {
  private options: Required<MigrationOptions>;
  private pool: Pool | null = null;

  constructor(options: MigrationOptions = {}) {
    this.options = {
      host: options.host || process.env.POSTGRES_HOST || "localhost",
      port: options.port || parseInt(process.env.POSTGRES_PORT || "5432"),
      database: options.database || process.env.POSTGRES_DB || "postgres",
      user: options.user || process.env.POSTGRES_USER || "postgres",
      password: options.password || process.env.POSTGRES_PASSWORD || "",
      ssl: options.ssl ?? process.env.POSTGRES_SSL === "true",
      migrationsPath: options.migrationsPath || path.join(__dirname, "../../migrations"),
    };
  }

  /**
   * Initialize database connection pool
   */
  async connect(): Promise<void> {
    this.pool = new Pool({
      host: this.options.host,
      port: this.options.port,
      database: this.options.database,
      user: this.options.user,
      password: this.options.password,
      ssl: this.options.ssl ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000,
    });

    // Test connection
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1");
      console.log(`✅ Connected to PostgreSQL: ${this.options.host}/${this.options.database}`);
    } finally {
      client.release();
    }
  }

  /**
   * Close database connection pool
   */
  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      console.log("🔌 Disconnected from PostgreSQL");
    }
  }

  /**
   * Create migrations tracking table if it doesn't exist
   */
  private async createMigrationsTable(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        checksum TEXT,
        execution_time_ms INTEGER
      );
    `);
  }

  /**
   * Get list of already executed migrations
   */
  private async getExecutedMigrations(client: PoolClient): Promise<Set<string>> {
    const result = await client.query("SELECT filename FROM public._migrations ORDER BY executed_at");
    return new Set(result.rows.map((row: any) => row.filename));
  }

  /**
   * Get migration files from the migrations directory
   */
  private getMigrationFiles(): string[] {
    if (!fs.existsSync(this.options.migrationsPath)) {
      console.warn(`⚠️ Migrations path not found: ${this.options.migrationsPath}`);
      return [];
    }

    return fs.readdirSync(this.options.migrationsPath)
      .filter(file => file.endsWith(".sql"))
      .sort(); // Sort alphabetically (migrations should be prefixed with numbers)
  }

  /**
   * Execute a single migration file
   */
  private async executeMigration(client: PoolClient, filename: string): Promise<number> {
    const filePath = path.join(this.options.migrationsPath, filename);
    const sql = fs.readFileSync(filePath, "utf-8");

    const startTime = Date.now();
    await client.query(sql);
    const duration = Date.now() - startTime;

    // Simple checksum (MD5 of content)
    const checksum = crypto.createHash("md5").update(sql).digest("hex");

    // Record migration
    await client.query(
      "INSERT INTO public._migrations (filename, checksum, execution_time_ms) VALUES ($1, $2, $3)",
      [filename, checksum, duration]
    );

    return duration;
  }

  /**
   * Run all pending migrations
   */
  async runMigrations(): Promise<MigrationResult> {
    const startTime = Date.now();
    const filesExecuted: string[] = [];
    const errors: string[] = [];

    if (!this.pool) {
      await this.connect();
    }

    const client = await this.pool!.connect();

    try {
      // Start transaction
      await client.query("BEGIN");

      // Ensure migrations table exists
      await this.createMigrationsTable(client);

      // Get executed migrations
      const executedMigrations = await this.getExecutedMigrations(client);

      // Get all migration files
      const migrationFiles = this.getMigrationFiles();
      console.log(`📁 Found ${migrationFiles.length} migration files`);
      console.log(`✅ Already executed: ${executedMigrations.size} migrations`);

      // Execute pending migrations
      for (const filename of migrationFiles) {
        if (executedMigrations.has(filename)) {
          console.log(`⏭️  Skipping ${filename} (already executed)`);
          continue;
        }

        console.log(`🚀 Executing ${filename}...`);

        try {
          const duration = await this.executeMigration(client, filename);
          filesExecuted.push(filename);
          console.log(`✅ Completed ${filename} (${duration}ms)`);
        } catch (error: any) {
          errors.push(`${filename}: ${error.message}`);
          console.error(`❌ Failed ${filename}: ${error.message}`);
          throw error; // Re-throw to trigger rollback
        }
      }

      // Commit transaction
      await client.query("COMMIT");
      console.log("\n✅ All migrations completed successfully!");
    } catch (error: any) {
      // Rollback on error
      await client.query("ROLLBACK");
      console.error(`\n❌ Migration failed, changes rolled back: ${error.message}`);
      errors.push(`Transaction rollback: ${error.message}`);
    } finally {
      client.release();
    }

    return {
      success: errors.length === 0,
      filesExecuted,
      errors,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Get migration status
   */
  async getStatus(): Promise<MigrationStatus> {
    if (!this.pool) {
      await this.connect();
    }

    const client = await this.pool!.connect();

    try {
      // Ensure migrations table exists
      await this.createMigrationsTable(client);

      // Get executed migrations
      const executedResult = await client.query(
        "SELECT filename, executed_at, execution_time_ms FROM public._migrations ORDER BY executed_at"
      );
      const executed: MigrationRecord[] = executedResult.rows;
      const executedSet = new Set(executed.map((row) => row.filename));

      // Get all migration files
      const migrationFiles = this.getMigrationFiles();
      const pending = migrationFiles.filter(f => !executedSet.has(f));

      return { pending, executed };
    } finally {
      client.release();
    }
  }
}

// CLI runner
if (require.main === module) {
  const runner = new MigrationRunner();
  const command = process.argv[2] || "run";

  (async () => {
    try {
      switch (command) {
        case "run":
          const result = await runner.runMigrations();
          console.log("\n📊 Migration Summary:");
          console.log(`   Files executed: ${result.filesExecuted.length}`);
          console.log(`   Duration: ${result.duration}ms`);
          if (result.errors.length > 0) {
            console.log(`   Errors: ${result.errors.join(", ")}`);
          }
          process.exit(result.success ? 0 : 1);
          break;

        case "status":
          const status = await runner.getStatus();
          console.log("\n📊 Migration Status:");
          console.log(`\n✅ Executed (${status.executed.length}):`);
          status.executed.forEach(m => {
            console.log(`   - ${m.filename} (${new Date(m.executed_at).toISOString()}, ${m.execution_time_ms}ms)`);
          });
          console.log(`\n⏳ Pending (${status.pending.length}):`);
          status.pending.forEach(f => console.log(`   - ${f}`));
          process.exit(0);
          break;

        default:
          console.log("Usage: migrate.ts [run|status]");
          process.exit(1);
      }
    } catch (error: any) {
      console.error("Migration error:", error.message);
      process.exit(1);
    } finally {
      await runner.disconnect();
    }
  })();
}

export default MigrationRunner;

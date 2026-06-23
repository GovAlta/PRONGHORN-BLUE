/**
 * Jest global setup — runs before each test file.
 * Sets required environment variables that modules check at import time.
 */

// Auth middleware requires ENTRA_TENANT_ID at module load
process.env.ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID || "test-tenant-id";
process.env.ENTRA_CLIENT_ID = process.env.ENTRA_CLIENT_ID || "test-client-id";

// Prevent database connections during unit tests
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || "localhost";
process.env.POSTGRES_DATABASE = process.env.POSTGRES_DATABASE || "test";
process.env.POSTGRES_USER = process.env.POSTGRES_USER || "test";
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "test";

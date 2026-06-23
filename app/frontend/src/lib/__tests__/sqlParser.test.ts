import { describe, it, expect } from "vitest";
import {
  splitSqlStatements,
  parseDDLStatement,
  extractDDLStatements,
  containsDDL,
} from "../sqlParser";

// =============================================================================
// splitSqlStatements
// =============================================================================

describe("splitSqlStatements", () => {
  it("splits simple statements on semicolons", () => {
    const result = splitSqlStatements("SELECT 1; SELECT 2;");
    expect(result).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("handles trailing statement without semicolon", () => {
    const result = splitSqlStatements("SELECT 1; SELECT 2");
    expect(result).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores empty statements", () => {
    const result = splitSqlStatements("SELECT 1;; ;SELECT 2;");
    expect(result).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("returns empty array for empty input", () => {
    expect(splitSqlStatements("")).toEqual([]);
    expect(splitSqlStatements("   ")).toEqual([]);
  });

  it("preserves string literals containing semicolons", () => {
    const result = splitSqlStatements("SELECT 'hello;world'; SELECT 2;");
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("'hello;world'");
  });

  it("handles escaped quotes inside string literals", () => {
    const result = splitSqlStatements("SELECT 'it''s'; SELECT 2;");
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("'it''s'");
  });

  it("preserves double-quoted identifiers with semicolons", () => {
    const result = splitSqlStatements('SELECT "tricky;name"; SELECT 2;');
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('"tricky;name"');
  });

  it("handles line comments", () => {
    const sql = `SELECT 1; -- this is a comment; not a statement
SELECT 2;`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("SELECT 1");
  });

  it("handles block comments", () => {
    const sql = "SELECT /* a;b */ 1; SELECT 2;";
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("/* a;b */");
  });

  it("handles nested block comments", () => {
    const sql = "SELECT /* outer /* inner */ still outer */ 1; SELECT 2;";
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
  });

  it("preserves dollar-quoted strings containing semicolons", () => {
    const sql = `CREATE FUNCTION test() RETURNS void AS $$
BEGIN
  RAISE NOTICE 'hello;world';
END;
$$ LANGUAGE plpgsql; SELECT 1;`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("RAISE NOTICE");
  });

  it("preserves tagged dollar-quoted strings", () => {
    const sql = `CREATE FUNCTION test() RETURNS void AS $body$
BEGIN
  x := 'a;b';
END;
$body$ LANGUAGE plpgsql; SELECT 1;`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("$body$");
  });

  it("handles multi-line SQL with whitespace", () => {
    const sql = `
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        name TEXT
      );
      
      INSERT INTO users VALUES ('abc', 'Alice');
    `;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("CREATE TABLE");
    expect(result[1]).toContain("INSERT INTO");
  });
});

// =============================================================================
// parseDDLStatement
// =============================================================================

describe("parseDDLStatement", () => {
  it("returns null for non-DDL statements", () => {
    expect(parseDDLStatement("SELECT * FROM users")).toBeNull();
    expect(parseDDLStatement("INSERT INTO users VALUES (1)")).toBeNull();
    expect(parseDDLStatement("UPDATE users SET name = 'x'")).toBeNull();
    expect(parseDDLStatement("DELETE FROM users")).toBeNull();
  });

  it("parses CREATE TABLE statements", () => {
    const result = parseDDLStatement("CREATE TABLE public.users (id INT)");
    expect(result).not.toBeNull();
    expect(result!.statementType).toBe("CREATE");
    expect(result!.objectType).toBe("TABLE");
    expect(result!.objectName).toBe("users");
    expect(result!.objectSchema).toBe("public");
    expect(result!.isDDL).toBe(true);
  });

  it("parses CREATE TABLE IF NOT EXISTS", () => {
    const result = parseDDLStatement("CREATE TABLE IF NOT EXISTS users (id INT)");
    expect(result).not.toBeNull();
    expect(result!.statementType).toBe("CREATE");
    expect(result!.objectName).toBe("users");
  });

  it("parses CREATE INDEX", () => {
    const result = parseDDLStatement("CREATE INDEX idx_name ON users(name)");
    expect(result).not.toBeNull();
    expect(result!.statementType).toBe("CREATE");
    expect(result!.objectType).toBe("INDEX");
    expect(result!.objectName).toBe("idx_name");
  });

  it("parses CREATE UNIQUE INDEX", () => {
    const result = parseDDLStatement("CREATE UNIQUE INDEX idx_email ON users(email)");
    expect(result).not.toBeNull();
    expect(result!.objectType).toBe("INDEX");
  });

  it("parses CREATE VIEW", () => {
    const result = parseDDLStatement("CREATE VIEW user_view AS SELECT * FROM users");
    expect(result).not.toBeNull();
    expect(result!.objectType).toBe("VIEW");
    expect(result!.objectName).toBe("user_view");
  });

  it("parses CREATE OR REPLACE FUNCTION", () => {
    const result = parseDDLStatement("CREATE OR REPLACE FUNCTION my_func() RETURNS void");
    expect(result).not.toBeNull();
    expect(result!.statementType).toBe("CREATE");
    expect(result!.objectType).toBe("FUNCTION");
    expect(result!.objectName).toBe("my_func");
  });

  it("parses ALTER TABLE", () => {
    const result = parseDDLStatement("ALTER TABLE users ADD COLUMN age INT");
    expect(result).not.toBeNull();
    expect(result!.statementType).toBe("ALTER");
    expect(result!.objectType).toBe("TABLE");
    expect(result!.objectName).toBe("users");
  });

  it("parses DROP TABLE", () => {
    const result = parseDDLStatement("DROP TABLE IF EXISTS public.users");
    expect(result).not.toBeNull();
    expect(result!.statementType).toBe("DROP");
    expect(result!.objectType).toBe("TABLE");
    expect(result!.objectName).toBe("users");
    expect(result!.objectSchema).toBe("public");
  });

  it("parses CREATE EXTENSION", () => {
    const result = parseDDLStatement('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    expect(result).not.toBeNull();
    expect(result!.objectType).toBe("EXTENSION");
  });

  it("parses GRANT statements", () => {
    const result = parseDDLStatement("GRANT SELECT ON users TO readonly_role");
    expect(result).not.toBeNull();
    expect(result!.statementType).toBe("GRANT");
  });

  it("parses CREATE SCHEMA", () => {
    const result = parseDDLStatement("CREATE SCHEMA IF NOT EXISTS myschema");
    expect(result).not.toBeNull();
    expect(result!.objectType).toBe("SCHEMA");
    expect(result!.objectName).toBe("myschema");
  });

  it("parses TRUNCATE TABLE", () => {
    const result = parseDDLStatement("TRUNCATE TABLE users");
    expect(result).not.toBeNull();
    expect(result!.statementType).toBe("TRUNCATE");
  });

  it("parses CREATE TRIGGER", () => {
    const result = parseDDLStatement(
      "CREATE TRIGGER my_trigger BEFORE INSERT ON users FOR EACH ROW"
    );
    expect(result).not.toBeNull();
    expect(result!.objectType).toBe("TRIGGER");
    expect(result!.objectName).toBe("my_trigger");
  });

  it("parses CREATE TYPE", () => {
    const result = parseDDLStatement("CREATE TYPE mood AS ENUM ('happy', 'sad')");
    expect(result).not.toBeNull();
    expect(result!.objectType).toBe("TYPE");
    expect(result!.objectName).toBe("mood");
  });
});

// =============================================================================
// extractDDLStatements
// =============================================================================

describe("extractDDLStatements", () => {
  it("extracts only DDL from mixed SQL", () => {
    const sql = `
      CREATE TABLE users (id INT);
      INSERT INTO users VALUES (1);
      ALTER TABLE users ADD COLUMN name TEXT;
      SELECT * FROM users;
    `;
    const ddls = extractDDLStatements(sql);
    expect(ddls).toHaveLength(2);
    expect(ddls[0].statementType).toBe("CREATE");
    expect(ddls[1].statementType).toBe("ALTER");
  });

  it("returns empty array for DML-only SQL", () => {
    const sql = "SELECT 1; INSERT INTO t VALUES (1); UPDATE t SET x = 1;";
    expect(extractDDLStatements(sql)).toHaveLength(0);
  });

  it("handles full migration SQL with multiple DDL types", () => {
    const sql = `
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE TABLE users (id UUID PRIMARY KEY);
      CREATE INDEX idx_users ON users(id);
      GRANT SELECT ON users TO anon;
    `;
    const ddls = extractDDLStatements(sql);
    expect(ddls.length).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// containsDDL
// =============================================================================

describe("containsDDL", () => {
  it("returns true when DDL is present", () => {
    expect(containsDDL("CREATE TABLE t (id INT)")).toBe(true);
    expect(containsDDL("DROP INDEX idx_name")).toBe(true);
    expect(containsDDL("ALTER TABLE t ADD COLUMN x INT")).toBe(true);
  });

  it("returns false for DML-only SQL", () => {
    expect(containsDDL("SELECT * FROM users")).toBe(false);
    expect(containsDDL("INSERT INTO t VALUES (1)")).toBe(false);
    expect(containsDDL("UPDATE t SET x = 1")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(containsDDL("")).toBe(false);
  });
});

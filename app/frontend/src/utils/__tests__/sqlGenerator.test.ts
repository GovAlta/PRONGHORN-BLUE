import { describe, it, expect } from "vitest";
import {
  sanitizeTableName,
  sanitizeColumnName,
  generateCreateTableSQL,
  generateIndexSQL,
  generateInsertBatchSQL,
  generateFullImportSQL,
} from "../sqlGenerator";
import type {
  TableDefinition,
  IndexDefinition,
  ColumnDefinition,
} from "../sqlGenerator";

// =============================================================================
// sanitizeTableName
// =============================================================================

describe("sanitizeTableName", () => {
  it("converts to lowercase", () => {
    expect(sanitizeTableName("MyTable")).toBe("mytable");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeTableName("my-table.name")).toBe("my_table_name");
  });

  it("prefixes names starting with a digit", () => {
    expect(sanitizeTableName("123table")).toBe("_123table");
  });

  it("truncates to 63 characters", () => {
    const longName = "a".repeat(100);
    expect(sanitizeTableName(longName).length).toBe(63);
  });

  it("handles empty string", () => {
    expect(sanitizeTableName("")).toBe("");
  });

  it("preserves underscores", () => {
    expect(sanitizeTableName("my_table_name")).toBe("my_table_name");
  });

  it("replaces spaces with underscores", () => {
    expect(sanitizeTableName("my table name")).toBe("my_table_name");
  });
});

// =============================================================================
// sanitizeColumnName
// =============================================================================

describe("sanitizeColumnName", () => {
  it("converts to lowercase", () => {
    expect(sanitizeColumnName("MyColumn")).toBe("mycolumn");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeColumnName("col-name.here")).toBe("col_name_here");
  });

  it("prefixes names starting with a digit", () => {
    expect(sanitizeColumnName("1st_col")).toBe("_1st_col");
  });

  it("truncates to 63 characters", () => {
    const longName = "c".repeat(100);
    expect(sanitizeColumnName(longName).length).toBe(63);
  });
});

// =============================================================================
// generateCreateTableSQL
// =============================================================================

describe("generateCreateTableSQL", () => {
  const makeTableDef = (overrides?: Partial<TableDefinition>): TableDefinition => ({
    name: "users",
    schema: "public",
    columns: [
      { name: "id", type: "UUID", nullable: false, isPrimaryKey: true, isUnique: false },
      { name: "name", type: "TEXT", nullable: false, isPrimaryKey: false, isUnique: false },
      { name: "email", type: "TEXT", nullable: false, isPrimaryKey: false, isUnique: true },
    ],
    indexes: [],
    ...overrides,
  });

  it("generates valid CREATE TABLE SQL", () => {
    const result = generateCreateTableSQL(makeTableDef());
    expect(result.type).toBe("CREATE_TABLE");
    expect(result.sql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(result.sql).toContain('"users"');
    expect(result.sql).toContain('"id" UUID PRIMARY KEY');
    expect(result.sql).toContain('"name" TEXT NOT NULL');
    expect(result.sql).toContain('"email" TEXT NOT NULL UNIQUE');
  });

  it("includes schema prefix when provided", () => {
    const result = generateCreateTableSQL(makeTableDef({ schema: "myschema" }));
    expect(result.sql).toContain('"myschema"."users"');
  });

  it("handles table without schema", () => {
    const result = generateCreateTableSQL(makeTableDef({ schema: "" }));
    expect(result.sql).toContain('"users"');
    expect(result.sql).not.toContain('"".');
  });

  it("sets tableName in result", () => {
    const result = generateCreateTableSQL(makeTableDef());
    expect(result.tableName).toBe("users");
  });

  it("includes column references", () => {
    const result = generateCreateTableSQL(
      makeTableDef({
        columns: [
          {
            name: "user_id",
            type: "UUID",
            nullable: false,
            isPrimaryKey: false,
            isUnique: false,
            references: { table: "users", column: "id" },
          },
        ],
      })
    );
    expect(result.sql).toContain('REFERENCES "users"("id")');
  });

  it("includes default values", () => {
    const result = generateCreateTableSQL(
      makeTableDef({
        columns: [
          {
            name: "status",
            type: "TEXT",
            nullable: true,
            isPrimaryKey: false,
            isUnique: false,
            defaultValue: "'active'",
          },
        ],
      })
    );
    expect(result.sql).toContain("DEFAULT 'active'");
  });
});

// =============================================================================
// generateIndexSQL
// =============================================================================

describe("generateIndexSQL", () => {
  it("generates index SQL", () => {
    const indexes: IndexDefinition[] = [
      { name: "idx_email", columns: ["email"], unique: false },
    ];
    const results = generateIndexSQL("users", "public", indexes);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("CREATE_INDEX");
    expect(results[0].sql).toContain("CREATE INDEX IF NOT EXISTS");
    expect(results[0].sql).toContain('"email"');
  });

  it("generates unique index SQL", () => {
    const indexes: IndexDefinition[] = [
      { name: "idx_email_unique", columns: ["email"], unique: true },
    ];
    const results = generateIndexSQL("users", "public", indexes);
    expect(results[0].sql).toContain("CREATE UNIQUE INDEX");
  });

  it("generates multi-column index", () => {
    const indexes: IndexDefinition[] = [
      { name: "idx_name_email", columns: ["first_name", "last_name"], unique: false },
    ];
    const results = generateIndexSQL("users", "public", indexes);
    expect(results[0].sql).toContain('"first_name", "last_name"');
  });

  it("returns empty array for no indexes", () => {
    const results = generateIndexSQL("users", "public", []);
    expect(results).toHaveLength(0);
  });
});

// =============================================================================
// generateInsertBatchSQL
// =============================================================================

describe("generateInsertBatchSQL", () => {
  it("generates INSERT statements", () => {
    const results = generateInsertBatchSQL(
      "users",
      "public",
      ["name", "age"],
      [["Alice", 30], ["Bob", 25]]
    );
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("INSERT");
    expect(results[0].sql).toContain("INSERT INTO");
    expect(results[0].sql).toContain("'Alice'");
    expect(results[0].sql).toContain("30");
  });

  it("splits rows into batches", () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`user${i}`, i]);
    const results = generateInsertBatchSQL("users", "public", ["name", "age"], rows, 50);
    expect(results).toHaveLength(3); // 50 + 50 + 20
  });

  it("handles null values", () => {
    const results = generateInsertBatchSQL(
      "users",
      "public",
      ["name", "age"],
      [["Alice", null]]
    );
    expect(results[0].sql).toContain("NULL");
  });

  it("handles boolean values", () => {
    const results = generateInsertBatchSQL(
      "users",
      "public",
      ["name", "active"],
      [["Alice", true], ["Bob", false]]
    );
    expect(results[0].sql).toContain("TRUE");
    expect(results[0].sql).toContain("FALSE");
  });

  it("escapes single quotes in strings", () => {
    const results = generateInsertBatchSQL(
      "users",
      "public",
      ["name"],
      [["O'Brien"]]
    );
    expect(results[0].sql).toContain("O''Brien");
  });

  it("handles empty string as NULL", () => {
    const results = generateInsertBatchSQL(
      "users",
      "public",
      ["name"],
      [[""]]
    );
    expect(results[0].sql).toContain("NULL");
  });

  it("pads short rows with NULL", () => {
    const results = generateInsertBatchSQL(
      "users",
      "public",
      ["name", "age", "email"],
      [["Alice"]] // only 1 value for 3 columns
    );
    // Should still succeed without error - nulls fill missing columns
    expect(results).toHaveLength(1);
    expect(results[0].sql).toContain("NULL");
  });

  it("includes description with row range", () => {
    const results = generateInsertBatchSQL(
      "users",
      "public",
      ["name"],
      [["Alice"], ["Bob"]],
      50
    );
    expect(results[0].description).toContain("Insert rows 1-2");
  });
});

// =============================================================================
// generateFullImportSQL
// =============================================================================

describe("generateFullImportSQL", () => {
  const tableDef: TableDefinition = {
    name: "items",
    schema: "public",
    columns: [
      { name: "id", type: "UUID", nullable: false, isPrimaryKey: true, isUnique: false },
      { name: "name", type: "TEXT", nullable: false, isPrimaryKey: false, isUnique: false },
    ],
    indexes: [{ name: "idx_name", columns: ["name"], unique: false }],
  };

  it("wraps in transaction by default", () => {
    const results = generateFullImportSQL(tableDef, [["id1", "item1"]]);
    expect(results[0].type).toBe("BEGIN_TRANSACTION");
    expect(results[0].sql).toBe("BEGIN;");
    expect(results[results.length - 1].type).toBe("COMMIT_TRANSACTION");
    expect(results[results.length - 1].sql).toBe("COMMIT;");
  });

  it("skips transaction when option is false", () => {
    const results = generateFullImportSQL(tableDef, [["id1", "item1"]], 50, {
      wrapInTransaction: false,
    });
    expect(results[0].type).toBe("CREATE_TABLE");
  });

  it("includes CREATE TABLE, INDEX, and INSERT statements", () => {
    const results = generateFullImportSQL(tableDef, [["id1", "item1"]]);
    const types = results.map((s) => s.type);
    expect(types).toContain("BEGIN_TRANSACTION");
    expect(types).toContain("CREATE_TABLE");
    expect(types).toContain("CREATE_INDEX");
    expect(types).toContain("INSERT");
    expect(types).toContain("COMMIT_TRANSACTION");
  });

  it("sequences statements correctly", () => {
    const results = generateFullImportSQL(tableDef, [["id1", "item1"]]);
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].sequence).toBeLessThan(results[i + 1].sequence);
    }
  });
});

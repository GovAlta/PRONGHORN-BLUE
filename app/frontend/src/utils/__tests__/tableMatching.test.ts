import { describe, it, expect } from "vitest";
import {
  areTypesCompatible,
  matchTables,
} from "../tableMatching";
import type {
  ExistingTableSchema,
  TableMatchResult,
} from "../tableMatching";
import type { JsonTable } from "../parseJson";

// =============================================================================
// areTypesCompatible
// =============================================================================

describe("areTypesCompatible", () => {
  it("returns true for identical types", () => {
    expect(areTypesCompatible("TEXT", "TEXT")).toBe(true);
    expect(areTypesCompatible("INTEGER", "INTEGER")).toBe(true);
    expect(areTypesCompatible("BOOLEAN", "BOOLEAN")).toBe(true);
  });

  it("returns true when existing type is TEXT (accepts anything)", () => {
    expect(areTypesCompatible("INTEGER", "TEXT")).toBe(true);
    expect(areTypesCompatible("BOOLEAN", "TEXT")).toBe(true);
    expect(areTypesCompatible("UUID", "TEXT")).toBe(true);
  });

  it("returns true when numeric accepts integer", () => {
    expect(areTypesCompatible("INTEGER", "NUMERIC")).toBe(true);
  });

  it("returns true when timestamp accepts date", () => {
    expect(areTypesCompatible("DATE", "TIMESTAMP WITH TIME ZONE")).toBe(true);
  });

  it("returns true when JSON accepts text", () => {
    expect(areTypesCompatible("TEXT", "JSONB")).toBe(true);
    expect(areTypesCompatible("TEXT", "JSON")).toBe(true);
  });

  it("returns true when UUID accepts text", () => {
    expect(areTypesCompatible("TEXT", "UUID")).toBe(true);
  });

  it("returns true when integer accepts text (will be cast)", () => {
    expect(areTypesCompatible("TEXT", "INTEGER")).toBe(true);
  });

  it("returns false for incompatible types", () => {
    expect(areTypesCompatible("BOOLEAN", "INTEGER")).toBe(false);
    expect(areTypesCompatible("UUID", "INTEGER")).toBe(false);
  });

  it("handles case-insensitive varchar variations", () => {
    expect(areTypesCompatible("VARCHAR(255)", "TEXT")).toBe(true);
    expect(areTypesCompatible("TEXT", "VARCHAR(255)")).toBe(true);
  });
});

// =============================================================================
// matchTables
// =============================================================================

describe("matchTables", () => {
  const existingTables: ExistingTableSchema[] = [
    {
      name: "users",
      columns: [
        { name: "id", type: "uuid", nullable: false },
        { name: "name", type: "text", nullable: false },
        { name: "email", type: "text", nullable: true },
      ],
    },
    {
      name: "orders",
      columns: [
        { name: "id", type: "uuid", nullable: false },
        { name: "total", type: "numeric", nullable: false },
        { name: "user_id", type: "uuid", nullable: false },
      ],
    },
  ];

  it("returns exact match for same table name", () => {
    const importTables: JsonTable[] = [
      {
        name: "users",
        columns: [
          { name: "id", sampleValues: ["550e8400-e29b-41d4-a716-446655440000"] },
          { name: "name", sampleValues: ["Alice"] },
          { name: "email", sampleValues: ["alice@example.com"] },
        ],
        rows: [{ id: "550e8400-e29b-41d4-a716-446655440000", name: "Alice", email: "alice@example.com" }],
        rowCount: 1,
      },
    ];

    const results = matchTables(importTables, existingTables);
    expect(results).toHaveLength(1);
    expect(results[0].existingTable).toBe("users");
    expect(results[0].matchType).toBe("exact");
    expect(results[0].matchScore).toBeGreaterThanOrEqual(80);
  });

  it("returns 'new' for unmatched table name", () => {
    const importTables: JsonTable[] = [
      {
        name: "products",
        columns: [
          { name: "id", sampleValues: ["1"] },
          { name: "title", sampleValues: ["Widget"] },
        ],
        rows: [{ id: "1", title: "Widget" }],
        rowCount: 1,
      },
    ];

    const results = matchTables(importTables, existingTables);
    expect(results).toHaveLength(1);
    expect(results[0].matchType).toBe("new");
    expect(results[0].status).toBe("new");
    expect(results[0].existingTable).toBeUndefined();
  });

  it("returns 'new' when no existing tables", () => {
    const importTables: JsonTable[] = [
      {
        name: "items",
        columns: [{ name: "id", sampleValues: ["1"] }],
        rows: [{ id: "1" }],
        rowCount: 1,
      },
    ];

    const results = matchTables(importTables, []);
    expect(results).toHaveLength(1);
    expect(results[0].matchType).toBe("new");
  });

  it("identifies missing columns in import", () => {
    const importTables: JsonTable[] = [
      {
        name: "users",
        columns: [
          { name: "id", sampleValues: ["550e8400-e29b-41d4-a716-446655440000"] },
          { name: "name", sampleValues: ["Alice"] },
          { name: "phone", sampleValues: ["+1555123"] },
        ],
        rows: [{ id: "550e8400-e29b-41d4-a716-446655440000", name: "Alice", phone: "+1555123" }],
        rowCount: 1,
      },
    ];

    const results = matchTables(importTables, existingTables);
    expect(results[0].missingColumns).toContain("phone");
  });

  it("identifies extra columns in existing table", () => {
    const importTables: JsonTable[] = [
      {
        name: "users",
        columns: [
          { name: "id", sampleValues: ["550e8400-e29b-41d4-a716-446655440000"] },
        ],
        rows: [{ id: "550e8400-e29b-41d4-a716-446655440000" }],
        rowCount: 1,
      },
    ];

    const results = matchTables(importTables, existingTables);
    expect(results[0].extraColumns.length).toBeGreaterThan(0);
  });

  it("handles multiple import tables", () => {
    const importTables: JsonTable[] = [
      {
        name: "users",
        columns: [{ name: "id", sampleValues: ["550e8400-e29b-41d4-a716-446655440000"] }],
        rows: [{ id: "550e8400-e29b-41d4-a716-446655440000" }],
        rowCount: 1,
      },
      {
        name: "products",
        columns: [{ name: "id", sampleValues: ["1"] }],
        rows: [{ id: "1" }],
        rowCount: 1,
      },
    ];

    const results = matchTables(importTables, existingTables);
    expect(results).toHaveLength(2);
  });
});

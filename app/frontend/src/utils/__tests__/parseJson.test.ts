import { describe, it, expect } from "vitest";
import {
  parseJsonData,
  parseJsonString,
  analyzeJsonStructure,
  analyzeSchemaStatistics,
  getJsonHeaders,
  getAllJsonHeaders,
  getJsonRowsAsArray,
  getAllJsonRowsAsArray,
} from "../parseJson";
import type { JsonTable, NormalizationOptions } from "../parseJson";

// =============================================================================
// parseJsonData — basic routing
// =============================================================================

describe("parseJsonData", () => {
  it("returns empty tables for primitive values", () => {
    const result = parseJsonData("hello");
    expect(result.rootType).toBe("primitive");
    expect(result.tables).toHaveLength(0);
    expect(result.totalRows).toBe(0);
  });

  it("returns rootType 'array' for arrays", () => {
    const result = parseJsonData([{ name: "Alice" }]);
    expect(result.rootType).toBe("array");
  });

  it("returns rootType 'object' for objects", () => {
    const result = parseJsonData({ name: "Alice" });
    expect(result.rootType).toBe("object");
  });

  it("creates a single table from a flat array of objects", () => {
    const data = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ];
    const result = parseJsonData(data, "users");
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe("users");
    expect(result.tables[0].rows).toHaveLength(2);
    expect(result.totalRows).toBe(2);
  });

  it("generates _row_id for each row", () => {
    const data = [{ name: "Alice" }];
    const result = parseJsonData(data, "users");
    const row = result.tables[0].rows[0];
    expect(row._row_id).toBeDefined();
    expect(row._row_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("extracts scalar columns correctly", () => {
    const data = [{ name: "Alice", active: true, score: 42 }];
    const result = parseJsonData(data, "items");
    const row = result.tables[0].rows[0];
    expect(row.name).toBe("Alice");
    expect(row.active).toBe(true);
    expect(row.score).toBe(42);
  });

  it("normalizes nested arrays into child tables (partial strategy)", () => {
    const data = [
      {
        name: "Alice",
        skills: ["Python", "TypeScript"],
      },
    ];
    const result = parseJsonData(data, "users", { strategy: "partial" });
    expect(result.tables.length).toBeGreaterThan(1);
    const childTable = result.tables.find((t) => t.name === "skills");
    expect(childTable).toBeDefined();
    expect(childTable!.rows).toHaveLength(2);
    expect(childTable!.parentTable).toBe("users");
  });

  it("creates relationships for child tables", () => {
    const data = [
      {
        name: "Alice",
        orders: [{ item: "Book" }, { item: "Pen" }],
      },
    ];
    const result = parseJsonData(data, "users");
    expect(result.relationships.length).toBeGreaterThan(0);
    const rel = result.relationships[0];
    expect(rel.parentTable).toBe("users");
    expect(rel.childTable).toBe("orders");
    expect(rel.parentColumn).toBe("_row_id");
    expect(rel.childColumn).toBe("_parent_id");
  });

  it("flattens simple nested objects (no nested arrays)", () => {
    const data = [{ name: "Alice", address: { city: "Seattle", zip: "98101" } }];
    const result = parseJsonData(data, "users", { strategy: "partial" });
    // With partial strategy, simple nested objects get flattened
    expect(result.tables).toHaveLength(1);
    const row = result.tables[0].rows[0];
    expect(row.address_city).toBe("Seattle");
    expect(row.address_zip).toBe("98101");
  });

  it("handles wrapper objects with single array key", () => {
    const data = { results: [{ name: "Alice" }, { name: "Bob" }] };
    const result = parseJsonData(data, "data");
    const table = result.tables.find((t) => t.name === "results");
    expect(table).toBeDefined();
    expect(table!.rows).toHaveLength(2);
  });

  it("handles MongoDB _id fields", () => {
    const data = [{ _id: "507f1f77bcf86cd799439011", name: "Alice" }];
    const result = parseJsonData(data, "users");
    const row = result.tables[0].rows[0];
    // _id is converted to _row_id as a UUID
    expect(row._row_id).toBeDefined();
    // The _id field itself should not appear in scalar columns
    expect(row._id).toBeUndefined();
  });

  it("handles MongoDB Extended JSON ($oid)", () => {
    const data = [
      {
        _id: { $oid: "507f1f77bcf86cd799439011" },
        name: "Alice",
      },
    ];
    const result = parseJsonData(data, "users");
    expect(result.tables[0].rows[0]._row_id).toBeDefined();
  });

  it("respects 'full' normalization strategy", () => {
    const data = [
      {
        name: "Alice",
        profile: { bio: "Developer", website: "example.com" },
      },
    ];
    const result = parseJsonData(data, "users", { strategy: "full" });
    // Full strategy normalizes all nested objects into separate tables
    expect(result.tables.length).toBeGreaterThan(1);
  });

  it("uses default table name when not provided", () => {
    const data = [{ x: 1 }];
    const result = parseJsonData(data);
    expect(result.tables[0].name).toBe("imported_data");
  });
});

// =============================================================================
// parseJsonString
// =============================================================================

describe("parseJsonString", () => {
  it("parses a JSON string", () => {
    const result = parseJsonString('[{"name":"Alice"}]', "users");
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].rows[0].name).toBe("Alice");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJsonString("not json")).toThrow();
  });

  it("uses default table name", () => {
    const result = parseJsonString('[{"x":1}]');
    expect(result.tables[0].name).toBe("pasted_data");
  });
});

// =============================================================================
// analyzeJsonStructure
// =============================================================================

describe("analyzeJsonStructure", () => {
  it("returns empty for primitives", () => {
    expect(analyzeJsonStructure("hello")).toEqual([]);
    expect(analyzeJsonStructure(42)).toEqual([]);
    expect(analyzeJsonStructure(null)).toEqual([]);
  });

  it("returns empty for empty arrays", () => {
    expect(analyzeJsonStructure([])).toEqual([]);
  });

  it("identifies array fields in objects", () => {
    const data = { name: "Alice", tags: ["a", "b"] };
    const nodes = analyzeJsonStructure(data);
    const tagsNode = nodes.find((n) => n.key === "tags");
    expect(tagsNode).toBeDefined();
    expect(tagsNode!.type).toBe("array");
    expect(tagsNode!.itemType).toBe("primitive");
    expect(tagsNode!.itemCount).toBe(2);
  });

  it("identifies nested object fields", () => {
    const data = { meta: { version: 1, author: "Bob" } };
    const nodes = analyzeJsonStructure(data);
    const metaNode = nodes.find((n) => n.key === "meta");
    expect(metaNode).toBeDefined();
    expect(metaNode!.type).toBe("object");
    expect(metaNode!.fieldCount).toBe(2);
  });

  it("identifies arrays of objects", () => {
    const data = { items: [{ id: 1 }, { id: 2 }] };
    const nodes = analyzeJsonStructure(data);
    const itemsNode = nodes.find((n) => n.key === "items");
    expect(itemsNode!.itemType).toBe("object");
    expect(itemsNode!.children).toBeDefined();
  });

  it("analyzes the first item of root arrays", () => {
    const data = [{ name: "Alice", tags: ["a"] }];
    const nodes = analyzeJsonStructure(data);
    expect(nodes.find((n) => n.key === "tags")).toBeDefined();
  });

  it("skips MongoDB _id and __v fields", () => {
    const data = { _id: "abc", __v: 0, name: "Alice" };
    const nodes = analyzeJsonStructure(data);
    expect(nodes.find((n) => n.key === "_id")).toBeUndefined();
    expect(nodes.find((n) => n.key === "__v")).toBeUndefined();
  });
});

// =============================================================================
// analyzeSchemaStatistics
// =============================================================================

describe("analyzeSchemaStatistics", () => {
  it("handles empty/primitive input", () => {
    const result = analyzeSchemaStatistics([]);
    expect(result.totalDocuments).toBe(0);
  });

  it("analyzes uniform documents", () => {
    const data = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ];
    const result = analyzeSchemaStatistics(data);
    expect(result.totalDocuments).toBe(2);
    expect(result.uniqueFields).toBe(2);
    expect(result.typeConflicts).toHaveLength(0);

    const nameStats = result.fieldStats.get("name");
    expect(nameStats).toBeDefined();
    expect(nameStats!.occurrences).toBe(2);
    expect(nameStats!.percentPresent).toBe(100);
  });

  it("detects heterogeneous fields", () => {
    const data = [
      { name: "Alice", age: 30 },
      { name: "Bob", email: "bob@test.com" },
    ];
    const result = analyzeSchemaStatistics(data);
    expect(result.uniqueFields).toBe(3); // name, age, email

    const ageStats = result.fieldStats.get("age");
    expect(ageStats!.occurrences).toBe(1);
    expect(ageStats!.percentPresent).toBe(50);
  });

  it("detects type conflicts", () => {
    const data = [
      { value: 42 },
      { value: "hello" },
    ];
    const result = analyzeSchemaStatistics(data);
    expect(result.typeConflicts).toContain("value");

    const valueStats = result.fieldStats.get("value");
    expect(valueStats!.hasTypeConflict).toBe(true);
    expect(valueStats!.types.size).toBe(2);
  });

  it("collects sample values (up to 3)", () => {
    const data = [
      { tag: "a" },
      { tag: "b" },
      { tag: "c" },
      { tag: "d" },
    ];
    const result = analyzeSchemaStatistics(data);
    const tagStats = result.fieldStats.get("tag");
    expect(tagStats!.sampleValues.length).toBeLessThanOrEqual(3);
  });

  it("handles a single object (non-array)", () => {
    const result = analyzeSchemaStatistics({ name: "Alice", age: 30 });
    expect(result.totalDocuments).toBe(1);
    expect(result.uniqueFields).toBe(2);
  });
});

// =============================================================================
// getJsonHeaders / getAllJsonHeaders
// =============================================================================

describe("getJsonHeaders", () => {
  it("excludes _row_id from display headers", () => {
    const table: JsonTable = {
      name: "test",
      columns: [
        { name: "_row_id", path: "_row_id", sampleValues: [], isNested: false, isArray: false },
        { name: "name", path: "name", sampleValues: [], isNested: false, isArray: false },
      ],
      rows: [],
    };
    expect(getJsonHeaders(table)).toEqual(["name"]);
  });
});

describe("getAllJsonHeaders", () => {
  it("includes all columns including _row_id", () => {
    const table: JsonTable = {
      name: "test",
      columns: [
        { name: "_row_id", path: "_row_id", sampleValues: [], isNested: false, isArray: false },
        { name: "name", path: "name", sampleValues: [], isNested: false, isArray: false },
      ],
      rows: [],
    };
    expect(getAllJsonHeaders(table)).toEqual(["_row_id", "name"]);
  });
});

// =============================================================================
// getJsonRowsAsArray / getAllJsonRowsAsArray
// =============================================================================

describe("getJsonRowsAsArray", () => {
  it("converts rows to 2D array excluding _row_id", () => {
    const table: JsonTable = {
      name: "test",
      columns: [
        { name: "_row_id", path: "_row_id", sampleValues: [], isNested: false, isArray: false },
        { name: "name", path: "name", sampleValues: [], isNested: false, isArray: false },
        { name: "age", path: "age", sampleValues: [], isNested: false, isArray: false },
      ],
      rows: [
        { _row_id: "uuid1", name: "Alice", age: 30 },
        { _row_id: "uuid2", name: "Bob", age: null },
      ],
    };
    const result = getJsonRowsAsArray(table);
    expect(result).toEqual([
      ["Alice", 30],
      ["Bob", null],
    ]);
  });

  it("fills missing values with null", () => {
    const table: JsonTable = {
      name: "test",
      columns: [
        { name: "a", path: "a", sampleValues: [], isNested: false, isArray: false },
        { name: "b", path: "b", sampleValues: [], isNested: false, isArray: false },
      ],
      rows: [{ a: 1 }],
    };
    const result = getJsonRowsAsArray(table);
    expect(result).toEqual([[1, null]]);
  });
});

describe("getAllJsonRowsAsArray", () => {
  it("includes _row_id in row arrays", () => {
    const table: JsonTable = {
      name: "test",
      columns: [
        { name: "_row_id", path: "_row_id", sampleValues: [], isNested: false, isArray: false },
        { name: "name", path: "name", sampleValues: [], isNested: false, isArray: false },
      ],
      rows: [{ _row_id: "uuid1", name: "Alice" }],
    };
    const result = getAllJsonRowsAsArray(table);
    expect(result).toEqual([["uuid1", "Alice"]]);
  });
});

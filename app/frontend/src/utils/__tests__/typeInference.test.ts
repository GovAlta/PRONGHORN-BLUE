import { describe, it, expect } from "vitest";
import {
  inferColumnType,
  attemptCast,
  validateColumnCasting,
  generateColumnDefinition,
} from "../typeInference";
import type { PostgresType, CastingRule } from "../typeInference";

// =============================================================================
// inferColumnType
// =============================================================================

describe("inferColumnType", () => {
  it("returns TEXT with nullable for all-empty values", () => {
    const result = inferColumnType([null, undefined, ""], "empty_col");
    expect(result.inferredType).toBe("TEXT");
    expect(result.nullable).toBe(true);
    expect(result.uniqueRatio).toBe(0);
    expect(result.castingSuccessRate).toBe(1);
  });

  it("detects UUID columns", () => {
    const uuids = [
      "550e8400-e29b-41d4-a716-446655440000",
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    ];
    const result = inferColumnType(uuids, "id");
    expect(result.inferredType).toBe("UUID");
    expect(result.nullable).toBe(false);
  });

  it("detects BOOLEAN columns", () => {
    const bools = ["true", "false", "yes", "no", "1", "0"];
    const result = inferColumnType(bools, "is_active");
    expect(result.inferredType).toBe("BOOLEAN");
  });

  it("detects INTEGER columns", () => {
    const ints = [1, 2, 3, 100, -50, 0];
    const result = inferColumnType(ints, "count");
    expect(result.inferredType).toBe("INTEGER");
  });

  it("detects INTEGER from string values", () => {
    const ints = ["1", "2", "3", "100", "-50", "0"];
    const result = inferColumnType(ints, "count");
    expect(result.inferredType).toBe("INTEGER");
  });

  it("detects NUMERIC columns for decimals", () => {
    const nums = [1.5, 2.7, 3.14, 100.0001, -50.5];
    const result = inferColumnType(nums, "price");
    expect(result.inferredType).toBe("NUMERIC");
  });

  it("detects DATE columns", () => {
    const dates = ["2024-01-15", "2024-02-20", "2024-03-25"];
    const result = inferColumnType(dates, "birth_date");
    expect(result.inferredType).toBe("DATE");
  });

  it("detects TIMESTAMP WITH TIME ZONE columns", () => {
    const timestamps = [
      "2024-01-15T10:30:00Z",
      "2024-02-20T14:45:00Z",
      "2024-03-25T08:00:00Z",
    ];
    const result = inferColumnType(timestamps, "created_at");
    expect(result.inferredType).toBe("TIMESTAMP WITH TIME ZONE");
  });

  it("detects JSONB columns", () => {
    const jsonValues = ['{"key": "value"}', '{"a": 1}', '{"nested": {"b": 2}}'];
    const result = inferColumnType(jsonValues, "metadata");
    expect(result.inferredType).toBe("JSONB");
  });

  it("falls back to TEXT for mixed types", () => {
    const mixed = ["hello", 42, true, "2024-01-15", '{"a":1}'];
    const result = inferColumnType(mixed, "misc");
    expect(result.inferredType).toBe("TEXT");
  });

  it("handles nullable columns correctly", () => {
    const values = [1, 2, null, 3, undefined, 4];
    const result = inferColumnType(values, "score");
    expect(result.nullable).toBe(true);
    expect(result.inferredType).toBe("INTEGER");
  });

  it("suggests primary key for 'id' columns with high uniqueness", () => {
    const uuids = Array.from({ length: 100 }, (_, i) =>
      `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`
    );
    const result = inferColumnType(uuids, "id");
    expect(result.suggestPrimaryKey).toBe(true);
  });

  it("suggests index for email-like columns", () => {
    const emails = ["a@test.com", "b@test.com", "c@test.com"];
    const result = inferColumnType(emails, "email");
    expect(result.suggestIndex).toBe(true);
  });

  it("uses column name hints for date detection with lower threshold", () => {
    // Column named "created_at" with some date-ish values and a few non-dates
    const values = [
      "2024-01-15",
      "2024-02-20",
      "2024-03-25",
      "2024-04-10",
      "unknown",
    ];
    const result = inferColumnType(values, "created_at");
    expect(["DATE", "TIMESTAMP WITH TIME ZONE"]).toContain(result.inferredType);
  });

  it("tracks totalRowsAnalyzed", () => {
    const values = [1, 2, 3, null, 5];
    const result = inferColumnType(values, "n");
    expect(result.totalRowsAnalyzed).toBe(5);
  });

  it("provides sample values", () => {
    const values = [10, 20, 30, 40, 50, 60];
    const result = inferColumnType(values, "num");
    expect(result.sampleValues.length).toBeLessThanOrEqual(5);
  });
});

// =============================================================================
// attemptCast
// =============================================================================

describe("attemptCast", () => {
  it("casts null values successfully", () => {
    const result = attemptCast(null, "INTEGER");
    expect(result.success).toBe(true);
    expect(result.value).toBeNull();
  });

  it("casts undefined values successfully", () => {
    const result = attemptCast(undefined, "TEXT");
    expect(result.success).toBe(true);
    expect(result.value).toBeNull();
  });

  it("casts empty string to null", () => {
    const result = attemptCast("", "INTEGER");
    expect(result.success).toBe(true);
    expect(result.value).toBeNull();
  });

  it("casts to TEXT", () => {
    const result = attemptCast(42, "TEXT");
    expect(result.success).toBe(true);
    expect(result.value).toBe("42");
  });

  it("casts valid integer", () => {
    const result = attemptCast("42", "INTEGER");
    expect(result.success).toBe(true);
    expect(result.value).toBe(42);
  });

  it("fails for invalid integer", () => {
    const result = attemptCast("not_a_number", "INTEGER");
    expect(result.success).toBe(false);
  });

  it("casts valid numeric", () => {
    const result = attemptCast("3.14", "NUMERIC");
    expect(result.success).toBe(true);
    expect(result.value).toBeCloseTo(3.14);
  });

  it("casts boolean strings", () => {
    expect(attemptCast("true", "BOOLEAN").value).toBe(true);
    expect(attemptCast("false", "BOOLEAN").value).toBe(false);
    expect(attemptCast("yes", "BOOLEAN").value).toBe(true);
    expect(attemptCast("no", "BOOLEAN").value).toBe(false);
    expect(attemptCast("1", "BOOLEAN").value).toBe(true);
    expect(attemptCast("0", "BOOLEAN").value).toBe(false);
  });

  it("casts valid UUID", () => {
    const result = attemptCast(
      "550E8400-E29B-41D4-A716-446655440000",
      "UUID"
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("fails for invalid UUID", () => {
    const result = attemptCast("not-a-uuid", "UUID");
    expect(result.success).toBe(false);
  });

  it("casts valid date string", () => {
    const result = attemptCast("2024-01-15", "DATE");
    expect(result.success).toBe(true);
    expect(result.value).toBe("2024-01-15");
  });

  it("casts valid timestamp string", () => {
    const result = attemptCast("2024-01-15T10:30:00Z", "TIMESTAMP WITH TIME ZONE");
    expect(result.success).toBe(true);
    expect(result.value).toContain("2024-01-15");
  });

  it("casts JSON string", () => {
    const result = attemptCast('{"key": "value"}', "JSONB");
    expect(result.success).toBe(true);
    expect(result.value).toBe('{"key": "value"}');
  });

  it("casts object to JSONB", () => {
    const result = attemptCast({ key: "value" }, "JSONB");
    expect(result.success).toBe(true);
    expect(result.value).toBe('{"key":"value"}');
  });

  it("returns null on failure when nullOnFailure rule is set", () => {
    const rule: CastingRule = {
      sourceColumn: "test",
      targetType: "INTEGER",
      nullOnFailure: true,
      trimWhitespace: false,
    };
    const result = attemptCast("not_a_number", "INTEGER", rule);
    expect(result.success).toBe(true);
    expect(result.value).toBeNull();
  });

  it("trims whitespace when rule specifies", () => {
    const rule: CastingRule = {
      sourceColumn: "test",
      targetType: "INTEGER",
      nullOnFailure: false,
      trimWhitespace: true,
    };
    const result = attemptCast("  42  ", "INTEGER", rule);
    expect(result.success).toBe(true);
    expect(result.value).toBe(42);
  });
});

// =============================================================================
// validateColumnCasting
// =============================================================================

describe("validateColumnCasting", () => {
  it("returns 100% success for valid integers", () => {
    const result = validateColumnCasting([1, 2, 3, 4, 5], "INTEGER");
    expect(result.successRate).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it("reports failures for invalid values", () => {
    const result = validateColumnCasting(
      ["1", "two", "3", "four"],
      "INTEGER"
    );
    expect(result.successRate).toBe(0.5);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].row).toBe(2);
    expect(result.failures[1].row).toBe(4);
  });

  it("handles empty array", () => {
    const result = validateColumnCasting([], "TEXT");
    expect(result.successRate).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it("treats nulls as successful casts", () => {
    const result = validateColumnCasting([null, null, null], "INTEGER");
    expect(result.successRate).toBe(1);
  });
});

// =============================================================================
// generateColumnDefinition
// =============================================================================

describe("generateColumnDefinition", () => {
  it("generates basic column definition", () => {
    const result = generateColumnDefinition("name", "TEXT", true);
    expect(result).toBe('"name" TEXT');
  });

  it("generates NOT NULL column", () => {
    const result = generateColumnDefinition("name", "TEXT", false);
    expect(result).toBe('"name" TEXT NOT NULL');
  });

  it("generates primary key column", () => {
    const result = generateColumnDefinition("id", "UUID", false, true);
    expect(result).toBe('"id" UUID PRIMARY KEY');
  });

  it("generates unique column", () => {
    const result = generateColumnDefinition("email", "TEXT", false, false, true);
    expect(result).toBe('"email" TEXT NOT NULL UNIQUE');
  });

  it("generates column with default value", () => {
    const result = generateColumnDefinition(
      "status",
      "TEXT",
      true,
      false,
      false,
      "'active'"
    );
    expect(result).toBe('"status" TEXT DEFAULT \'active\'');
  });
});

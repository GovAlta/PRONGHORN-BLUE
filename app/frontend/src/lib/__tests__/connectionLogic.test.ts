import { describe, it, expect } from "vitest";
import {
  getFlowLevel,
  getXPosition,
  isValidConnection,
  getConnectionLabel,
  getValidTargets,
  buildFlowOrderMap,
  getCategoryLabel,
  getCategoryOrder,
  connectionLogic,
} from "../connectionLogic";

// =============================================================================
// getFlowLevel
// =============================================================================

describe("getFlowLevel", () => {
  it("returns level 1 for top-level node types", () => {
    expect(getFlowLevel("PROJECT")).toBe(1);
    expect(getFlowLevel("REQUIREMENT")).toBe(1);
    expect(getFlowLevel("STANDARD")).toBe(1);
    expect(getFlowLevel("SECURITY")).toBe(1);
  });

  it("returns level 2 for PAGE", () => {
    expect(getFlowLevel("PAGE")).toBe(2);
  });

  it("returns level 3 for component types", () => {
    expect(getFlowLevel("WEB_COMPONENT")).toBe(3);
    expect(getFlowLevel("COMPONENT")).toBe(3);
  });

  it("returns level 5 for API_SERVICE/AGENT", () => {
    expect(getFlowLevel("API_SERVICE")).toBe(5);
    expect(getFlowLevel("AGENT")).toBe(5);
  });

  it("returns level 9 for DATABASE", () => {
    expect(getFlowLevel("DATABASE")).toBe(9);
  });

  it("returns level 11 for TABLE", () => {
    expect(getFlowLevel("TABLE")).toBe(11);
  });

  it("returns 5 (default) for unknown node types", () => {
    expect(getFlowLevel("UNKNOWN_TYPE")).toBe(5);
    expect(getFlowLevel("")).toBe(5);
  });
});

// =============================================================================
// getXPosition
// =============================================================================

describe("getXPosition", () => {
  it("returns correct X position for known types", () => {
    expect(getXPosition("PROJECT")).toBe(100);
    expect(getXPosition("PAGE")).toBe(400);
    expect(getXPosition("WEB_COMPONENT")).toBe(700);
    expect(getXPosition("DATABASE")).toBe(2500);
    expect(getXPosition("TABLE")).toBe(3100);
  });

  it("returns 700 (default) for unknown types", () => {
    expect(getXPosition("UNKNOWN")).toBe(700);
  });
});

// =============================================================================
// isValidConnection
// =============================================================================

describe("isValidConnection", () => {
  it("returns true for valid connections", () => {
    expect(isValidConnection("PAGE", "WEB_COMPONENT")).toBe(true);
    expect(isValidConnection("PAGE", "HOOK_COMPOSABLE")).toBe(true);
    expect(isValidConnection("DATABASE", "SCHEMA")).toBe(true);
    expect(isValidConnection("SCHEMA", "TABLE")).toBe(true);
  });

  it("returns false for invalid connections", () => {
    expect(isValidConnection("TABLE", "PROJECT")).toBe(false);
    expect(isValidConnection("PAGE", "DATABASE")).toBe(false);
    expect(isValidConnection("SCHEMA", "PAGE")).toBe(false);
  });

  it("returns false for unknown source types", () => {
    expect(isValidConnection("UNKNOWN", "PAGE")).toBe(false);
  });

  it("returns false when target is not in the source's valid targets", () => {
    expect(isValidConnection("PAGE", "DATABASE")).toBe(false);
  });
});

// =============================================================================
// getConnectionLabel
// =============================================================================

describe("getConnectionLabel", () => {
  it("returns the correct label for valid connections", () => {
    expect(getConnectionLabel("PAGE", "WEB_COMPONENT")).toBe("renders");
    expect(getConnectionLabel("DATABASE", "SCHEMA")).toBe("contains");
    expect(getConnectionLabel("SCHEMA", "TABLE")).toBe("defines");
    expect(getConnectionLabel("HOOK_COMPOSABLE", "API_SERVICE")).toBe("calls");
  });

  it("returns 'connects to' for unknown connections", () => {
    expect(getConnectionLabel("UNKNOWN", "PAGE")).toBe("connects to");
    expect(getConnectionLabel("TABLE", "PROJECT")).toBe("connects to");
  });
});

// =============================================================================
// getValidTargets
// =============================================================================

describe("getValidTargets", () => {
  it("returns valid targets for PAGE", () => {
    const targets = getValidTargets("PAGE");
    expect(targets).toContain("WEB_COMPONENT");
    expect(targets).toContain("COMPONENT");
    expect(targets).toContain("HOOK_COMPOSABLE");
  });

  it("returns valid targets for DATABASE", () => {
    const targets = getValidTargets("DATABASE");
    expect(targets).toContain("SCHEMA");
  });

  it("returns empty array for unknown source", () => {
    expect(getValidTargets("UNKNOWN")).toEqual([]);
  });

  it("returns empty array for terminal node types", () => {
    expect(getValidTargets("TABLE")).toEqual([]);
  });
});

// =============================================================================
// buildFlowOrderMap
// =============================================================================

describe("buildFlowOrderMap", () => {
  it("returns a map with all node types", () => {
    const map = buildFlowOrderMap();
    expect(map).toBeTypeOf("object");
    expect(map["PROJECT"]).toBe(1);
    expect(map["PAGE"]).toBe(2);
    expect(map["DATABASE"]).toBe(9);
    expect(map["TABLE"]).toBe(11);
  });

  it("covers all types from the flow hierarchy", () => {
    const map = buildFlowOrderMap();
    for (const level of connectionLogic.flowHierarchy.levels) {
      for (const type of level.types) {
        expect(map[type]).toBe(level.level);
      }
    }
  });
});

// =============================================================================
// getCategoryLabel
// =============================================================================

describe("getCategoryLabel", () => {
  it("returns display labels for known categories", () => {
    expect(getCategoryLabel("frontend")).toBe("Frontend");
    expect(getCategoryLabel("backend")).toBe("Backend / API");
    expect(getCategoryLabel("database")).toBe("Database");
    expect(getCategoryLabel("agent")).toBe("AI Agents");
  });

  it("returns the input string for unknown categories", () => {
    expect(getCategoryLabel("nonexistent")).toBe("nonexistent");
  });
});

// =============================================================================
// getCategoryOrder
// =============================================================================

describe("getCategoryOrder", () => {
  it("returns the ordered category list", () => {
    const order = getCategoryOrder();
    expect(Array.isArray(order)).toBe(true);
    expect(order.length).toBeGreaterThan(0);
    expect(order).toContain("frontend");
    expect(order).toContain("backend");
    expect(order).toContain("database");
  });

  it("has annotation before frontend", () => {
    const order = getCategoryOrder();
    expect(order.indexOf("annotation")).toBeLessThan(order.indexOf("frontend"));
  });

  it("has frontend before backend", () => {
    const order = getCategoryOrder();
    expect(order.indexOf("frontend")).toBeLessThan(order.indexOf("backend"));
  });
});

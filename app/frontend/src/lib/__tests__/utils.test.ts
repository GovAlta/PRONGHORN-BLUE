import { describe, it, expect } from "vitest";
import { cn } from "../utils";

describe("cn (class name utility)", () => {
  it("merges simple class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("handles conditional classes", () => {
    const isHidden = false;
    expect(cn("base", isHidden && "hidden", "active")).toBe("base active");
  });

  it("handles undefined and null", () => {
    expect(cn("base", undefined, null, "end")).toBe("base end");
  });

  it("merges conflicting tailwind classes (last wins)", () => {
    // tailwind-merge should resolve conflicts
    expect(cn("p-4", "p-2")).toBe("p-2");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("handles empty input", () => {
    expect(cn()).toBe("");
  });

  it("handles array inputs via clsx", () => {
    expect(cn(["foo", "bar"])).toBe("foo bar");
  });

  it("handles object inputs via clsx", () => {
    expect(cn({ active: true, disabled: false })).toBe("active");
  });

  it("combines multiple types", () => {
    const result = cn("base", { active: true }, ["extra"]);
    expect(result).toContain("base");
    expect(result).toContain("active");
    expect(result).toContain("extra");
  });
});

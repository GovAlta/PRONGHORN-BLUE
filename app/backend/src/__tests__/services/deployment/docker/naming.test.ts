/**
 * Tests for `computeGenappResourceNames` — verifies the composed Azure
 * Container App name stays within the 32-char limit and remains a valid
 * resource name (no leading/trailing or doubled hyphens).
 */
import { computeGenappResourceNames } from "../../../../services/deployment/docker/naming";

describe("computeGenappResourceNames", () => {
  it("lowercase passthrough — already-safe names map straight through", () => {
    expect(
      computeGenappResourceNames({
        appName: "myapp",
        appId: "12345678-1234-1234-1234-1234567890ab",
        environment: "dev",
      }),
    ).toEqual({
      appName: "dev-myapp-12345678",
      resourceGroup: "rg-genapp-myapp-12345678-dev",
    });
  });

  it("budgets the safe app name so the composed name stays within 32 chars", () => {
    const long = "a".repeat(40);
    const out = computeGenappResourceNames({
      appName: long,
      appId: "12345678-1234-1234-1234-1234567890ab",
      environment: "dev",
    });
    // dev(3) + "-" + safe + "-" + 12345678(8) <= 32  ->  safe budget = 19
    expect(out.appName).toBe(`dev-${"a".repeat(19)}-12345678`);
    expect(out.appName.length).toBeLessThanOrEqual(32);
    expect(out.resourceGroup).toBe(`rg-genapp-${"a".repeat(19)}-12345678-dev`);
  });

  it("strips characters outside [a-z0-9-]", () => {
    const out = computeGenappResourceNames({
      appName: "my_app!@#$%name",
      appId: "12345678-1234-1234-1234-1234567890ab",
      environment: "dev",
    });
    expect(out.appName).toBe("dev-myappname-12345678");
    expect(out.resourceGroup).toBe("rg-genapp-myappname-12345678-dev");
  });

  it("mixed case is normalised to lowercase before stripping", () => {
    const out = computeGenappResourceNames({
      appName: "MyAppName",
      appId: "12345678-1234-1234-1234-1234567890ab",
      environment: "prod",
    });
    expect(out.appName).toBe("prod-myappname-12345678");
  });

  it("uppercase GUID app_id is lowercased only via the dash strip path", () => {
    // The bash block does not lowercase the app id, just strips dashes
    // and takes 8 chars. Confirm parity: uppercase chars survive.
    const out = computeGenappResourceNames({
      appName: "myapp",
      appId: "ABCDEF12-3456-7890-ABCD-EF1234567890",
      environment: "dev",
    });
    expect(out.appName).toBe("dev-myapp-ABCDEF12");
  });

  it("app_id without dashes is sliced to 8 chars", () => {
    const out = computeGenappResourceNames({
      appName: "myapp",
      appId: "1234567890abcdef",
      environment: "dev",
    });
    expect(out.appName).toBe("dev-myapp-12345678");
  });

  it("app_id shorter than 8 chars is used in full (no padding)", () => {
    const out = computeGenappResourceNames({
      appName: "myapp",
      appId: "abc-de",
      environment: "dev",
    });
    expect(out.appName).toBe("dev-myapp-abcde");
  });

  it("strips leading and trailing hyphens so truncation cannot create '--'", () => {
    const out = computeGenappResourceNames({
      appName: "-myapp-",
      appId: "12345678-1234",
      environment: "dev",
    });
    expect(out.appName).toBe("dev-myapp-12345678");
    expect(out.resourceGroup).toBe("rg-genapp-myapp-12345678-dev");
  });

  it("name reduced to all hyphens collapses to a hyphen-free composed name", () => {
    const out = computeGenappResourceNames({
      appName: "____!!!----____",
      appId: "12345678-1234",
      environment: "dev",
    });
    // After strip only hyphens survive; leading/trailing hyphen strip empties
    // the safe segment, which is then omitted from the join.
    expect(out.appName).toBe("dev-12345678");
    expect(out.resourceGroup).toBe("rg-genapp-12345678-dev");
  });

  it("unicode characters are stripped (not transliterated)", () => {
    const out = computeGenappResourceNames({
      appName: "café-naïve",
      appId: "12345678-1234",
      environment: "dev",
    });
    // 'café' → 'caf' (é stripped), 'naïve' → 'nave' (ï stripped)
    expect(out.appName).toBe("dev-caf-nave-12345678");
  });

  it("empty environment omits the env segment instead of leaving a hyphen", () => {
    const out = computeGenappResourceNames({
      appName: "myapp",
      appId: "12345678",
      environment: "",
    });
    expect(out.appName).toBe("myapp-12345678");
    expect(out.resourceGroup).toBe("rg-genapp-myapp-12345678");
  });
});

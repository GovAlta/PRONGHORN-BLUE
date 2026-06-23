/**
 * Tests for the pure naming/derivation helpers in `genappKeyVault` — verifies
 * the per-app vault name stays within Azure's 3–24 char limit and that secret
 * names sanitize to the valid Key Vault charset while remaining deterministic.
 */
import {
  deriveGenappKeyVaultName,
  deriveGenappKeyVaultUri,
  deriveSecretName,
  genappKeyVaultPublicNetworkAccess,
  genappKeyVaultTags,
  genappKeyVaultPrivateEndpointSubnetId,
  genappKeyVaultPrivateDnsZoneId,
  genappKeyVaultDnsWaitConfig,
  centralKeyVaultUri,
} from "../../../../services/deployment/docker/genappKeyVault";

describe("deriveGenappKeyVaultName", () => {
  it("produces a 24-char name from the first 18 hex chars of the app id", () => {
    const name = deriveGenappKeyVaultName(
      "12345678-1234-1234-1234-1234567890ab",
    );
    expect(name).toBe("kv-ga-123456781234123412");
    expect(name.length).toBe(24);
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });

  it("is deterministic for the same app id", () => {
    const id = "abcdef01-2345-6789-abcd-ef0123456789";
    expect(deriveGenappKeyVaultName(id)).toBe(deriveGenappKeyVaultName(id));
  });

  it("throws when appId is missing", () => {
    expect(() => deriveGenappKeyVaultName("")).toThrow();
  });
});

describe("deriveGenappKeyVaultUri", () => {
  it("builds the data-plane URI from the vault name", () => {
    expect(deriveGenappKeyVaultUri("kv-ga-123456781234123412")).toBe(
      "https://kv-ga-123456781234123412.vault.azure.net",
    );
  });
});

describe("centralKeyVaultUri", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AZURE_PLATFORM_KEYVAULT_URI;
    delete process.env.AZURE_PLATFORM_KEYVAULT_NAME;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("returns AZURE_PLATFORM_KEYVAULT_URI when set, trimming trailing slashes", () => {
    process.env.AZURE_PLATFORM_KEYVAULT_URI =
      "https://kv-pronghorn-bjzquz.vault.azure.net/";
    expect(centralKeyVaultUri()).toBe(
      "https://kv-pronghorn-bjzquz.vault.azure.net",
    );
  });

  it("derives the URI from AZURE_PLATFORM_KEYVAULT_NAME when URI is unset", () => {
    process.env.AZURE_PLATFORM_KEYVAULT_NAME = "kv-pronghorn-bjzquz";
    expect(centralKeyVaultUri()).toBe(
      "https://kv-pronghorn-bjzquz.vault.azure.net",
    );
  });

  it("throws when neither env var is set", () => {
    expect(() => centralKeyVaultUri()).toThrow();
  });
});

describe("deriveSecretName", () => {
  it("sanitizes to the Key Vault charset and appends a stable hash", () => {
    const name = deriveSecretName("env", "DATABASE_URL");
    expect(name).toMatch(/^env-database-url-[0-9a-f]{6}$/);
  });

  it("is deterministic for the same input", () => {
    expect(deriveSecretName("secret", "MY_KEY")).toBe(
      deriveSecretName("secret", "MY_KEY"),
    );
  });

  it("disambiguates names that sanitize to the same form via the hash", () => {
    const a = deriveSecretName("env", "FOO_BAR");
    const b = deriveSecretName("env", "FOO-BAR");
    expect(a).not.toBe(b);
  });

  it("prefixes by kind", () => {
    expect(deriveSecretName("env", "X")).toMatch(/^env-/);
    expect(deriveSecretName("secret", "X")).toMatch(/^sec-/);
    expect(deriveSecretName("dbconn", "X")).toMatch(/^dbc-/);
  });
});

describe("genappKeyVaultPublicNetworkAccess", () => {
  const original = process.env.AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS;
    } else {
      process.env.AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS = original;
    }
  });

  it("defaults to Disabled when unset", () => {
    delete process.env.AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS;
    expect(genappKeyVaultPublicNetworkAccess()).toBe("Disabled");
  });

  it('returns Enabled for "Enabled" (case-insensitive)', () => {
    process.env.AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS = "enabled";
    expect(genappKeyVaultPublicNetworkAccess()).toBe("Enabled");
  });

  it("returns Disabled for any other value", () => {
    process.env.AZURE_GENAPP_KEYVAULT_PUBLIC_NETWORK_ACCESS = "false";
    expect(genappKeyVaultPublicNetworkAccess()).toBe("Disabled");
  });
});

describe("genappKeyVaultTags", () => {
  it("applies the SecurityControl=Ignore policy exemption when public access is enabled", () => {
    expect(genappKeyVaultTags("Enabled")).toEqual({
      SecurityControl: "Ignore",
    });
  });

  it("applies no tags when public access is disabled", () => {
    expect(genappKeyVaultTags("Disabled")).toEqual({});
  });
});

describe("genappKeyVaultPrivateEndpointSubnetId", () => {
  const original = process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID;
    } else {
      process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID = original;
    }
  });

  it("returns null when unset", () => {
    delete process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID;
    expect(genappKeyVaultPrivateEndpointSubnetId()).toBeNull();
  });

  it("returns the configured subnet id", () => {
    process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_ENDPOINT_SUBNET_ID =
      "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/pe";
    expect(genappKeyVaultPrivateEndpointSubnetId()).toBe(
      "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/pe",
    );
  });
});

describe("genappKeyVaultPrivateDnsZoneId", () => {
  const original = process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID;
    } else {
      process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID = original;
    }
  });

  it("returns null when unset (defer to Policy-attached zone group)", () => {
    delete process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID;
    expect(genappKeyVaultPrivateDnsZoneId()).toBeNull();
  });

  it("returns the configured zone id", () => {
    process.env.AZURE_GENAPP_KEYVAULT_PRIVATE_DNS_ZONE_ID = "/zone/id";
    expect(genappKeyVaultPrivateDnsZoneId()).toBe("/zone/id");
  });
});

describe("genappKeyVaultDnsWaitConfig", () => {
  const keys = [
    "AZURE_GENAPP_KEYVAULT_DNS_WAIT_TIMEOUT_SECONDS",
    "AZURE_GENAPP_KEYVAULT_DNS_WAIT_INTERVAL_SECONDS",
    "AZURE_GENAPP_KEYVAULT_DNS_SETTLE_SECONDS",
  ] as const;
  const originals = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const k of keys) {
      if (originals[k] === undefined) delete process.env[k];
      else process.env[k] = originals[k];
    }
  });

  it("uses safe defaults when unset (600s / 10s / 15s)", () => {
    for (const k of keys) delete process.env[k];
    expect(genappKeyVaultDnsWaitConfig()).toEqual({
      timeoutMs: 600000,
      intervalMs: 10000,
      settleMs: 15000,
    });
  });

  it("honors valid positive overrides", () => {
    process.env.AZURE_GENAPP_KEYVAULT_DNS_WAIT_TIMEOUT_SECONDS = "120";
    process.env.AZURE_GENAPP_KEYVAULT_DNS_WAIT_INTERVAL_SECONDS = "5";
    process.env.AZURE_GENAPP_KEYVAULT_DNS_SETTLE_SECONDS = "0";
    const cfg = genappKeyVaultDnsWaitConfig();
    expect(cfg.timeoutMs).toBe(120000);
    expect(cfg.intervalMs).toBe(5000);
    // 0 is not > 0, so it falls back to the default settle of 15s.
    expect(cfg.settleMs).toBe(15000);
  });

  it("ignores non-numeric / non-positive values and falls back to defaults", () => {
    process.env.AZURE_GENAPP_KEYVAULT_DNS_WAIT_TIMEOUT_SECONDS = "abc";
    process.env.AZURE_GENAPP_KEYVAULT_DNS_WAIT_INTERVAL_SECONDS = "-3";
    expect(genappKeyVaultDnsWaitConfig()).toEqual({
      timeoutMs: 600000,
      intervalMs: 10000,
      settleMs: 15000,
    });
  });
});

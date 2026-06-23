import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getStoredToken,
  getStoredUser,
  setAuthData,
  clearAuthData,
} from "../apiClient";
import type { ApiUser } from "../apiClient";

// Mock MSAL and env before the module loads
vi.mock("../msalInstance", () => ({
  msalInstance: {
    getAllAccounts: vi.fn(() => []),
    acquireTokenSilent: vi.fn(),
  },
}));

vi.mock("../msalConfig", () => ({
  apiRequest: { scopes: [] },
  loginRequest: { scopes: [] },
}));

// =============================================================================
// Token / User localStorage helpers
// =============================================================================

describe("apiClient localStorage helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("getStoredToken", () => {
    it("returns null when no token is stored", () => {
      expect(getStoredToken()).toBeNull();
    });

    it("returns the stored token", () => {
      localStorage.setItem("pronghorn_auth_token", "my-token");
      expect(getStoredToken()).toBe("my-token");
    });

    it("migrates legacy auth_token to new key", () => {
      localStorage.setItem("auth_token", "legacy-token");
      const token = getStoredToken();
      expect(token).toBe("legacy-token");
      // Should have been migrated
      expect(localStorage.getItem("pronghorn_auth_token")).toBe("legacy-token");
      expect(localStorage.getItem("auth_token")).toBeNull();
    });

    it("prefers new key over legacy key", () => {
      localStorage.setItem("pronghorn_auth_token", "new-token");
      localStorage.setItem("auth_token", "legacy-token");
      expect(getStoredToken()).toBe("new-token");
    });
  });

  describe("getStoredUser", () => {
    it("returns null when no user is stored", () => {
      expect(getStoredUser()).toBeNull();
    });

    it("returns the stored user", () => {
      const user: ApiUser = { id: "1", email: "test@example.com", name: "Test" };
      localStorage.setItem("pronghorn_auth_user", JSON.stringify(user));
      const stored = getStoredUser();
      expect(stored).toEqual(user);
    });
  });

  describe("setAuthData", () => {
    it("stores token and user", () => {
      const user: ApiUser = { id: "1", email: "test@example.com" };
      setAuthData("token-123", user);
      expect(localStorage.getItem("pronghorn_auth_token")).toBe("token-123");
      expect(JSON.parse(localStorage.getItem("pronghorn_auth_user")!)).toEqual(user);
    });
  });

  describe("clearAuthData", () => {
    it("removes all auth keys", () => {
      localStorage.setItem("pronghorn_auth_token", "token");
      localStorage.setItem("pronghorn_auth_user", "user");
      localStorage.setItem("auth_token", "legacy");
      clearAuthData();
      expect(localStorage.getItem("pronghorn_auth_token")).toBeNull();
      expect(localStorage.getItem("pronghorn_auth_user")).toBeNull();
      expect(localStorage.getItem("auth_token")).toBeNull();
    });

    it("does not throw when keys do not exist", () => {
      expect(() => clearAuthData()).not.toThrow();
    });
  });
});

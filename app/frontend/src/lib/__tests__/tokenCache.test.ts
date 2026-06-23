import { describe, it, expect, beforeEach } from "vitest";
import { setProjectToken, getProjectToken, clearProjectToken } from "../tokenCache";

const STORAGE_KEY_PREFIX = "pronghorn_token_";

describe("tokenCache", () => {
  beforeEach(() => {
    sessionStorage.clear();
    // Clear module-level memory cache by cycling set/clear for known keys
    clearProjectToken("proj-1");
    clearProjectToken("proj-2");
  });

  // =========================================================================
  // setProjectToken / getProjectToken
  // =========================================================================

  describe("setProjectToken + getProjectToken", () => {
    it("stores and retrieves a token", () => {
      setProjectToken("proj-1", "secret-token");
      expect(getProjectToken("proj-1")).toBe("secret-token");
    });

    it("persists to sessionStorage", () => {
      setProjectToken("proj-1", "secret-token");
      expect(sessionStorage.getItem(`${STORAGE_KEY_PREFIX}proj-1`)).toBe("secret-token");
    });

    it("overwrites previous token for same project", () => {
      setProjectToken("proj-1", "old-token");
      setProjectToken("proj-1", "new-token");
      expect(getProjectToken("proj-1")).toBe("new-token");
    });

    it("stores tokens independently per project", () => {
      setProjectToken("proj-1", "token-a");
      setProjectToken("proj-2", "token-b");
      expect(getProjectToken("proj-1")).toBe("token-a");
      expect(getProjectToken("proj-2")).toBe("token-b");
    });
  });

  // =========================================================================
  // getProjectToken — fallback to sessionStorage
  // =========================================================================

  describe("getProjectToken", () => {
    it("returns null for unknown project", () => {
      expect(getProjectToken("unknown")).toBeNull();
    });

    it("falls back to sessionStorage when memory cache is empty", () => {
      // Write directly to sessionStorage (simulating a page refresh scenario)
      sessionStorage.setItem(`${STORAGE_KEY_PREFIX}proj-1`, "stored-token");
      // Since memory cache is cleared in beforeEach, this tests the fallback
      expect(getProjectToken("proj-1")).toBe("stored-token");
    });
  });

  // =========================================================================
  // clearProjectToken
  // =========================================================================

  describe("clearProjectToken", () => {
    it("removes token from both caches", () => {
      setProjectToken("proj-1", "secret");
      clearProjectToken("proj-1");
      expect(getProjectToken("proj-1")).toBeNull();
      expect(sessionStorage.getItem(`${STORAGE_KEY_PREFIX}proj-1`)).toBeNull();
    });

    it("does not affect other projects", () => {
      setProjectToken("proj-1", "token-a");
      setProjectToken("proj-2", "token-b");
      clearProjectToken("proj-1");
      expect(getProjectToken("proj-2")).toBe("token-b");
    });

    it("is safe to call on nonexistent project", () => {
      expect(() => clearProjectToken("nonexistent")).not.toThrow();
    });
  });
});

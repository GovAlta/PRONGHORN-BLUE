import { describe, it, expect } from "vitest";
import {
  apiUserToUser,
  createSession,
} from "../authTypes";
import type { ApiUser, User } from "../authTypes";

// =============================================================================
// apiUserToUser
// =============================================================================

describe("apiUserToUser", () => {
  it("returns null for null input", () => {
    expect(apiUserToUser(null)).toBeNull();
  });

  it("converts API user to User type", () => {
    const apiUser: ApiUser = {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
      role: "admin",
    };

    const user = apiUserToUser(apiUser);
    expect(user).not.toBeNull();
    expect(user!.id).toBe("user-123");
    expect(user!.email).toBe("test@example.com");
    expect(user!.aud).toBe("authenticated");
    expect(user!.user_metadata.name).toBe("Test User");
    expect(user!.role).toBe("admin");
    expect(user!.app_metadata).toEqual({});
  });

  it("handles user without optional fields", () => {
    const apiUser: ApiUser = {
      id: "user-456",
      email: "minimal@example.com",
    };

    const user = apiUserToUser(apiUser);
    expect(user).not.toBeNull();
    expect(user!.id).toBe("user-456");
    expect(user!.email).toBe("minimal@example.com");
    expect(user!.user_metadata.name).toBeUndefined();
    expect(user!.role).toBeUndefined();
  });

  it("includes created_at timestamp", () => {
    const before = new Date().toISOString();
    const user = apiUserToUser({ id: "1", email: "a@b.com" });
    const after = new Date().toISOString();
    expect(user!.created_at).toBeDefined();
    expect(user!.created_at! >= before).toBe(true);
    expect(user!.created_at! <= after).toBe(true);
  });
});

// =============================================================================
// createSession
// =============================================================================

describe("createSession", () => {
  const mockUser: User = {
    id: "user-123",
    email: "test@example.com",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: { name: "Test" },
  };

  it("returns null when token is empty", () => {
    expect(createSession("", mockUser)).toBeNull();
  });

  it("returns null when user is null", () => {
    expect(createSession("valid-token", null)).toBeNull();
  });

  it("returns null when both token and user are empty/null", () => {
    expect(createSession("", null)).toBeNull();
  });

  it("creates a valid session", () => {
    const session = createSession("my-token-123", mockUser);
    expect(session).not.toBeNull();
    expect(session!.access_token).toBe("my-token-123");
    expect(session!.token_type).toBe("bearer");
    expect(session!.expires_in).toBe(3600);
    expect(session!.refresh_token).toBe("");
    expect(session!.user).toBe(mockUser);
  });

  it("preserves user reference in session", () => {
    const session = createSession("token", mockUser);
    expect(session!.user.id).toBe("user-123");
    expect(session!.user.email).toBe("test@example.com");
  });
});

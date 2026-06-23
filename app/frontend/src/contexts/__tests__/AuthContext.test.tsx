import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock MSAL before importing AuthContext (lightweight mocks to avoid OOM)
// ---------------------------------------------------------------------------

vi.mock("@azure/msal-browser", () => ({
  InteractionStatus: { None: "none" },
}));

vi.mock("@azure/msal-react", () => ({
  useMsal: () => ({
    instance: {
      loginPopup: vi.fn(),
      logoutPopup: vi.fn(),
      acquireTokenSilent: vi.fn().mockResolvedValue({ idToken: "t" }),
      acquireTokenPopup: vi.fn(),
      setActiveAccount: vi.fn(),
    },
    accounts: [],
    inProgress: "none",
  }),
  useIsAuthenticated: () => false,
  useAccount: () => null,
}));

vi.mock("@/lib/msalConfig", () => ({
  loginRequest: { scopes: [] },
  popupRedirectUri: "/",
}));

import { useAuth } from "@/contexts/AuthContext";

// Minimal consumer that calls useAuth outside a provider
function BadConsumer() {
  useAuth();
  return null;
}

describe("AuthContext", () => {
  it("useAuth throws when used outside AuthProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<BadConsumer />)).toThrow(
      "useAuth must be used within AuthProvider"
    );
    spy.mockRestore();
  });
});

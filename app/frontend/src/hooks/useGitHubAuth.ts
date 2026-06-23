/**
 * useGitHubAuth — React hook for GitHub OAuth connection state.
 *
 * Fetches the user's GitHub connection status from the API and provides
 * helpers to initiate the OAuth flow and disconnect.
 *
 * @example
 * const { connected, githubUsername, connect, disconnect, loading } = useGitHubAuth();
 */
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const APIM_SUBSCRIPTION_KEY = import.meta.env.VITE_APIM_SUBSCRIPTION_KEY || "";

interface GitHubAuthState {
  connected: boolean;
  githubUsername: string | null;
  loading: boolean;
  error: string | null;
}

export function useGitHubAuth() {
  const { user, getAccessToken } = useAuth();

  /**
   * Build auth headers using the AuthContext token (which supports interactive
   * fallback via acquireTokenPopup when the silent refresh token has expired).
   */
  const getAuthHeaders = useCallback(async (): Promise<HeadersInit> => {
    const headers: HeadersInit = { "Content-Type": "application/json" };

    const token = await getAccessToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (APIM_SUBSCRIPTION_KEY) {
      (headers as Record<string, string>)["Ocp-Apim-Subscription-Key"] =
        APIM_SUBSCRIPTION_KEY;
    }

    return headers;
  }, [getAccessToken]);
  const [authState, setState] = useState<GitHubAuthState>({
    connected: false,
    githubUsername: null,
    loading: true,
    error: null,
  });

  const fetchStatus = useCallback(async () => {
    if (!user) {
      setState({
        connected: false,
        githubUsername: null,
        loading: false,
        error: null,
      });
      return;
    }

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_BASE_URL}/api/v1/github/auth/status`, {
        headers,
      });

      if (!res.ok) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: "Failed to check GitHub status",
        }));
        return;
      }

      const data = await res.json();
      setState({
        connected: data.connected,
        githubUsername: data.githubUsername || null,
        loading: false,
        error: null,
      });
    } catch (err: unknown) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }));
    }
  }, [user, getAuthHeaders]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  /**
   * Initiate the GitHub OAuth flow.
   * Opens GitHub authorization in the current window.
   */
  const connect = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_BASE_URL}/api/v1/github/auth/url`, {
        headers,
      });

      if (!res.ok) {
        const data = await res.json();
        setState((prev) => ({
          ...prev,
          error: data.error || "Failed to get auth URL",
        }));
        return;
      }

      const { url, state: oauthState } = await res.json();

      // The OAuth `state` is a random anti-CSRF nonce (not a credential). It is
      // also sent in the authorization URL and must survive the cross-origin
      // redirect to GitHub and back, so it is persisted in sessionStorage by
      // design and validated on return. It carries no sensitive data.
      // codeql[js/clear-text-storage-of-sensitive-data]
      sessionStorage.setItem("github_oauth_state", oauthState);
      sessionStorage.setItem("github_oauth_return", window.location.href);

      window.location.href = url;
    } catch (err: unknown) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : "Unknown error",
      }));
    }
  }, [getAuthHeaders]);

  /**
   * Complete the OAuth flow after redirect (called with code + state from URL params).
   */
  const completeAuth = useCallback(
    async (code: string, returnedState: string): Promise<boolean> => {
      const savedState = sessionStorage.getItem("github_oauth_state");
      if (savedState && savedState !== returnedState) {
        setState((prev) => ({
          ...prev,
          error: "OAuth state mismatch — possible CSRF. Please try again.",
        }));
        return false;
      }

      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${API_BASE_URL}/api/v1/github/auth/callback`, {
          method: "POST",
          headers,
          body: JSON.stringify({ code, state: returnedState }),
        });

        if (!res.ok) {
          const data = await res.json();
          setState((prev) => ({
            ...prev,
            error: data.error || "GitHub authorization failed",
          }));
          return false;
        }

        const data = await res.json();
        setState({
          connected: true,
          githubUsername: data.githubUsername,
          loading: false,
          error: null,
        });

        // Clean up session storage
        sessionStorage.removeItem("github_oauth_state");
        sessionStorage.removeItem("github_oauth_return");

        return true;
      } catch (err: unknown) {
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : "Unknown error",
        }));
        return false;
      }
    },
    [getAuthHeaders],
  );

  /**
   * Disconnect the user's GitHub account.
   */
  const disconnect = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_BASE_URL}/api/v1/github/auth/disconnect`, {
        method: "DELETE",
        headers,
      });

      if (res.ok) {
        setState({
          connected: false,
          githubUsername: null,
          loading: false,
          error: null,
        });
      }
    } catch (err: unknown) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : "Unknown error",
      }));
    }
  }, [getAuthHeaders]);

  return {
    ...authState,
    connect,
    completeAuth,
    disconnect,
    refetch: fetchStatus,
  };
}

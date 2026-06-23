/**
 * GitHubCallback — handles the OAuth redirect from GitHub.
 *
 * Reads `code` and `state` from the URL query params, completes the
 * token exchange via the API, then navigates back to the page the
 * user came from (stored in sessionStorage).
 */
import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useGitHubAuth } from "@/hooks/useGitHubAuth";
import { Loader2, CheckCircle, XCircle } from "lucide-react";

export default function GitHubCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { completeAuth, error: authError } = useGitHubAuth();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const error = searchParams.get("error");

    if (error) {
      setStatus("error");
      setErrorMsg(searchParams.get("error_description") || "GitHub authorization was denied.");
      return;
    }

    if (!code || !state) {
      setStatus("error");
      setErrorMsg("Missing authorization code or state parameter.");
      return;
    }

    const storedReturnUrl = sessionStorage.getItem("github_oauth_return");
    let returnUrl = "/dashboard";

    if (storedReturnUrl) {
      try {
        const parsedReturnUrl = new URL(storedReturnUrl, window.location.origin);
        if (parsedReturnUrl.origin === window.location.origin) {
          returnUrl = `${parsedReturnUrl.pathname}${parsedReturnUrl.search}${parsedReturnUrl.hash}`;
        }
      } catch {
        if (storedReturnUrl.startsWith("/")) {
          returnUrl = storedReturnUrl;
        }
      }
    }

    completeAuth(code, state).then((ok) => {
      if (ok) {
        setStatus("success");
        sessionStorage.removeItem("github_oauth_return");
        setTimeout(() => navigate(returnUrl, { replace: true }), 1500);
      } else {
        setStatus("error");
        // authError is set by completeAuth with the actual API error message
        setErrorMsg(authError || "Token exchange failed. Please try again.");
      }
    });
  }, [searchParams, completeAuth, navigate, authError]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center space-y-4">
        {status === "loading" && (
          <>
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
            <p className="text-lg font-medium">Connecting your GitHub account…</p>
          </>
        )}
        {status === "success" && (
          <>
            <CheckCircle className="h-8 w-8 mx-auto text-green-600" />
            <p className="text-lg font-medium">GitHub connected! Redirecting…</p>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle className="h-8 w-8 mx-auto text-destructive" />
            <p className="text-lg font-medium">GitHub connection failed</p>
            <p className="text-sm text-muted-foreground">{errorMsg}</p>
            <button
              className="mt-4 text-sm underline text-primary"
              onClick={() => navigate("/dashboard", { replace: true })}
            >
              Back to Dashboard
            </button>
          </>
        )}
      </div>
    </div>
  );
}

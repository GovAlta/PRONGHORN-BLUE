/**
 * GitHubConnectBanner — shows GitHub connection status and connect/disconnect actions.
 *
 * Displayed on the Repository page. When the user hasn't connected GitHub,
 * it prompts them to authorize via the GitHub OAuth flow.
 *
 * @example
 * <GitHubConnectBanner />
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useGitHubAuth } from "@/hooks/useGitHubAuth";
import { GitBranch, CheckCircle, LogOut, Loader2 } from "lucide-react";

export function GitHubConnectBanner() {
  const { connected, githubUsername, loading, error, connect, disconnect } = useGitHubAuth();

  if (loading) {
    return (
      <Card className="border-muted">
        <CardContent className="flex items-center gap-3 py-3">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Checking GitHub connection…</span>
        </CardContent>
      </Card>
    );
  }

  if (connected) {
    return (
      <Card className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30">
        <CardContent className="flex items-center justify-between py-3">
          <div className="flex items-center gap-3">
            <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
            <span className="text-sm font-medium">
              Connected to GitHub as <strong>{githubUsername}</strong>
            </span>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                <LogOut className="h-3 w-3 mr-1" />
                Disconnect
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect from GitHub?</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to disconnect your GitHub account
                  (<strong>{githubUsername}</strong>)? You will need to reconnect
                  before creating or managing repositories.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={disconnect}>Disconnect</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30">
      <CardContent className="flex items-center justify-between py-3">
        <div className="flex items-center gap-3">
          <GitBranch className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <div>
            <span className="text-sm font-medium">Connect your GitHub account</span>
            <p className="text-xs text-muted-foreground">
              Authorize Pronghorn to create and manage repositories on your behalf — no personal access tokens needed.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={connect}>
          <GitBranch className="h-3 w-3 mr-1" />
          Connect GitHub
        </Button>
      </CardContent>
      {error && <p className="px-6 pb-3 text-xs text-destructive">{error}</p>}
    </Card>
  );
}

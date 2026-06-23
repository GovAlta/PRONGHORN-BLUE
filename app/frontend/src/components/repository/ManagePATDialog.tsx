import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Key, Trash2, AlertTriangle } from "lucide-react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

interface ManagePATDialogProps {
  repoId: string;
  repoName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ManagePATDialog({
  repoId,
  repoName,
  open,
  onOpenChange,
}: ManagePATDialogProps) {
  const [pat, setPat] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();

  const handleSavePAT = async () => {
    if (!user) {
      toast({
        title: "Authentication required",
        description: "You must be logged in to store a PAT",
        variant: "destructive",
      });
      return;
    }

    if (!pat.trim()) {
      toast({
        title: "PAT required",
        description: "Please enter a valid Personal Access Token",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      const { error } = await pronghornApi.rpc("insert_repo_pat_with_token", {
        p_repo_id: repoId,
        p_pat: pat,
      });

      if (error) throw error;

      toast({
        title: "PAT saved",
        description: "Personal Access Token has been securely stored",
      });

      setPat("");
      onOpenChange(false);
    } catch (error: any) {
      console.error("Error saving PAT:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to save PAT",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeletePAT = async () => {
    if (!user) {
      toast({
        title: "Authentication required",
        description: "You must be logged in to delete a PAT",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      const { error } = await pronghornApi.rpc("delete_repo_pat_with_token", {
        p_repo_id: repoId,
      });

      if (error) throw error;

      toast({
        title: "PAT deleted",
        description: "Personal Access Token has been removed",
      });

      onOpenChange(false);
    } catch (error: any) {
      console.error("Error deleting PAT:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to delete PAT",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage Personal Access Token</DialogTitle>
          <DialogDescription>
            For repository: {repoName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              PATs grant write access to your repositories. Use fine-grained tokens with
              minimal permissions. Tokens are encrypted and never exposed to clients.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label htmlFor="pat">Personal Access Token</Label>
            <Input
              id="pat"
              type="password"
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Create a token at{" "}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                github.com/settings/tokens
              </a>
            </p>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="destructive"
            onClick={handleDeletePAT}
            disabled={loading}
            className="w-full sm:w-auto"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete PAT
          </Button>
          <Button
            onClick={handleSavePAT}
            disabled={loading}
            className="w-full sm:w-auto"
          >
            <Key className="h-4 w-4 mr-2" />
            Save PAT
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

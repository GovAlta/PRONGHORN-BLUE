import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Link } from "lucide-react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { toast } from "sonner";

interface AddSharedProjectDialogProps {
  onSuccess?: () => void;
}

export function AddSharedProjectDialog({ onSuccess }: AddSharedProjectDialogProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const parseInput = (value: string): { projectId: string; token: string } | null => {
    const trimmed = value.trim();
    
    // Try to parse as URL with /t/{token} pattern
    const urlMatch = trimmed.match(/\/project\/([a-f0-9-]+)\/[^/]+\/t\/([a-f0-9-]+)/i);
    if (urlMatch) {
      return { projectId: urlMatch[1], token: urlMatch[2] };
    }

    // Try to parse as URL with ?token= query parameter (legacy)
    const queryMatch = trimmed.match(/\/project\/([a-f0-9-]+).*[?&]token=([a-f0-9-]+)/i);
    if (queryMatch) {
      return { projectId: queryMatch[1], token: queryMatch[2] };
    }

    // Try to parse as just a token (UUID format)
    const uuidMatch = trimmed.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
    if (uuidMatch) {
      // Just a token - user needs to provide project ID separately
      return null; // We'd need both
    }

    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const parsed = parseInput(input);
    if (!parsed) {
      toast.error("Invalid URL format. Please paste the full project URL including the share token.");
      return;
    }

    setIsLoading(true);
    try {
      const { data, error } = await pronghornApi.rpc("link_shared_project", {
        p_project_id: parsed.projectId,
        p_token: parsed.token
      });

      if (error) {
        if (error.message.includes("Cannot link your own project")) {
          toast.error("You already own this project");
        } else if (error.message.includes("Invalid") || error.message.includes("Access denied")) {
          toast.error("Invalid or expired share token");
        } else {
          throw error;
        }
        return;
      }

      toast.success(`Project "${(data as any)?.project_name}" added to your dashboard!`);
      setInput("");
      setOpen(false);
      onSuccess?.();
    } catch (error) {
      console.error("Error linking project:", error);
      toast.error("Failed to add project. Please check the URL and try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Add Shared Project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="h-5 w-5" />
            Add Shared Project
          </DialogTitle>
          <DialogDescription>
            Paste a project URL that was shared with you to add it to your dashboard.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="projectUrl">Project URL</Label>
            <Input
              id="projectUrl"
              placeholder="https://...project/abc123/settings/t/token123"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              The URL should include the share token (e.g., /t/abc123...)
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || !input.trim()}>
              {isLoading ? "Adding..." : "Add Project"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

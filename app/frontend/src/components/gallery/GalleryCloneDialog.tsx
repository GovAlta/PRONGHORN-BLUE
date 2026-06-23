import { useState, useEffect } from "react";
import { Copy, Loader2 } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

interface GalleryCloneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publishedId: string;
  projectName: string;
}

interface CloneOptions {
  cloneChat: boolean;
  cloneArtifacts: boolean;
  cloneRequirements: boolean;
  cloneStandards: boolean;
  cloneSpecifications: boolean;
  cloneCanvas: boolean;
  cloneRepoFiles: boolean;
  cloneTechStacks: boolean;
}

export function GalleryCloneDialog({
  open,
  onOpenChange,
  publishedId,
  projectName,
}: GalleryCloneDialogProps) {
  const [newName, setNewName] = useState(`Copy of ${projectName}`);
  const [isCloning, setIsCloning] = useState(false);
  const [options, setOptions] = useState<CloneOptions>({
    cloneChat: false,
    cloneArtifacts: false,
    cloneRequirements: true,
    cloneStandards: true,
    cloneSpecifications: false,
    cloneCanvas: true,
    cloneRepoFiles: false,
    cloneTechStacks: true,
  });

  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Reset name when project changes
  useEffect(() => {
    setNewName(`Copy of ${projectName}`);
  }, [projectName]);

  const handleOptionChange = (key: keyof CloneOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleClone = async () => {
    if (!newName.trim()) {
      toast({
        title: "Name required",
        description: "Please enter a name for the cloned project.",
        variant: "destructive",
      });
      return;
    }

    setIsCloning(true);

    try {
      const { data, error } = await pronghornApi.rpc("clone_published_project", {
        p_published_id: publishedId,
        p_new_name: newName.trim(),
        p_clone_chat: options.cloneChat,
        p_clone_artifacts: options.cloneArtifacts,
        p_clone_requirements: options.cloneRequirements,
        p_clone_standards: options.cloneStandards,
        p_clone_specifications: options.cloneSpecifications,
        p_clone_canvas: options.cloneCanvas,
        p_clone_repo_files: options.cloneRepoFiles,
        p_clone_tech_stacks: options.cloneTechStacks,
        p_clone_databases: false, // Never clone databases for security
      });

      if (error) throw error;

      const result = Array.isArray(data) ? data[0] : data;

      if (!result || !result.id || !result.share_token) {
        throw new Error("Failed to clone project - invalid response");
      }

      toast({
        title: "Project cloned!",
        description: `"${newName}" has been created successfully.`,
      });

      // Invalidate queries
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["published-projects"] });

      onOpenChange(false);

      // Navigate to the new project
      navigate(`/project/${result.id}/settings/t/${result.share_token}`);
    } catch (error) {
      console.error("Clone error:", error);
      toast({
        title: "Clone failed",
        description: error instanceof Error ? error.message : "Failed to clone project",
        variant: "destructive",
      });
    } finally {
      setIsCloning(false);
    }
  };

  const optionItems: { key: keyof CloneOptions; label: string; description: string }[] = [
    { key: "cloneRequirements", label: "Requirements", description: "Copy the entire requirements tree" },
    { key: "cloneStandards", label: "Standards", description: "Copy linked standards" },
    { key: "cloneTechStacks", label: "Tech Stacks", description: "Copy linked tech stacks" },
    { key: "cloneCanvas", label: "Canvas", description: "Copy all nodes, edges, and layers" },
    { key: "cloneSpecifications", label: "Specifications", description: "Copy generated specifications" },
    { key: "cloneChat", label: "Chat Sessions", description: "Copy all chat history" },
    { key: "cloneArtifacts", label: "Artifacts", description: "Copy uploaded artifacts" },
    { key: "cloneRepoFiles", label: "Repository Files", description: "Copy committed files" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Clone from Gallery</DialogTitle>
          <DialogDescription>
            Create your own copy of "{projectName}" with selected components.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="new-name">New Project Name</Label>
            <Input
              id="new-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Enter project name"
            />
          </div>

          <div className="space-y-3">
            <Label>What to clone</Label>
            <div className="space-y-2 max-h-[240px] overflow-y-auto pr-2">
              {optionItems.map(({ key, label, description }) => (
                <div
                  key={key}
                  className="flex items-start space-x-3 p-2 rounded-md hover:bg-muted/50 transition-colors"
                >
                  <Checkbox
                    id={key}
                    checked={options[key]}
                    onCheckedChange={() => handleOptionChange(key)}
                    className="mt-0.5"
                  />
                  <div className="space-y-0.5">
                    <label
                      htmlFor={key}
                      className="text-sm font-medium leading-none cursor-pointer"
                    >
                      {label}
                    </label>
                    <p className="text-xs text-muted-foreground">{description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCloning}>
            Cancel
          </Button>
          <Button onClick={handleClone} disabled={isCloning}>
            {isCloning ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Cloning...
              </>
            ) : (
              <>
                <Copy className="mr-2 h-4 w-4" />
                Clone Project
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

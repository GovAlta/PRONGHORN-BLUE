import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Folder, FolderOpen, ChevronRight, ChevronDown, Home, MoveRight } from "lucide-react";
import { Artifact, buildArtifactHierarchy, getAllDescendantIds } from "@/hooks/useRealtimeArtifacts";
import { cn } from "@/lib/utils";

interface MoveArtifactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifact: Artifact | null;
  artifacts: Artifact[];
  onMove: (artifactId: string, newParentId: string | null) => Promise<void>;
}

interface FolderNodeProps {
  folder: Artifact;
  level: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  disabledIds: Set<string>;
}

function FolderNode({ folder, level, selectedId, onSelect, disabledIds }: FolderNodeProps) {
  const [isExpanded, setIsExpanded] = useState(level < 2);
  const hasChildren = folder.children?.some(c => c.is_folder) || false;
  const isDisabled = disabledIds.has(folder.id);
  const isSelected = selectedId === folder.id;

  const folderChildren = folder.children?.filter(c => c.is_folder) || [];

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 py-1.5 px-2 rounded-md cursor-pointer transition-colors",
          isSelected && "bg-primary text-primary-foreground",
          !isSelected && !isDisabled && "hover:bg-muted",
          isDisabled && "opacity-50 cursor-not-allowed"
        )}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => !isDisabled && onSelect(folder.id)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            className="p-0.5 hover:bg-muted rounded"
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <div className="w-4" />
        )}
        {isExpanded ? (
          <FolderOpen className="h-4 w-4 flex-shrink-0 text-amber-500" />
        ) : (
          <Folder className="h-4 w-4 flex-shrink-0 text-amber-500" />
        )}
        <span className="text-sm truncate">{folder.ai_title || "Untitled Folder"}</span>
      </div>
      {isExpanded && folderChildren.length > 0 && (
        <div>
          {folderChildren.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              level={level + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              disabledIds={disabledIds}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function MoveArtifactDialog({
  open,
  onOpenChange,
  artifact,
  artifacts,
  onMove,
}: MoveArtifactDialogProps) {
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null);
  const [isMoving, setIsMoving] = useState(false);

  // Build hierarchy for folder tree
  const folderTree = useMemo(() => {
    return buildArtifactHierarchy(artifacts.filter(a => a.is_folder));
  }, [artifacts]);

  // Get disabled folder IDs (the artifact itself and its descendants if it's a folder)
  const disabledIds = useMemo(() => {
    if (!artifact) return new Set<string>();
    if (!artifact.is_folder) return new Set<string>();
    
    const tree = buildArtifactHierarchy(artifacts);
    const artifactNode = artifacts.find(a => a.id === artifact.id);
    if (!artifactNode) return new Set<string>();
    
    // Find the artifact in the tree and get all descendant IDs
    const findInTree = (items: Artifact[]): Artifact | null => {
      for (const item of items) {
        if (item.id === artifact.id) return item;
        if (item.children) {
          const found = findInTree(item.children);
          if (found) return found;
        }
      }
      return null;
    };
    
    const node = findInTree(tree);
    if (!node) return new Set([artifact.id]);
    
    return new Set(getAllDescendantIds(node));
  }, [artifact, artifacts]);

  const handleMove = async () => {
    if (!artifact) return;
    
    setIsMoving(true);
    try {
      await onMove(artifact.id, selectedParentId);
      onOpenChange(false);
    } finally {
      setIsMoving(false);
    }
  };

  const isRootSelected = selectedParentId === null;
  const currentParentId = artifact?.parent_id || null;
  const hasChanged = selectedParentId !== currentParentId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MoveRight className="h-5 w-5" />
            Move Artifact
          </DialogTitle>
          <DialogDescription>
            Select a destination folder for "{artifact?.ai_title || artifact?.is_folder ? "folder" : "artifact"}"
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <ScrollArea className="h-[300px] border rounded-md p-2">
            {/* Root option */}
            <div
              className={cn(
                "flex items-center gap-2 py-1.5 px-2 rounded-md cursor-pointer transition-colors",
                isRootSelected && "bg-primary text-primary-foreground",
                !isRootSelected && "hover:bg-muted"
              )}
              onClick={() => setSelectedParentId(null)}
            >
              <Home className="h-4 w-4" />
              <span className="text-sm font-medium">Root (No folder)</span>
            </div>
            
            {/* Folder tree */}
            {folderTree.map((folder) => (
              <FolderNode
                key={folder.id}
                folder={folder}
                level={0}
                selectedId={selectedParentId}
                onSelect={setSelectedParentId}
                disabledIds={disabledIds}
              />
            ))}
            
            {folderTree.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No folders yet. Create a folder first.
              </p>
            )}
          </ScrollArea>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isMoving}
          >
            Cancel
          </Button>
          <Button onClick={handleMove} disabled={!hasChanged || isMoving}>
            {isMoving ? "Moving..." : "Move Here"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

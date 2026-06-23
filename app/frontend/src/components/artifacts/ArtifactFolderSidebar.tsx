import { useState, useMemo } from "react";
import { 
  ChevronRight, 
  ChevronDown, 
  Folder, 
  FolderOpen, 
  Home,
  FolderPlus,
  FileText,
  Trash2,
  Pencil,
  MoreHorizontal,
  GripVertical
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Artifact, buildArtifactHierarchy, getAllDescendantIds } from "@/hooks/useRealtimeArtifacts";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ArtifactFolderSidebarProps {
  artifacts: Artifact[];
  selectedFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onDropArtifact?: (artifactId: string, targetFolderId: string | null) => void;
  onRenameFolder?: (folderId: string, newName: string) => void;
  onDeleteFolder?: (folderId: string) => void;
  onViewArtifact?: (artifact: Artifact) => void;
}

interface FolderNodeProps {
  folder: Artifact;
  allArtifacts: Artifact[];
  level: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onDropArtifact?: (artifactId: string, targetFolderId: string | null) => void;
  onRenameFolder?: (folderId: string, newName: string) => void;
  onDeleteFolder?: (folderId: string) => void;
  onViewArtifact?: (artifact: Artifact) => void;
}

function FolderNode({ 
  folder, 
  allArtifacts,
  level, 
  selectedId, 
  onSelect, 
  onCreateFolder,
  onDropArtifact,
  onRenameFolder,
  onDeleteFolder,
  onViewArtifact
}: FolderNodeProps) {
  const [isExpanded, setIsExpanded] = useState(level < 2);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(folder.ai_title || "");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  
  // Get child folders and child artifacts
  const childFolders = folder.children?.filter(c => c.is_folder) || [];
  const childArtifacts = folder.children?.filter(c => !c.is_folder) || [];
  const hasChildren = childFolders.length > 0 || childArtifacts.length > 0;
  const isSelected = selectedId === folder.id;
  
  // Count total non-folder descendants
  const totalItemCount = useMemo(() => {
    const countItems = (artifact: Artifact): number => {
      let count = artifact.is_folder ? 0 : 1;
      if (artifact.children) {
        artifact.children.forEach(child => {
          count += countItems(child);
        });
      }
      return count;
    };
    return countItems(folder);
  }, [folder]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    
    const artifactId = e.dataTransfer.getData("artifactId");
    if (artifactId && artifactId !== folder.id && onDropArtifact) {
      // Prevent dropping into descendant
      const descendants = getAllDescendantIds(folder);
      if (!descendants.includes(artifactId)) {
        onDropArtifact(artifactId, folder.id);
      }
    }
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("artifactId", folder.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleRenameSubmit = () => {
    if (renameValue.trim() && renameValue !== folder.ai_title && onRenameFolder) {
      onRenameFolder(folder.id, renameValue.trim());
    }
    setIsRenaming(false);
  };

  const handleDeleteConfirm = () => {
    if (onDeleteFolder) {
      onDeleteFolder(folder.id);
    }
    setDeleteDialogOpen(false);
  };

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-0.5 py-1 px-1 rounded-md cursor-pointer transition-colors text-xs group",
          isSelected && "bg-primary text-primary-foreground",
          !isSelected && "hover:bg-muted",
          isDragOver && "bg-primary/20 ring-2 ring-primary"
        )}
        style={{ paddingLeft: `${level * 10 + 2}px` }}
        onClick={() => onSelect(folder.id)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        draggable
        onDragStart={handleDragStart}
      >
        <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-50 cursor-grab flex-shrink-0" />
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            className="p-0.5 hover:bg-muted/50 rounded flex-shrink-0"
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          <div className="w-4 flex-shrink-0" />
        )}
        {isExpanded ? (
          <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
        ) : (
          <Folder className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
        )}
        {isRenaming ? (
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") setIsRenaming(false);
            }}
            className="h-5 text-xs flex-1 min-w-0 px-1"
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate flex-1 min-w-0">
            {folder.ai_title || "Untitled"}
          </span>
        )}
        {totalItemCount > 0 && !isRenaming && (
          <span className={cn(
            "text-[10px] flex-shrink-0",
            isSelected ? "text-primary-foreground/70" : "text-muted-foreground"
          )}>
            ({totalItemCount})
          </span>
        )}
        {!isRenaming && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-5 w-5 opacity-0 group-hover:opacity-100 flex-shrink-0",
                  isSelected && "hover:bg-primary-foreground/10"
                )}
              >
                <MoreHorizontal className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                onCreateFolder(folder.id);
              }}>
                <FolderPlus className="h-3.5 w-3.5 mr-2" />
                New Subfolder
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                setRenameValue(folder.ai_title || "");
                setIsRenaming(true);
              }}>
                <Pencil className="h-3.5 w-3.5 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteDialogOpen(true);
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                Delete Folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      
      {isExpanded && hasChildren && (
        <div>
          {/* Child folders */}
          {childFolders.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              allArtifacts={allArtifacts}
              level={level + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onCreateFolder={onCreateFolder}
              onDropArtifact={onDropArtifact}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onViewArtifact={onViewArtifact}
            />
          ))}
          {/* Child artifacts */}
          {childArtifacts.map((artifact) => (
            <ArtifactNode
              key={artifact.id}
              artifact={artifact}
              level={level + 1}
              onDropArtifact={onDropArtifact}
              onViewArtifact={onViewArtifact}
            />
          ))}
        </div>
      )}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Folder</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the folder "{folder.ai_title || "Untitled"}". 
              {totalItemCount > 0 && (
                <> The {totalItemCount} item{totalItemCount !== 1 ? "s" : ""} inside will be moved to the root level.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface ArtifactNodeProps {
  artifact: Artifact;
  level: number;
  onDropArtifact?: (artifactId: string, targetFolderId: string | null) => void;
  onViewArtifact?: (artifact: Artifact) => void;
}

function ArtifactNode({ artifact, level, onDropArtifact, onViewArtifact }: ArtifactNodeProps) {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("artifactId", artifact.id);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <div
      className="flex items-center gap-1 py-0.5 px-1 rounded-md hover:bg-muted cursor-pointer transition-colors text-xs group"
      style={{ paddingLeft: `${level * 10 + 18}px` }}
      draggable
      onDragStart={handleDragStart}
      onClick={() => onViewArtifact?.(artifact)}
    >
      <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-50 cursor-grab flex-shrink-0" />
      <FileText className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
      <span className="truncate flex-1 min-w-0 text-muted-foreground">
        {artifact.ai_title || "Untitled"}
      </span>
    </div>
  );
}

export function ArtifactFolderSidebar({
  artifacts,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  onDropArtifact,
  onRenameFolder,
  onDeleteFolder,
  onViewArtifact,
}: ArtifactFolderSidebarProps) {
  const [isDragOverRoot, setIsDragOverRoot] = useState(false);
  
  // Build complete artifact tree (folders with their children)
  const artifactTree = useMemo(() => {
    return buildArtifactHierarchy(artifacts);
  }, [artifacts]);

  // Get only root-level folders for display
  const rootFolders = artifactTree.filter(a => a.is_folder);
  
  // Get root-level artifacts (not in any folder)
  const rootArtifacts = artifactTree.filter(a => !a.is_folder);

  // Count total root-level items (non-folder)
  const totalRootItemCount = useMemo(() => {
    return artifacts.filter(a => !a.is_folder).length;
  }, [artifacts]);

  const handleRootDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOverRoot(true);
  };

  const handleRootDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOverRoot(false);
  };

  const handleRootDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOverRoot(false);
    
    const artifactId = e.dataTransfer.getData("artifactId");
    if (artifactId && onDropArtifact) {
      onDropArtifact(artifactId, null);
    }
  };

  return (
    <div className="w-52 flex-shrink-0 border-r bg-muted/30 flex flex-col">
      <div className="p-2 border-b flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Folders
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onCreateFolder(selectedFolderId)}
          title={selectedFolderId ? "Create Subfolder" : "Create Folder"}
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-1">
          {/* Root option */}
          <div
            className={cn(
              "flex items-center gap-1.5 py-1 px-1.5 rounded-md cursor-pointer transition-colors text-xs",
              selectedFolderId === null && "bg-primary text-primary-foreground",
              selectedFolderId !== null && "hover:bg-muted",
              isDragOverRoot && "bg-primary/20 ring-2 ring-primary"
            )}
            onClick={() => onSelectFolder(null)}
            onDragOver={handleRootDragOver}
            onDragLeave={handleRootDragLeave}
            onDrop={handleRootDrop}
          >
            <Home className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate flex-1">All Artifacts</span>
            {totalRootItemCount > 0 && (
              <span className={cn(
                "text-[10px] flex-shrink-0",
                selectedFolderId === null ? "text-primary-foreground/70" : "text-muted-foreground"
              )}>
                ({totalRootItemCount})
              </span>
            )}
          </div>
          
          {/* Folder tree with artifacts as children */}
          {rootFolders.map((folder) => (
            <FolderNode
              key={folder.id}
              folder={folder}
              allArtifacts={artifacts}
              level={0}
              selectedId={selectedFolderId}
              onSelect={onSelectFolder}
              onCreateFolder={onCreateFolder}
              onDropArtifact={onDropArtifact}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onViewArtifact={onViewArtifact}
            />
          ))}

          {/* Root-level artifacts (outside folders) */}
          {rootArtifacts.map((artifact) => (
            <ArtifactNode
              key={artifact.id}
              artifact={artifact}
              level={0}
              onDropArtifact={onDropArtifact}
              onViewArtifact={onViewArtifact}
            />
          ))}
          
          {rootFolders.length === 0 && rootArtifacts.length === 0 && (
            <p className="text-[10px] text-muted-foreground py-2 px-2 text-center">
              No artifacts yet
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

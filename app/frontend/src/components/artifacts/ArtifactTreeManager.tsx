import { useState, useMemo } from "react";
import { 
  ChevronRight, 
  ChevronDown, 
  Folder, 
  FolderOpen, 
  FileText, 
  Image, 
  MoreVertical,
  Edit2,
  Trash2,
  MoveRight,
  FolderPlus,
  Plus,
  Sparkles,
  Users,
  Copy,
  Link2,
  GripVertical,
  Eye
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Artifact, getAllDescendantIds } from "@/hooks/useRealtimeArtifacts";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

interface ArtifactTreeManagerProps {
  artifacts: Artifact[];
  onEdit: (artifact: Artifact) => void;
  onDelete: (artifact: Artifact) => void;
  onMove: (artifact: Artifact) => void;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (folder: Artifact, newName: string) => void;
  onSummarize: (artifact: Artifact) => void;
  onCollaborate: (artifact: Artifact) => void;
  onClone: (artifact: Artifact) => void;
  onShowRelated: (provenanceId: string) => void;
  onAddArtifact: (parentId: string | null) => void;
  onImageClick?: (url: string, title: string) => void;
  onViewArtifact?: (artifact: Artifact) => void;
  onDropArtifact?: (artifactId: string, targetFolderId: string | null) => void;
  summarizingId: string | null;
}

interface ArtifactNodeProps {
  artifact: Artifact;
  level: number;
  onEdit: (artifact: Artifact) => void;
  onDelete: (artifact: Artifact) => void;
  onMove: (artifact: Artifact) => void;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (folder: Artifact, newName: string) => void;
  onSummarize: (artifact: Artifact) => void;
  onCollaborate: (artifact: Artifact) => void;
  onClone: (artifact: Artifact) => void;
  onShowRelated: (provenanceId: string) => void;
  onAddArtifact: (parentId: string | null) => void;
  onImageClick?: (url: string, title: string) => void;
  onViewArtifact?: (artifact: Artifact) => void;
  onDropArtifact?: (artifactId: string, targetFolderId: string | null) => void;
  summarizingId: string | null;
}

function ArtifactNode({
  artifact,
  level,
  onEdit,
  onDelete,
  onMove,
  onCreateFolder,
  onRenameFolder,
  onSummarize,
  onCollaborate,
  onClone,
  onShowRelated,
  onAddArtifact,
  onImageClick,
  onViewArtifact,
  onDropArtifact,
  summarizingId,
}: ArtifactNodeProps) {
  const [isExpanded, setIsExpanded] = useState(level < 2);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(artifact.ai_title || "");
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const hasChildren = artifact.children && artifact.children.length > 0;
  const isFolder = artifact.is_folder;
  const hasImage = !!artifact.image_url;

  const handleRenameSubmit = () => {
    if (renameValue.trim() && renameValue !== artifact.ai_title) {
      onRenameFolder(artifact, renameValue.trim());
    }
    setIsRenaming(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRenameSubmit();
    } else if (e.key === "Escape") {
      setRenameValue(artifact.ai_title || "");
      setIsRenaming(false);
    }
  };

  const descendantCount = useMemo(() => {
    if (!isFolder || !artifact.children) return 0;
    return getAllDescendantIds(artifact).length - 1; // Exclude self
  }, [artifact, isFolder]);

  // Drag handlers
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("artifactId", artifact.id);
    e.dataTransfer.effectAllowed = "move";
    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!isFolder) return;
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
    if (!isFolder) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    
    const draggedId = e.dataTransfer.getData("artifactId");
    if (draggedId && draggedId !== artifact.id && onDropArtifact) {
      // Prevent dropping into own descendants
      const descendantIds = getAllDescendantIds(artifact);
      if (!descendantIds.includes(draggedId)) {
        onDropArtifact(draggedId, artifact.id);
      }
    }
  };

  const handleRowClick = () => {
    if (isFolder) {
      setIsExpanded(!isExpanded);
    } else if (onViewArtifact) {
      onViewArtifact(artifact);
    }
  };

  return (
    <div className={cn(isDragging && "opacity-50")}>
      <div 
        className={cn(
          "group flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer",
          isDragOver && isFolder && "bg-primary/20 ring-2 ring-primary"
        )}
        style={{ paddingLeft: `${level * 20 + 8}px` }}
        onClick={handleRowClick}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag handle */}
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground/50 flex-shrink-0 cursor-grab active:cursor-grabbing" />

        {/* Expand/collapse button */}
        <div className="w-5 flex-shrink-0">
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
          ) : isFolder ? (
            <div className="w-3.5" />
          ) : null}
        </div>

        {/* Icon */}
        {isFolder ? (
          isExpanded ? (
            <FolderOpen className="h-4 w-4 flex-shrink-0 text-amber-500" />
          ) : (
            <Folder className="h-4 w-4 flex-shrink-0 text-amber-500" />
          )
        ) : hasImage ? (
          <Image className="h-4 w-4 flex-shrink-0 text-blue-500" />
        ) : (
          <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        )}

        {/* Title / Rename input */}
        {isRenaming ? (
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={handleRenameKeyDown}
            className="h-6 text-sm py-0 px-1 flex-1"
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="text-sm truncate flex-1 min-w-0">
            {artifact.ai_title || (isFolder ? "Untitled Folder" : "Untitled Artifact")}
          </span>
        )}

        {/* Badges */}
        {isFolder && descendantCount > 0 && (
          <Badge variant="secondary" className="text-xs px-1.5 py-0">
            {descendantCount}
          </Badge>
        )}
        
        {artifact.provenance_page && artifact.provenance_total_pages && (
          <Badge variant="outline" className="text-xs px-1.5 py-0">
            {artifact.provenance_page}/{artifact.provenance_total_pages}
          </Badge>
        )}

        {/* Image thumbnail */}
        {hasImage && !isFolder && (
          <div 
            className="w-8 h-8 rounded overflow-hidden bg-muted flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/50"
            onClick={(e) => {
              e.stopPropagation();
              onImageClick?.(artifact.image_url!, artifact.ai_title || "");
            }}
          >
            <img 
              src={artifact.image_url!} 
              alt="" 
              className="w-full h-full object-cover"
            />
          </div>
        )}

        {/* Date */}
        <span className="text-xs text-muted-foreground hidden md:inline flex-shrink-0">
          {format(new Date(artifact.created_at), "MMM d")}
        </span>

        {/* Quick view button for non-folders */}
        {!isFolder && onViewArtifact && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onViewArtifact(artifact);
            }}
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
        )}

        {/* Actions menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {isFolder ? (
              <>
                <DropdownMenuItem onClick={() => {
                  setRenameValue(artifact.ai_title || "");
                  setIsRenaming(true);
                }}>
                  <Edit2 className="h-4 w-4 mr-2" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCreateFolder(artifact.id)}>
                  <FolderPlus className="h-4 w-4 mr-2" />
                  New Subfolder
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAddArtifact(artifact.id)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Artifact Here
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onMove(artifact)}>
                  <MoveRight className="h-4 w-4 mr-2" />
                  Move
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem 
                  onClick={() => onDelete(artifact)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Folder
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem onClick={() => onViewArtifact?.(artifact)}>
                  <Eye className="h-4 w-4 mr-2" />
                  View
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onEdit(artifact)}>
                  <Edit2 className="h-4 w-4 mr-2" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSummarize(artifact)} disabled={summarizingId === artifact.id}>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Generate Summary
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCollaborate(artifact)}>
                  <Users className="h-4 w-4 mr-2" />
                  Collaborate
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onClone(artifact)}>
                  <Copy className="h-4 w-4 mr-2" />
                  Clone
                </DropdownMenuItem>
                {artifact.provenance_id && (
                  <DropdownMenuItem onClick={() => onShowRelated(artifact.provenance_id!)}>
                    <Link2 className="h-4 w-4 mr-2" />
                    Show Related
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onMove(artifact)}>
                  <MoveRight className="h-4 w-4 mr-2" />
                  Move to Folder
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem 
                  onClick={() => onDelete(artifact)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Children */}
      {isExpanded && hasChildren && (
        <div>
          {artifact.children!.map((child) => (
            <ArtifactNode
              key={child.id}
              artifact={child}
              level={level + 1}
              onEdit={onEdit}
              onDelete={onDelete}
              onMove={onMove}
              onCreateFolder={onCreateFolder}
              onRenameFolder={onRenameFolder}
              onSummarize={onSummarize}
              onCollaborate={onCollaborate}
              onClone={onClone}
              onShowRelated={onShowRelated}
              onAddArtifact={onAddArtifact}
              onImageClick={onImageClick}
              onViewArtifact={onViewArtifact}
              onDropArtifact={onDropArtifact}
              summarizingId={summarizingId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ArtifactTreeManager({
  artifacts,
  onEdit,
  onDelete,
  onMove,
  onCreateFolder,
  onRenameFolder,
  onSummarize,
  onCollaborate,
  onClone,
  onShowRelated,
  onAddArtifact,
  onImageClick,
  onViewArtifact,
  onDropArtifact,
  summarizingId,
}: ArtifactTreeManagerProps) {
  const [isDragOverRoot, setIsDragOverRoot] = useState(false);

  const handleRootDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOverRoot(true);
  };

  const handleRootDragLeave = () => {
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

  if (artifacts.length === 0) {
    return (
      <div 
        className={cn(
          "text-center py-8 text-muted-foreground border rounded-md",
          isDragOverRoot && "bg-primary/10 ring-2 ring-primary"
        )}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
      >
        No artifacts yet. Create a folder or add an artifact to get started.
      </div>
    );
  }

  return (
    <div 
      className={cn(
        "space-y-0.5 border rounded-md p-2 bg-card",
        isDragOverRoot && "ring-2 ring-primary"
      )}
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDrop={handleRootDrop}
    >
      {artifacts.map((artifact) => (
        <ArtifactNode
          key={artifact.id}
          artifact={artifact}
          level={0}
          onEdit={onEdit}
          onDelete={onDelete}
          onMove={onMove}
          onCreateFolder={onCreateFolder}
          onRenameFolder={onRenameFolder}
          onSummarize={onSummarize}
          onCollaborate={onCollaborate}
          onClone={onClone}
          onShowRelated={onShowRelated}
          onAddArtifact={onAddArtifact}
          onImageClick={onImageClick}
          onViewArtifact={onViewArtifact}
          onDropArtifact={onDropArtifact}
          summarizingId={summarizingId}
        />
      ))}
    </div>
  );
}

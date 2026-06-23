import { useState, useEffect, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  AlertTriangle, 
  List, 
  LayoutGrid, 
  FileText, 
  Folder, 
  FolderOpen,
  ChevronRight,
  ChevronDown,
  TreePine
} from "lucide-react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { cn } from "@/lib/utils";
import { Artifact, buildArtifactHierarchy, getAllDescendantIds } from "@/hooks/useRealtimeArtifacts";

interface ArtifactsListSelectorProps {
  projectId: string;
  shareToken: string | null;
  selectedArtifacts: Set<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
}

const formatSize = (chars: number): string => {
  if (chars >= 1000000) return `${(chars / 1000000).toFixed(1)}M`;
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}K`;
  return `${chars}`;
};

const getSizeClass = (chars: number): { class: string; warning: boolean } => {
  if (chars >= 200000) return { class: "bg-destructive text-destructive-foreground", warning: true };
  if (chars >= 100000) return { class: "bg-orange-500 text-white", warning: true };
  if (chars >= 50000) return { class: "bg-yellow-500 text-black", warning: false };
  return { class: "bg-muted text-muted-foreground", warning: false };
};

interface ArtifactNodeProps {
  artifact: Artifact;
  level: number;
  selectedArtifacts: Set<string>;
  onToggle: (id: string, descendants?: string[]) => void;
  allArtifacts: Artifact[];
}

function ArtifactNode({ artifact, level, selectedArtifacts, onToggle, allArtifacts }: ArtifactNodeProps) {
  const [isExpanded, setIsExpanded] = useState(level < 2);
  const hasChildren = artifact.children && artifact.children.length > 0;
  const isFolder = artifact.is_folder;
  
  const descendantIds = useMemo(() => getAllDescendantIds(artifact), [artifact]);
  const nonFolderDescendants = useMemo(() => 
    descendantIds.filter(id => {
      const a = allArtifacts.find(art => art.id === id);
      return a && !a.is_folder;
    }), 
    [descendantIds, allArtifacts]
  );
  
  const isSelected = selectedArtifacts.has(artifact.id);
  
  // For folders: check if all non-folder descendants are selected
  const allDescendantsSelected = isFolder && nonFolderDescendants.length > 0 && 
    nonFolderDescendants.every(id => selectedArtifacts.has(id));
  const someDescendantsSelected = isFolder && nonFolderDescendants.length > 0 && 
    nonFolderDescendants.some(id => selectedArtifacts.has(id)) && !allDescendantsSelected;
  
  const charCount = artifact.content?.length || 0;
  const sizeInfo = getSizeClass(charCount);

  const handleToggle = () => {
    if (isFolder) {
      // Toggle all non-folder descendants
      onToggle(artifact.id, nonFolderDescendants);
    } else {
      onToggle(artifact.id);
    }
  };

  return (
    <div>
      <div
        className={cn(
          "flex items-start gap-2 py-1.5 px-2 hover:bg-muted/50 rounded transition-colors",
          !isFolder && sizeInfo.warning && "border-l-2 border-orange-500"
        )}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        {/* Expand/collapse for folders with children */}
        <div className="w-4 flex-shrink-0 mt-0.5">
          {hasChildren && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="p-0.5 hover:bg-muted rounded"
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
          )}
        </div>

        {/* Checkbox */}
        <Checkbox
          id={`artifact-${artifact.id}`}
          checked={isFolder ? allDescendantsSelected : isSelected}
          onCheckedChange={handleToggle}
          className="mt-0.5"
          // Show indeterminate for partially selected folders
          {...(someDescendantsSelected ? { "data-state": "indeterminate" } : {})}
        />
        
        {/* Icon */}
        {isFolder ? (
          isExpanded ? (
            <FolderOpen className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
          ) : (
            <Folder className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
          )
        ) : artifact.image_url ? (
          <div className="w-8 h-8 rounded overflow-hidden bg-muted shrink-0">
            <img 
              src={artifact.image_url} 
              alt={artifact.ai_title || "Artifact image"}
              className="w-full h-full object-cover"
            />
          </div>
        ) : (
          <FileText className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
        )}
        
        {/* Label and content */}
        <Label
          htmlFor={`artifact-${artifact.id}`}
          className="text-sm cursor-pointer flex-1 min-w-0"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">
              {artifact.ai_title || (isFolder ? "Untitled Folder" : "Untitled Artifact")}
            </span>
            {!isFolder && (
              <Badge variant="secondary" className={cn("text-xs flex-shrink-0", sizeInfo.class)}>
                {formatSize(charCount)}
              </Badge>
            )}
            {isFolder && nonFolderDescendants.length > 0 && (
              <Badge variant="outline" className="text-xs flex-shrink-0">
                {nonFolderDescendants.length} items
              </Badge>
            )}
            {!isFolder && sizeInfo.warning && (
              <AlertTriangle className="h-3 w-3 text-orange-500 flex-shrink-0" />
            )}
          </div>
          {!isFolder && artifact.content && (
            <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
              {artifact.content.substring(0, 100)}...
            </div>
          )}
        </Label>
      </div>
      
      {/* Children */}
      {isExpanded && hasChildren && (
        <div>
          {artifact.children!.map((child) => (
            <ArtifactNode
              key={child.id}
              artifact={child}
              level={level + 1}
              selectedArtifacts={selectedArtifacts}
              onToggle={onToggle}
              allArtifacts={allArtifacts}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ArtifactsListSelector({
  projectId,
  shareToken,
  selectedArtifacts,
  onSelectionChange
}: ArtifactsListSelectorProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"list" | "grid" | "tree">("tree");

  useEffect(() => {
    loadArtifacts();
  }, [projectId]);

  const loadArtifacts = async () => {
    try {
      const { data } = await pronghornApi.rpc("get_artifacts_with_token", {
        p_project_id: projectId,
        p_token: shareToken
      });

      if (data) {
        // Add default values for new fields if not present
        const normalized = data.map((a: any) => ({
          ...a,
          parent_id: a.parent_id || null,
          is_folder: a.is_folder || false,
        }));
        setArtifacts(normalized);
      }
    } catch (error) {
      console.error("Error loading artifacts:", error);
    } finally {
      setLoading(false);
    }
  };

  // Build tree for tree view
  const artifactTree = useMemo(() => buildArtifactHierarchy(artifacts), [artifacts]);

  // Non-folder artifacts only (for selection counts)
  const nonFolderArtifacts = useMemo(() => artifacts.filter(a => !a.is_folder), [artifacts]);

  const toggleArtifact = (id: string, descendants?: string[]) => {
    const newSelected = new Set(selectedArtifacts);
    
    if (descendants && descendants.length > 0) {
      // It's a folder - toggle all descendants
      const allSelected = descendants.every(d => newSelected.has(d));
      if (allSelected) {
        descendants.forEach(d => newSelected.delete(d));
      } else {
        descendants.forEach(d => newSelected.add(d));
      }
    } else {
      // Regular artifact
      if (newSelected.has(id)) {
        newSelected.delete(id);
      } else {
        newSelected.add(id);
      }
    }
    onSelectionChange(newSelected);
  };

  const handleSelectAll = () => {
    onSelectionChange(new Set(nonFolderArtifacts.map(a => a.id)));
  };

  const handleSelectNone = () => {
    onSelectionChange(new Set());
  };

  // Select only items under 100K chars
  const handleSelectSmall = () => {
    const smallItems = nonFolderArtifacts.filter(a => (a.content?.length || 0) < 100000);
    onSelectionChange(new Set(smallItems.map(a => a.id)));
  };

  const totalSelectedChars = nonFolderArtifacts
    .filter(a => selectedArtifacts.has(a.id))
    .reduce((sum, a) => sum + (a.content?.length || 0), 0);

  const largeItemCount = nonFolderArtifacts.filter(a => (a.content?.length || 0) >= 100000).length;
  const imageArtifactCount = nonFolderArtifacts.filter(a => a.image_url).length;
  const folderCount = artifacts.filter(a => a.is_folder).length;

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading artifacts...</div>;
  }

  if (artifacts.length === 0) {
    return <div className="text-sm text-muted-foreground">No artifacts in this project.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <Button variant="outline" size="sm" onClick={handleSelectAll}>
          Select All
        </Button>
        <Button variant="outline" size="sm" onClick={handleSelectNone}>
          Select None
        </Button>
        {largeItemCount > 0 && (
          <Button variant="outline" size="sm" onClick={handleSelectSmall}>
            Select &lt;100K only
          </Button>
        )}
        
        {/* View mode toggle */}
        <div className="flex border rounded-md ml-2">
          <Button
            variant={viewMode === "tree" ? "secondary" : "ghost"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setViewMode("tree")}
            title="Tree view"
          >
            <TreePine className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "list" ? "secondary" : "ghost"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setViewMode("list")}
            title="List view"
          >
            <List className="h-4 w-4" />
          </Button>
          {imageArtifactCount > 0 && (
            <Button
              variant={viewMode === "grid" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode("grid")}
              title="Grid view"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
          )}
        </div>
        
        <span className="text-xs text-muted-foreground ml-auto">
          Selected: {formatSize(totalSelectedChars)} chars
          {folderCount > 0 && ` • ${folderCount} folder${folderCount > 1 ? "s" : ""}`}
        </span>
      </div>
      
      {largeItemCount > 0 && (
        <div className="flex items-center gap-2 p-2 rounded-md bg-orange-500/10 border border-orange-500/20 text-sm">
          <AlertTriangle className="h-4 w-4 text-orange-500 flex-shrink-0" />
          <span className="text-orange-600 dark:text-orange-400">
            {largeItemCount} large artifact{largeItemCount > 1 ? "s" : ""} detected. Items over 100K chars may cause timeouts.
          </span>
        </div>
      )}

      {viewMode === "tree" ? (
        <div className="space-y-0.5 border rounded-md p-2">
          {artifactTree.map((artifact) => (
            <ArtifactNode
              key={artifact.id}
              artifact={artifact}
              level={0}
              selectedArtifacts={selectedArtifacts}
              onToggle={toggleArtifact}
              allArtifacts={artifacts}
            />
          ))}
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {nonFolderArtifacts.map((artifact) => {
            const charCount = artifact.content?.length || 0;
            const sizeInfo = getSizeClass(charCount);
            const isSelected = selectedArtifacts.has(artifact.id);
            
            return (
              <div
                key={artifact.id}
                className={cn(
                  "relative rounded-lg border overflow-hidden cursor-pointer transition-all",
                  isSelected && "ring-2 ring-primary",
                  sizeInfo.warning && "border-orange-500/30"
                )}
                onClick={() => toggleArtifact(artifact.id)}
              >
                {artifact.image_url ? (
                  <img 
                    src={artifact.image_url} 
                    alt={artifact.ai_title || "Artifact"}
                    className="w-full aspect-square object-cover"
                  />
                ) : (
                  <div className="w-full aspect-square bg-muted flex items-center justify-center">
                    <FileText className="h-8 w-8 text-muted-foreground" />
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-2">
                  <div className="flex items-center gap-1.5">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleArtifact(artifact.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="border-white data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                    />
                    <span className="text-white text-xs truncate flex-1">
                      {artifact.ai_title || "Untitled"}
                    </span>
                    <Badge variant="secondary" className={cn("text-[10px] px-1 py-0", sizeInfo.class)}>
                      {formatSize(charCount)}
                    </Badge>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {nonFolderArtifacts.map((artifact) => {
            const charCount = artifact.content?.length || 0;
            const sizeInfo = getSizeClass(charCount);
            
            return (
              <div
                key={artifact.id}
                className={cn(
                  "flex items-start gap-2 p-2 hover:bg-muted/50 rounded border",
                  sizeInfo.warning && "border-orange-500/30"
                )}
              >
                <Checkbox
                  id={`artifact-${artifact.id}`}
                  checked={selectedArtifacts.has(artifact.id)}
                  onCheckedChange={() => toggleArtifact(artifact.id)}
                  className="mt-1"
                />
                
                {/* Image thumbnail */}
                {artifact.image_url && (
                  <div className="w-12 h-12 rounded overflow-hidden bg-muted shrink-0">
                    <img 
                      src={artifact.image_url} 
                      alt={artifact.ai_title || "Artifact image"}
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
                
                <Label
                  htmlFor={`artifact-${artifact.id}`}
                  className="text-sm cursor-pointer flex-1"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {artifact.ai_title || "Untitled Artifact"}
                    </span>
                    <Badge variant="secondary" className={cn("text-xs", sizeInfo.class)}>
                      {formatSize(charCount)}
                    </Badge>
                    {sizeInfo.warning && (
                      <AlertTriangle className="h-3 w-3 text-orange-500" />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground line-clamp-2 mt-1">
                    {artifact.content.substring(0, 150)}...
                  </div>
                </Label>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

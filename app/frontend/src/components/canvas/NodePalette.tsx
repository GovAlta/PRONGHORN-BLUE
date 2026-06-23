import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { useNodeTypes, groupByCategory, CanvasNodeType } from "@/hooks/useNodeTypes";
import { getCategoryLabel, getCategoryOrder } from "@/lib/connectionLogic";

// Export NodeType as a string union for backward compatibility
export type NodeType = string;

interface NodePaletteProps {
  onDragStart?: (type: string) => void;
  onNodeClick?: (type: string) => void;
  visibleNodeTypes: Set<string>;
  onToggleVisibility: (type: string) => void;
}

export function NodePalette({ onDragStart, onNodeClick, visibleNodeTypes, onToggleVisibility }: NodePaletteProps) {
  const { data: nodeTypes, isLoading } = useNodeTypes(false);
  
  const groupedNodeTypes = useMemo(() => {
    if (!nodeTypes) return {};
    return groupByCategory(nodeTypes);
  }, [nodeTypes]);
  
  const categoryOrder = getCategoryOrder();

  const handleDragStart = (e: React.DragEvent, type: string) => {
    e.dataTransfer.setData("application/reactflow", type);
    e.dataTransfer.effectAllowed = "move";
    onDragStart?.(type);
  };

  const handleNodeClick = (e: React.MouseEvent, type: string) => {
    // Only trigger click-to-add on mobile/touch devices
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
      e.preventDefault();
      onNodeClick?.(type);
    }
  };

  return (
    <Card className="w-64 border-r border-border rounded-none">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-lg">Node Palette</CardTitle>
        <CardDescription>
          Drag nodes onto the canvas
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[calc(100vh-12rem)]">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="p-4 space-y-4">
              {categoryOrder.map((category) => {
                const categoryNodes = groupedNodeTypes[category];
                if (!categoryNodes || categoryNodes.length === 0) return null;
                
                return (
                  <div key={category} className="space-y-2">
                    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      {getCategoryLabel(category)}
                    </div>
                    {categoryNodes.map((node: CanvasNodeType) => {
                      const isVisible = visibleNodeTypes.has(node.system_name);
                      return (
                        <div
                          key={node.system_name}
                          className="flex items-center gap-2"
                        >
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 flex-shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleVisibility(node.system_name);
                            }}
                          >
                            {isVisible ? (
                              <Eye className="h-4 w-4" />
                            ) : (
                              <EyeOff className="h-4 w-4 opacity-50" />
                            )}
                          </Button>
                          <div
                            draggable
                            onDragStart={(e) => handleDragStart(e, node.system_name)}
                            onClick={(e) => handleNodeClick(e, node.system_name)}
                            className={`flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:bg-muted cursor-move transition-colors flex-1 ${
                              !isVisible ? "opacity-50" : ""
                            }`}
                            title={node.description || node.display_label}
                          >
                            <div className={`p-2 rounded ${node.color_class}`}>
                              <span className="text-sm">{node.emoji || "📦"}</span>
                            </div>
                            <span className="text-sm font-medium">{node.display_label}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

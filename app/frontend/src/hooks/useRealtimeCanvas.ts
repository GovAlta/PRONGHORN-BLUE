import { useEffect, useRef, useCallback } from "react";
import { Node, Edge, useNodesState, useEdgesState } from "reactflow";
import apiClient from "@/lib/apiClient";

// Helper: Check if a node is fully contained inside a zone
const isNodeFullyInsideZone = (node: Node, zone: Node): boolean => {
  const nodeWidth = (node.style?.width as number) || (node.data?.style?.width as number) || 150;
  const nodeHeight = (node.style?.height as number) || (node.data?.style?.height as number) || 60;
  const zoneWidth = (zone.style?.width as number) || (zone.data?.style?.width as number) || 200;
  const zoneHeight = (zone.style?.height as number) || (zone.data?.style?.height as number) || 150;
  
  return (
    node.position.x >= zone.position.x &&
    node.position.y >= zone.position.y &&
    node.position.x + nodeWidth <= zone.position.x + zoneWidth &&
    node.position.y + nodeHeight <= zone.position.y + zoneHeight
  );
};

// Calculate the nesting depth of a zone (0 = not inside any zone, 1 = inside one zone, etc.)
const calculateZoneDepth = (zoneId: string, allNodes: Node[]): number => {
  const zone = allNodes.find(n => n.id === zoneId);
  if (!zone || zone.type !== "zone") return 0;
  
  let depth = 0;
  const otherZones = allNodes.filter(n => n.type === "zone" && n.id !== zoneId);
  
  for (const parentZone of otherZones) {
    if (isNodeFullyInsideZone(zone, parentZone)) {
      const parentDepth = calculateZoneDepth(parentZone.id, allNodes);
      depth = Math.max(depth, parentDepth + 1);
    }
  }
  
  return depth;
};

// Calculate z-index for a zone based on nesting depth
const calculateZoneZIndex = (zoneId: string, allNodes: Node[]): number => {
  const depth = calculateZoneDepth(zoneId, allNodes);
  return -1000 + depth;
};

// Apply dynamic z-index to all zones based on their nesting
const applyZoneZIndexes = (allNodes: Node[]): Node[] => {
  return allNodes.map(node => {
    if (node.type === "zone") {
      return {
        ...node,
        zIndex: calculateZoneZIndex(node.id, allNodes)
      };
    }
    return node;
  });
};

export function useRealtimeCanvas(
  projectId: string,
  shareToken: string | null,
  isTokenSet: boolean,
  initialNodes: Node[],
  initialEdges: Edge[]
) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const draggedNodeRef = useRef<string | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Wrap loadCanvasData in useCallback with shareToken in dependencies
  const loadCanvasData = useCallback(async () => {
    try {
      // Use APIM backend for canvas data
      const [nodesData, edgesData] = await Promise.all([
        apiClient.get<any[]>(`/api/v1/canvas/${projectId}/nodes`),
        apiClient.get<any[]>(`/api/v1/canvas/${projectId}/edges`),
      ]);

      const loadedNodes: Node[] = (nodesData || []).map((node: any) => {
        const nodeType = (node.data as any)?.nodeType || "custom";
        const dataType = (node.data as any)?.type || node.type;
        const loadedStyle = (node.data as any)?.style || {};
        
        // Strip zIndex from style - z-index is calculated dynamically for zones
        const { zIndex: _stripZIndex, ...styleWithoutZIndex } = loadedStyle;
        
        return {
          id: node.id,
          type: nodeType, // Use stored nodeType for React Flow
          position: node.position as { x: number; y: number },
          style: Object.keys(styleWithoutZIndex).length > 0 ? styleWithoutZIndex : undefined,
          // Z-index will be calculated after all nodes are loaded
          zIndex: undefined,
          data: {
            ...(node.data || {}),
            type: dataType,
          },
        };
      });

      // Calculate dynamic z-index for zones based on nesting depth
      const nodesWithZIndex = applyZoneZIndexes(loadedNodes);

      const loadedEdges: Edge[] = (edgesData || []).map((edge: any) => ({
        id: edge.id,
        source: edge.source_id || edge.source,
        target: edge.target_id || edge.target,
        label: edge.label,
        type: edge.edge_type || edge.type || "default",
        style: edge.style || {},
      }));

      setNodes(nodesWithZIndex);
      setEdges(loadedEdges);
    } catch (error) {
      console.error("Error loading canvas data:", error);
    }
  }, [projectId, shareToken, setNodes, setEdges]);
  
  useEffect(() => {
    // Wait for token to be ready before making RPC calls
    if (!projectId || !isTokenSet) {
      return;
    }

    // Initial load
    loadCanvasData();

    // Refresh canvas when tab becomes visible again
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        console.log("Tab visible again, refreshing canvas data");
        loadCanvasData();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Note: Using APIM backend only - no realtime subscriptions
    // For real-time updates, we rely on polling when tab becomes visible

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [projectId, isTokenSet, shareToken, loadCanvasData]);

  const saveNode = useCallback(async (node: Node, immediate = false, isDragOperation = false) => {
    try {
      // Only set draggedNodeRef for actual drag operations
      if (isDragOperation) {
        draggedNodeRef.current = node.id;
      }
      
      // Clear any pending save
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      const performSave = async () => {
        // Use APIM backend for saving nodes
        const nodeData = {
          type: node.data.type,
          position: node.position,
          data: {
            ...node.data,
            // Strip zIndex from style before saving - z-index is calculated dynamically
            style: (() => {
              const { zIndex: _stripZIndex, ...styleWithoutZIndex } = (node.style || {}) as Record<string, any>;
              return styleWithoutZIndex;
            })(),
            nodeType: node.type, // Save React Flow node type
          }
        };
        
        try {
          await apiClient.patch(`/api/v1/canvas/${projectId}/nodes/${node.id}`, nodeData);
        } catch (patchError: any) {
          // If node doesn't exist, create it
          if (patchError.statusCode === 404) {
            await apiClient.post(`/api/v1/canvas/${projectId}/nodes`, {
              ...nodeData,
              id: node.id,
            });
          } else {
            throw patchError;
          }
        }
        
        // Clear dragged node reference after save (only if it was set)
        if (isDragOperation) {
          setTimeout(() => {
            draggedNodeRef.current = null;
          }, 100);
        }
      };

      if (immediate) {
        await performSave();
      } else {
        // Throttle saves during drag - save every 200ms
        saveTimeoutRef.current = setTimeout(performSave, 200);
      }
    } catch (error) {
      console.error("Error saving node:", error);
      draggedNodeRef.current = null;
    }
  }, [projectId, shareToken]);

  const saveEdge = async (edge: Edge) => {
    try {
      console.log("Saving edge:", edge);

      // Use APIM backend for saving edges
      await apiClient.post(`/api/v1/canvas/${projectId}/edges`, {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        type: edge.type || "default",
        label: edge.label,
        data: { style: edge.style || {} }
      });

      console.log("Edge saved successfully");
    } catch (error) {
      console.error("Error saving edge:", error);
    }
  };

  return {
    nodes,
    edges,
    setNodes,
    setEdges,
    onNodesChange,
    onEdgesChange,
    saveNode,
    saveEdge,
    loadCanvasData,
  };
}


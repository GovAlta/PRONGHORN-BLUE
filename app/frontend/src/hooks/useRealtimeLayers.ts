import { useEffect, useState, useCallback } from "react";
import apiClient from "@/lib/apiClient";

export interface Layer {
  id: string;
  project_id: string;
  name: string;
  node_ids: string[];
  visible: boolean;
  created_at: string;
  updated_at: string;
}

export function useRealtimeLayers(projectId: string, token: string | null) {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Wrap loadLayers in useCallback with token in dependencies
  const loadLayers = useCallback(async () => {
    if (!projectId) return;

    try {
      // Use APIM backend RPC endpoint
      const response = await apiClient.post<{ data: Layer[], error: any }>("/api/v1/rpc/get_canvas_layers_with_token", {
        p_project_id: projectId,
        p_token: token || null,
      });
      // RPC endpoints return { data, error } format
      if (response.error) {
        console.error("Error fetching layers:", response.error);
      } else {
        setLayers(response.data || []);
      }
    } catch (error) {
      console.error("Error fetching layers:", error);
    }
    setIsLoading(false);
  }, [projectId, token]);

  // Fetch initial layers
  useEffect(() => {
    loadLayers();
  }, [loadLayers]);

  
  const saveLayer = async (layer: Partial<Layer> & { id: string }) => {
    // Optimistic update: Update UI immediately
    setLayers((prev) => {
      const existingIndex = prev.findIndex((l) => l.id === layer.id);
      if (existingIndex >= 0) {
        // Update existing layer
        const updated = [...prev];
        updated[existingIndex] = { ...updated[existingIndex], ...layer };
        return updated;
      } else {
        // Add new layer
        return [...prev, { ...layer, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as Layer];
      }
    });

    try {
      // Use APIM backend RPC endpoint
      await apiClient.post("/api/v1/rpc/upsert_canvas_layer_with_token", {
        p_id: layer.id,
        p_project_id: projectId,
        p_token: token || null,
        p_name: layer.name || "Untitled Layer",
        p_node_ids: layer.node_ids || [],
        p_visible: layer.visible ?? true,
      });
    } catch (error) {
      console.error("Error saving layer:", error);
      // Revert on error by refetching
      loadLayers();
    }
  };

  const deleteLayer = async (layerId: string) => {
    // Optimistic update: Remove from UI immediately
    setLayers((prev) => prev.filter((l) => l.id !== layerId));

    try {
      // Use APIM backend RPC endpoint
      await apiClient.post("/api/v1/rpc/delete_canvas_layer_with_token", {
        p_id: layerId,
        p_token: token || null,
      });
    } catch (error) {
      console.error("Error deleting layer:", error);
      // Revert on error by refetching
      loadLayers();
    }
  };

  return { layers, isLoading, saveLayer, deleteLayer };
}


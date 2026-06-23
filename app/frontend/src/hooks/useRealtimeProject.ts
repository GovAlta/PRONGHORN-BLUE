import { useState, useEffect, useCallback, useRef } from "react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import type { Database } from "@/integrations/pronghorn-api/types";

type Project = Database["public"]["Tables"]["projects"]["Row"];

export const useRealtimeProject = (
  projectId: string | undefined,
  shareToken: string | null,
  enabled: boolean = true
) => {
  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof pronghornApi.channel> | null>(null);

  const loadProject = useCallback(async () => {
    if (!projectId || !enabled) return;

    setIsLoading(true);
    try {
      const { data, error } = await pronghornApi.rpc("get_project_with_token", {
        p_project_id: projectId,
        p_token: shareToken || null,
      });

      if (!error) {
        setProject(data as Project);
      }
    } catch (error) {
      console.error("Error loading project:", error);
    } finally {
      setIsLoading(false);
    }
  }, [projectId, shareToken, enabled]);

  // Broadcast refresh to other clients
  const broadcastRefresh = useCallback(() => {
    if (channelRef.current && typeof channelRef.current.send === "function") {
        channelRef.current.send({
        type: "broadcast",
        event: "project_refresh",
        payload: { projectId },
      });
    }
  }, [projectId]);

  useEffect(() => {
    loadProject();

    if (!projectId || !enabled) return;

    const channel = pronghornApi
      .channel(`project-${projectId}`)
      .on("broadcast", { event: "project_refresh" }, () => loadProject())
      .subscribe((status) => {
        console.log("Project channel status:", status);
      });

    channelRef.current = channel;

    return () => {
      pronghornApi.removeChannel(channel);
      channelRef.current = null;
    };
  }, [projectId, enabled, shareToken, loadProject]);

  return {
    project,
    isLoading,
    refresh: loadProject,
    broadcastRefresh,
  };
};


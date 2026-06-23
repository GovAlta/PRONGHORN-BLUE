import { useState, useEffect, useCallback, useRef } from "react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";

export interface SavedSpecification {
  id: string;
  agent_id: string;
  agent_title: string;
  version: number;
  is_latest: boolean;
  generated_spec: string;
  raw_data: any;
  created_at: string;
  generated_by_user_id: string | null;
  generated_by_token: string | null;
}

export const useRealtimeSpecifications = (
  projectId: string | undefined,
  shareToken: string | null,
  enabled: boolean = true
) => {
  const [specifications, setSpecifications] = useState<SavedSpecification[]>([]);
  const [allVersions, setAllVersions] = useState<Record<string, SavedSpecification[]>>({});
  const [isLoading, setIsLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof pronghornApi.channel> | null>(null);

  const loadSpecifications = useCallback(async () => {
    if (!projectId || !enabled) return;

    setIsLoading(true);
    try {
      const { data, error } = await pronghornApi.rpc("get_project_specifications_with_token", {
        p_project_id: projectId,
        p_token: shareToken || null,
        p_agent_id: null,
        p_latest_only: false,
      });

      if (!error && data) {
        const allSpecs = (data as any[]).map((s) => ({
          id: s.id,
          agent_id: s.agent_id,
          agent_title: s.agent_title,
          version: s.version,
          is_latest: s.is_latest,
          generated_spec: s.generated_spec,
          raw_data: s.raw_data,
          created_at: s.created_at,
          generated_by_user_id: s.generated_by_user_id,
          generated_by_token: s.generated_by_token,
        }));

        // Separate latest specs
        const latestSpecs = allSpecs.filter((s) => s.is_latest);
        setSpecifications(latestSpecs);

        // Build version history by agent_id
        const versionsByAgent: Record<string, SavedSpecification[]> = {};
        allSpecs.forEach((spec) => {
          if (!versionsByAgent[spec.agent_id]) {
            versionsByAgent[spec.agent_id] = [];
          }
          versionsByAgent[spec.agent_id].push(spec);
        });
        // Sort each agent's versions by version number descending
        Object.keys(versionsByAgent).forEach((agentId) => {
          versionsByAgent[agentId].sort((a, b) => b.version - a.version);
        });
        setAllVersions(versionsByAgent);
      }
    } catch (error) {
      console.error("Error loading specifications:", error);
    } finally {
      setIsLoading(false);
    }
  }, [projectId, shareToken, enabled]);

  // Broadcast refresh to other clients
  const broadcastRefresh = useCallback(() => {
    if (channelRef.current && typeof channelRef.current.send === "function") {
        channelRef.current.send({
        type: "broadcast",
        event: "specification_refresh",
        payload: { projectId },
      });
    }
  }, [projectId]);

  useEffect(() => {
    loadSpecifications();

    if (!projectId || !enabled) return;

    const channel = pronghornApi
      .channel(`specifications-${projectId}`)
      .on("broadcast", { event: "specification_refresh" }, () => loadSpecifications())
      .subscribe((status) => {
        console.log("Specifications channel status:", status);
      });

    channelRef.current = channel;

    return () => {
      pronghornApi.removeChannel(channel);
      channelRef.current = null;
    };
  }, [projectId, enabled, shareToken, loadSpecifications]);

  return {
    specifications,
    allVersions,
    isLoading,
    refresh: loadSpecifications,
    broadcastRefresh,
    hasSpecifications: specifications.length > 0,
  };
};


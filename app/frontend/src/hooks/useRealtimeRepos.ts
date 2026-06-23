import { useEffect, useState, useRef, useCallback } from "react";
import { pronghornApi, RealtimeChannel } from "@/integrations/pronghorn-api/client";

interface ProjectRepo {
  id: string;
  project_id: string;
  organization: string;
  repo: string;
  branch: string;
  is_default: boolean;
  is_prime: boolean;
  created_at: string;
  updated_at: string;
}

export function useRealtimeRepos(projectId: string | undefined | null, shareToken?: string | null) {
  const [repos, setRepos] = useState<ProjectRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const loadRepos = useCallback(async () => {
    if (!projectId) return;

    try {
      const { data, error } = await pronghornApi.rpc("get_project_repos_with_token", {
        p_project_id: projectId,
        p_token: shareToken || null,
      });

      if (error) throw error;
      setRepos(data || []);
    } catch (error) {
      console.error("Error loading repos:", error);
    } finally {
      setLoading(false);
    }
  }, [projectId, shareToken]);

  const broadcastRefresh = useCallback(async () => {
    if (channelRef.current && typeof channelRef.current.send === "function") {
      await channelRef.current.send({
        type: "broadcast",
        event: "repos_refresh",
        payload: {}
      });
    }
  }, []);

  useEffect(() => {
    loadRepos();

    if (!projectId) return;

    const channel = pronghornApi
      .channel(`project_repos-${projectId}`)
      .on("broadcast", { event: "repos_refresh" }, () => {
        loadRepos();
      })
      .subscribe();
    
    channelRef.current = channel;

    return () => {
      pronghornApi.removeChannel(channel);
      channelRef.current = null;
    };
  }, [projectId, shareToken, loadRepos]);

  return { repos, loading, refetch: loadRepos, broadcastRefresh };
}

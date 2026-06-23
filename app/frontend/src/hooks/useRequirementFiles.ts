import { useState, useEffect } from "react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";

export function useRequirementFiles(requirementId: string) {
  const [fileCount, setFileCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadFileCount();
  }, [requirementId]);

  const loadFileCount = async () => {
    try {
      const { data, error } = await pronghornApi.storage
        .from("requirement-sources")
        .list(requirementId);

      if (error) throw error;
      setFileCount(data?.length || 0);
    } catch (error) {
      console.error("Error loading file count:", error);
      setFileCount(0);
    } finally {
      setLoading(false);
    }
  };

  return { fileCount, loading, refresh: loadFileCount };
}

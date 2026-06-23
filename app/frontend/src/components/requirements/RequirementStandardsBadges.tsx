import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { ListChecks } from "lucide-react";

interface RequirementStandardsBadgesProps {
  requirementId: string;
  projectId: string;
  shareToken: string | null;
}

export function RequirementStandardsBadges({ requirementId, projectId, shareToken }: RequirementStandardsBadgesProps) {
  const [standards, setStandards] = useState<any[]>([]);

  useEffect(() => {
    // Skip loading for optimistic/temp IDs that aren't real UUIDs yet
    if (!requirementId || requirementId.startsWith("temp-")) return;

    loadStandards();

    if (!projectId) return;

    // Set up real-time subscription for standard links
    const channel = pronghornApi
      .channel(`requirement-standards-${requirementId}`)
      .on(
        "broadcast",
        { event: "requirements_refresh" },
        () => {
          loadStandards();
        }
      )
      .subscribe();

    return () => {
      pronghornApi.removeChannel(channel);
    };
  }, [requirementId, projectId]);

  const loadStandards = async () => {
    if (!requirementId || requirementId.startsWith("temp-")) return;
    try {
      const { data: reqStandards, error } = await pronghornApi.rpc("get_requirement_standards_with_token", {
        p_requirement_id: requirementId,
        p_token: shareToken || null
      });

      if (error) throw error;

      // Now fetch the standards details for the linked standard_ids
      if (!reqStandards || reqStandards.length === 0) {
        setStandards([]);
        return;
      }

      const standardIds = reqStandards.map((rs: any) => rs.standard_id);
      const { data: standardsData, error: standardsError } = await pronghornApi
        .from("standards")
        .select("id, code, title")
        .in("id", standardIds);

      if (standardsError) throw standardsError;

      setStandards(standardsData || []);
    } catch (error) {
      console.error("Error loading standards:", error);
    }
  };

  if (standards.length === 0) return null;

  return (
    <div className="flex gap-1 items-center flex-wrap">
      <ListChecks className="h-3 w-3 text-muted-foreground" />
      {standards.map((standard) => (
        <Badge
          key={standard.id}
          variant="secondary"
          className="text-xs font-mono"
        >
          {standard.code}
        </Badge>
      ))}
    </div>
  );
}

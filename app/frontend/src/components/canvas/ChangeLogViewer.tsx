import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Download, ChevronDown, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface ChangeLogEntry {
  iteration: number;
  agentId: string;
  agentLabel: string;
  timestamp: string;
  changes: string;
  reasoning: string;
}

interface ChangeLogViewerProps {
  logs: ChangeLogEntry[];
  onSaveAsArtifact: () => void;
  isSaving?: boolean;
}

export function ChangeLogViewer({ logs, onSaveAsArtifact, isSaving }: ChangeLogViewerProps) {
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set());

  const toggleExpanded = (index: number) => {
    setExpandedIndices((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">Change History</h3>
        <Button
          size="sm"
          onClick={onSaveAsArtifact}
          disabled={logs.length === 0 || isSaving}
        >
          <Download className="w-4 h-4 mr-2" />
          Save as Artifact
        </Button>
      </div>

      <ScrollArea className="h-[500px]">
        <div className="space-y-2">
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No changes recorded yet. Start an iteration to see agent activity.
            </p>
          ) : (
            logs.map((log, index) => {
              const isExpanded = expandedIndices.has(index);
              return (
                <Collapsible key={index} open={isExpanded} onOpenChange={() => toggleExpanded(index)}>
                  <Card className="overflow-hidden">
                    <CollapsibleTrigger className="w-full p-3 hover:bg-muted/50 transition-colors">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          )}
                          <Badge variant="outline" className="text-xs">Iteration {log.iteration}</Badge>
                          <span className="font-medium text-sm">{log.agentLabel}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    </CollapsibleTrigger>

                    <CollapsibleContent>
                      <div className="p-4 pt-2 space-y-3 border-t">
                        <div>
                          <h4 className="text-xs font-semibold text-muted-foreground mb-1">Reasoning:</h4>
                          <div className="text-sm prose prose-sm max-w-none">
                            <ReactMarkdown>{log.reasoning}</ReactMarkdown>
                          </div>
                        </div>

                        <div>
                          <h4 className="text-xs font-semibold text-muted-foreground mb-1">Changes:</h4>
                          <div className="text-sm prose prose-sm max-w-none">
                            <ReactMarkdown>{log.changes}</ReactMarkdown>
                          </div>
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              );
            })
          )}
        </div>
      </ScrollArea>
    </Card>
  );
}

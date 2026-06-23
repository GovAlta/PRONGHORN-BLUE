import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { BarChart3, TrendingDown, Download, ChevronDown, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";

interface ChangeMetric {
  iteration: number;
  agentId: string;
  agentLabel: string;
  nodesAdded: number;
  nodesEdited: number;
  nodesDeleted: number;
  edgesAdded: number;
  edgesEdited: number;
  edgesDeleted: number;
  timestamp: string;
}

interface ChangeLogEntry {
  iteration: number;
  agentId: string;
  agentLabel: string;
  timestamp: string;
  changes: string;
  reasoning: string;
}

interface IterationVisualizerProps {
  metrics: ChangeMetric[];
  currentIteration: number;
  totalIterations: number;
  changeLogs?: ChangeLogEntry[];
  onSaveAsArtifact?: () => void;
  isSaving?: boolean;
}

export function IterationVisualizer({ 
  metrics, 
  currentIteration, 
  totalIterations, 
  changeLogs = [],
  onSaveAsArtifact,
  isSaving = false
}: IterationVisualizerProps) {
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

  const getTotalChanges = (metric: ChangeMetric) => {
    return metric.nodesAdded + metric.nodesEdited + metric.nodesDeleted + 
           metric.edgesAdded + metric.edgesEdited + metric.edgesDeleted;
  };

  // Use reduce rather than spreading into Math.max so a large metrics array
  // cannot exceed the argument/stack-size limit.
  const maxChanges = Math.max(
    metrics.reduce((max, m) => Math.max(max, getTotalChanges(m)), 0),
    1
  );

  const getStabilizationTrend = () => {
    // Need at least two non-overlapping windows of 5 (first 5 vs last 5);
    // fewer than 10 samples would overlap and produce a misleading trend.
    if (metrics.length < 10) return null;
    
    const recentChanges = metrics.slice(-5).reduce((sum, m) => sum + getTotalChanges(m), 0);
    const earlierChanges = metrics.slice(0, 5).reduce((sum, m) => sum + getTotalChanges(m), 0);
    
    if (earlierChanges === 0) return null;
    const changeRate = ((earlierChanges - recentChanges) / earlierChanges) * 100;
    
    return changeRate > 0 ? `Stabilizing (${changeRate.toFixed(0)}% reduction)` : "Still adapting";
  };

  return (
    <div className="space-y-4">
      {/* Progress Header */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            <span className="font-semibold">Iteration Progress</span>
          </div>
          <Badge variant="outline">
            {currentIteration} / {totalIterations}
          </Badge>
        </div>
        
        {getStabilizationTrend() && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <TrendingDown className="w-4 h-4" />
            <span>{getStabilizationTrend()}</span>
          </div>
        )}
      </Card>

      {/* Change History with Metrics and Detailed Logs */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-sm">Change History</h3>
          {onSaveAsArtifact && (
            <Button
              size="sm"
              onClick={onSaveAsArtifact}
              disabled={changeLogs.length === 0 || isSaving}
            >
              <Download className="w-4 h-4 mr-2" />
              Save as Artifact
            </Button>
          )}
        </div>

        <ScrollArea className="h-[500px]">
          <div className="space-y-2">
            {metrics.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No changes recorded yet. Start an iteration to see agent activity.
              </p>
            ) : (
              metrics.map((metric, index) => {
                const totalChanges = getTotalChanges(metric);
                const barWidth = (totalChanges / maxChanges) * 100;
                const log = changeLogs[index];
                const isExpanded = expandedIndices.has(index);
                
                return (
                  <Collapsible key={index} open={isExpanded} onOpenChange={() => toggleExpanded(index)}>
                    <Card className="overflow-hidden">
                      <CollapsibleTrigger className="w-full p-3 hover:bg-muted/50 transition-colors">
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              {isExpanded ? (
                                <ChevronDown className="w-4 h-4 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="w-4 h-4 text-muted-foreground" />
                              )}
                              <Badge variant="outline" className="text-xs">Iteration {metric.iteration}</Badge>
                              <span className="font-medium text-sm">{metric.agentLabel}</span>
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {new Date(metric.timestamp).toLocaleTimeString()}
                            </span>
                          </div>

                          <div className="w-full bg-muted rounded-full h-2">
                            <div 
                              className="bg-primary h-2 rounded-full transition-all"
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                          
                          <div className="flex gap-2 text-xs text-muted-foreground">
                            <span>+{metric.nodesAdded} nodes</span>
                            <span>~{metric.nodesEdited}</span>
                            <span>-{metric.nodesDeleted}</span>
                            <span>|</span>
                            <span>+{metric.edgesAdded} edges</span>
                            <span>~{metric.edgesEdited}</span>
                            <span>-{metric.edgesDeleted}</span>
                          </div>
                        </div>
                      </CollapsibleTrigger>

                      {log && (
                        <CollapsibleContent>
                          <div className="p-4 pt-2 space-y-3 border-t">
                            <div>
                              <h4 className="text-xs font-semibold text-muted-foreground mb-1">Reasoning:</h4>
                              <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_p]:mb-4">
                                <ReactMarkdown>{log.reasoning}</ReactMarkdown>
                              </div>
                            </div>

                            <div>
                              <h4 className="text-xs font-semibold text-muted-foreground mb-1">Changes:</h4>
                              <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_p]:mb-4">
                                <ReactMarkdown>{log.changes}</ReactMarkdown>
                              </div>
                            </div>
                          </div>
                        </CollapsibleContent>
                      )}
                    </Card>
                  </Collapsible>
                );
              })
            )}
          </div>
        </ScrollArea>
      </Card>
    </div>
  );
}

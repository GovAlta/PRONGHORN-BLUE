import { useState, useEffect, useCallback } from "react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertCircle, AlertTriangle, Info, Terminal, Check, RefreshCw, Clock } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

interface TestingLog {
  id: string;
  deployment_id: string;
  project_id: string;
  log_type: string;
  message: string;
  stack_trace: string | null;
  file_path: string | null;
  line_number: number | null;
  is_resolved: boolean;
  resolved_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface TestingLogsViewerProps {
  deploymentId: string;
  projectId: string;
  shareToken: string | null;
}

const TestingLogsViewer = ({ deploymentId, projectId, shareToken }: TestingLogsViewerProps) => {
  const [logs, setLogs] = useState<TestingLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolvedOnly, setShowResolvedOnly] = useState(false);

  const fetchLogs = useCallback(async () => {
    if (!deploymentId) return;
    
    setLoading(true);
    try {
      const { data, error } = await pronghornApi.rpc("get_testing_logs_with_token", {
        p_deployment_id: deploymentId,
        p_token: shareToken || null,
        p_limit: 100,
        p_unresolved_only: showResolvedOnly,
      });

      if (error) throw error;
      setLogs((data as TestingLog[]) || []);
    } catch (error: any) {
      console.error("Error fetching testing logs:", error);
    } finally {
      setLoading(false);
    }
  }, [deploymentId, shareToken, showResolvedOnly]);

  // Initial fetch
  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Real-time subscription
  useEffect(() => {
    if (!deploymentId || !projectId) return;

    console.log(`[TestingLogs] Setting up subscription for deployment ${deploymentId}`);

    const channel = pronghornApi
      .channel(`testing-logs-${deploymentId}`)
      .on(
        "broadcast",
        { event: "testing_log_refresh" },
        (payload) => {
          console.log("[TestingLogs] Change received:", payload);
          fetchLogs();
        }
      )
      .subscribe((status) => {
        console.log(`[TestingLogs] Subscription status: ${status}`);
      });

    return () => {
      console.log("[TestingLogs] Cleaning up subscription");
      pronghornApi.removeChannel(channel);
    };
  }, [deploymentId, projectId, fetchLogs]);

  const handleResolve = async (logId: string) => {
    try {
      const { error } = await pronghornApi.rpc("resolve_testing_log_with_token", {
        p_log_id: logId,
        p_token: shareToken || null,
      });

      if (error) throw error;
      toast.success("Log marked as resolved");
      fetchLogs();
    } catch (error: any) {
      console.error("Error resolving log:", error);
      toast.error("Failed to resolve log");
    }
  };

  const getLogIcon = (logType: string) => {
    switch (logType) {
      case "error":
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case "info":
        return <Info className="h-4 w-4 text-blue-500" />;
      case "stdout":
      case "stderr":
        return <Terminal className="h-4 w-4 text-muted-foreground" />;
      default:
        return <Info className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getLogBadgeVariant = (logType: string): "destructive" | "secondary" | "outline" | "default" => {
    switch (logType) {
      case "error":
        return "destructive";
      case "warning":
        return "secondary";
      default:
        return "outline";
    }
  };

  const errorCount = logs.filter(l => l.log_type === "error" && !l.is_resolved).length;
  const warningCount = logs.filter(l => l.log_type === "warning" && !l.is_resolved).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="h-4 w-4" />
            Testing Logs
            {errorCount > 0 && (
              <Badge variant="destructive" className="ml-2">
                {errorCount} error{errorCount > 1 ? "s" : ""}
              </Badge>
            )}
            {warningCount > 0 && (
              <Badge variant="secondary" className="ml-2">
                {warningCount} warning{warningCount > 1 ? "s" : ""}
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="unresolved"
                checked={showResolvedOnly}
                onCheckedChange={(checked) => setShowResolvedOnly(checked === true)}
              />
              <label htmlFor="unresolved" className="text-xs text-muted-foreground cursor-pointer">
                Unresolved only
              </label>
            </div>
            <Button variant="ghost" size="sm" onClick={fetchLogs}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Terminal className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No logs yet</p>
            <p className="text-xs mt-1">Logs will appear here when the local runner reports them</p>
          </div>
        ) : (
          <ScrollArea className="h-[400px]">
            <div className="space-y-2">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className={`p-3 rounded-lg border ${
                    log.is_resolved
                      ? "bg-muted/30 border-border/50"
                      : log.log_type === "error"
                      ? "bg-destructive/5 border-destructive/20"
                      : "bg-muted/50 border-border"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 flex-1 min-w-0">
                      {getLogIcon(log.log_type)}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant={getLogBadgeVariant(log.log_type)} className="text-[10px]">
                            {log.log_type}
                          </Badge>
                          {log.file_path && (
                            <span className="text-xs font-mono text-muted-foreground truncate">
                              {log.file_path}
                              {log.line_number && `:${log.line_number}`}
                            </span>
                          )}
                          {log.is_resolved && (
                            <Badge variant="outline" className="text-[10px] text-green-600">
                              <Check className="h-3 w-3 mr-1" />
                              Resolved
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm mt-1 whitespace-pre-wrap break-words font-mono">
                          {log.message.slice(0, 500)}
                          {log.message.length > 500 && "..."}
                        </p>
                        {log.stack_trace && (
                          <details className="mt-2">
                            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                              Show stack trace
                            </summary>
                            <pre className="mt-1 p-2 bg-muted rounded text-[10px] overflow-x-auto">
                              {log.stack_trace.slice(0, 2000)}
                            </pre>
                          </details>
                        )}
                        <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                        </div>
                      </div>
                    </div>
                    {!log.is_resolved && log.log_type === "error" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleResolve(log.id)}
                        className="flex-shrink-0"
                      >
                        <Check className="h-4 w-4 mr-1" />
                        Resolve
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
};

export default TestingLogsViewer;

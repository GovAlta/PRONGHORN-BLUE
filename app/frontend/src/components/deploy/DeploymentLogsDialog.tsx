import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { RefreshCw, AlertCircle, Info, AlertTriangle, Rocket, Hammer, CheckCircle, Clock, XCircle } from "lucide-react";
import type { Database } from "@/integrations/pronghorn-api/types";

type DeploymentLog = Database["public"]["Tables"]["deployment_logs"]["Row"];

interface DeploymentLogsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deploymentId: string;
  shareToken: string | null;
  cloudServiceId?: string | null;
}

interface CloudEvent {
  id: string;
  type: string;
  timestamp: string;
  details?: Record<string, any>;
  statusChange?: {
    from: string;
    to: string;
  };
}

interface DeployInfo {
  id: string;
  status: string;
  createdAt: string;
  finishedAt?: string;
  commit?: {
    id: string;
    message: string;
  };
}

const logTypeConfig: Record<string, { icon: React.ReactNode; className: string }> = {
  info: { icon: <Info className="h-3 w-3" />, className: "text-blue-500" },
  warning: { icon: <AlertTriangle className="h-3 w-3" />, className: "text-yellow-500" },
  error: { icon: <AlertCircle className="h-3 w-3" />, className: "text-red-500" },
  build: { icon: <Hammer className="h-3 w-3" />, className: "text-purple-500" },
  deploy: { icon: <Rocket className="h-3 w-3" />, className: "text-green-500" },
};

const deployStatusConfig: Record<string, { icon: React.ReactNode; variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
  created: { icon: <Clock className="h-3 w-3" />, variant: "secondary", label: "Created" },
  build_in_progress: { icon: <RefreshCw className="h-3 w-3 animate-spin" />, variant: "secondary", label: "Building" },
  update_in_progress: { icon: <RefreshCw className="h-3 w-3 animate-spin" />, variant: "secondary", label: "Updating" },
  live: { icon: <CheckCircle className="h-3 w-3" />, variant: "default", label: "Live" },
  deactivated: { icon: <XCircle className="h-3 w-3" />, variant: "outline", label: "Deactivated" },
  build_failed: { icon: <XCircle className="h-3 w-3" />, variant: "destructive", label: "Build Failed" },
  update_failed: { icon: <XCircle className="h-3 w-3" />, variant: "destructive", label: "Update Failed" },
  canceled: { icon: <XCircle className="h-3 w-3" />, variant: "outline", label: "Canceled" },
  // Azure Container Apps revision statuses
  healthy: { icon: <CheckCircle className="h-3 w-3" />, variant: "default", label: "Healthy" },
  unhealthy: { icon: <XCircle className="h-3 w-3" />, variant: "destructive", label: "Unhealthy" },
  provisioning: { icon: <RefreshCw className="h-3 w-3 animate-spin" />, variant: "secondary", label: "Provisioning" },
  running: { icon: <CheckCircle className="h-3 w-3" />, variant: "default", label: "Running" },
  stopped: { icon: <XCircle className="h-3 w-3" />, variant: "outline", label: "Stopped" },
  failed: { icon: <XCircle className="h-3 w-3" />, variant: "destructive", label: "Failed" },
};

const DeploymentLogsDialog = ({
  open,
  onOpenChange,
  deploymentId,
  shareToken,
  cloudServiceId,
}: DeploymentLogsDialogProps) => {
  const [logs, setLogs] = useState<DeploymentLog[]>([]);
  const [events, setEvents] = useState<CloudEvent[]>([]);
  const [deploys, setDeploys] = useState<DeployInfo[]>([]);
  const [latestDeploy, setLatestDeploy] = useState<DeployInfo | null>(null);
  const [buildLogs, setBuildLogs] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [activeTab, setActiveTab] = useState("events");
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const isTransitionalStatus = (status?: string) => {
    return status === "pending" || status === "build_in_progress" || status === "update_in_progress" || status === "created";
  };

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data, error } = await pronghornApi.rpc("get_deployment_logs_with_token", {
        p_deployment_id: deploymentId,
        p_token: shareToken || null,
        p_limit: 100,
      });

      if (error) throw error;
      setLogs((data as DeploymentLog[]) || []);
    } catch (error) {
      console.error("Error fetching logs:", error);
    } finally {
      setIsLoading(false);
    }
  }, [deploymentId, shareToken]);

  const fetchCloudEvents = useCallback(async () => {
    if (!cloudServiceId) return;
    
    setIsLoadingEvents(true);
    try {
      const { data, error } = await pronghornApi.functions.invoke("cloud-deployment", {
        body: {
          action: "getEvents",
          deploymentId,
          shareToken: shareToken || null,
        },
      });

      if (error) throw error;
      if (data?.success) {
        setEvents(data.data?.events || []);
        setDeploys(data.data?.deploys || []);
        setLatestDeploy(data.data?.latestDeploy || null);
        setBuildLogs(data.data?.buildLogs || null);
      }
    } catch (error) {
      console.error("Error fetching cloud events:", error);
    } finally {
      setIsLoadingEvents(false);
    }
  }, [deploymentId, shareToken, cloudServiceId]);

  const refreshAll = useCallback(() => {
    fetchLogs();
    if (cloudServiceId) {
      fetchCloudEvents();
    }
  }, [fetchLogs, fetchCloudEvents, cloudServiceId]);

  // Initial fetch when dialog opens
  useEffect(() => {
    if (open) {
      refreshAll();
    }
  }, [open, refreshAll]);

  // Auto-refresh logic
  useEffect(() => {
    if (autoRefresh && open && isTransitionalStatus(latestDeploy?.status)) {
      intervalRef.current = setInterval(() => {
        refreshAll();
      }, 10000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [autoRefresh, open, latestDeploy?.status, refreshAll]);

  // Stop auto-refresh when status becomes terminal
  useEffect(() => {
    if (latestDeploy?.status && !isTransitionalStatus(latestDeploy.status) && autoRefresh) {
      setAutoRefresh(false);
    }
  }, [latestDeploy?.status, autoRefresh]);

  const statusConfig = latestDeploy?.status ? deployStatusConfig[latestDeploy.status] : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle>Deployment Logs</DialogTitle>
              <DialogDescription>
                View build events and deployment activity
              </DialogDescription>
            </div>
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={isLoading || isLoadingEvents}>
              <RefreshCw className={`h-4 w-4 mr-2 ${(isLoading || isLoadingEvents) ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </DialogHeader>

        {/* Latest Deploy Status */}
        {latestDeploy && statusConfig && (
          <div className="flex items-center justify-between p-3 bg-muted/50 rounded-md mb-2">
            <div className="flex items-center gap-3">
              <Badge variant={statusConfig.variant} className="flex items-center gap-1">
                {statusConfig.icon}
                {statusConfig.label}
              </Badge>
              <span className="text-sm text-muted-foreground">
                Started: {new Date(latestDeploy.createdAt).toLocaleString()}
              </span>
              {latestDeploy.finishedAt && (
                <span className="text-sm text-muted-foreground">
                  • Finished: {new Date(latestDeploy.finishedAt).toLocaleString()}
                </span>
              )}
            </div>
            {isTransitionalStatus(latestDeploy.status) && (
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="autoRefresh"
                  checked={autoRefresh}
                  onCheckedChange={(checked) => setAutoRefresh(!!checked)}
                />
                <Label htmlFor="autoRefresh" className="text-sm">
                  Auto-refresh
                </Label>
              </div>
            )}
          </div>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="events">
              Build Events
              {deploys.length > 0 && (
                <span className="ml-2 text-xs bg-muted px-1.5 py-0.5 rounded-full">
                  {deploys.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="buildlogs">
              Build Logs
              {buildLogs && (
                <span className="ml-2 text-xs bg-muted px-1.5 py-0.5 rounded-full">
                  •
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="activity">
              Activity
              {logs.length > 0 && (
                <span className="ml-2 text-xs bg-muted px-1.5 py-0.5 rounded-full">
                  {logs.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="events" className="mt-2">
            <ScrollArea className="h-[350px] rounded-md border bg-muted/30 p-4">
              {isLoadingEvents ? (
                <div className="flex items-center justify-center h-full">
                  <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : events.length === 0 && deploys.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  {cloudServiceId ? (
                    <p>No build events yet. Deploy to see activity.</p>
                  ) : (
                    <p>Create a cloud service to see build events.</p>
                  )}
                </div>
              ) : (
                <div className="space-y-3 font-mono text-sm">
                  {/* Show deploy history */}
                  {deploys.map((deploy) => {
                    const config = deployStatusConfig[deploy.status] || deployStatusConfig.created;
                    return (
                      <div key={deploy.id} className={`p-3 rounded-md border ${
                        deploy.status === "build_failed" || deploy.status === "update_failed" 
                          ? "border-destructive/50 bg-destructive/10" 
                          : deploy.status === "live"
                            ? "border-green-500/50 bg-green-500/10"
                            : "bg-muted/50"
                      }`}>
                        <div className="flex items-center justify-between mb-2">
                          <Badge variant={config.variant} className="flex items-center gap-1">
                            {config.icon}
                            {config.label}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(deploy.createdAt).toLocaleString()}
                          </span>
                        </div>
                        {deploy.commit && (
                          <p className="text-xs text-muted-foreground truncate">
                            Commit: {deploy.commit.message || deploy.commit.id}
                          </p>
                        )}
                        {deploy.finishedAt && (
                          <p className="text-xs text-muted-foreground">
                            Duration: {Math.round((new Date(deploy.finishedAt).getTime() - new Date(deploy.createdAt).getTime()) / 1000)}s
                          </p>
                        )}
                      </div>
                    );
                  })}
                  
                  {/* Show events if any */}
                  {events.map((event) => (
                    <div key={event.id} className="flex items-start gap-2 text-xs">
                      <span className="text-muted-foreground whitespace-nowrap">
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="text-primary">[{event.type}]</span>
                      {event.statusChange && (
                        <span>
                          {event.statusChange.from} → {event.statusChange.to}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="buildlogs" className="mt-2">
            <ScrollArea className="h-[350px] rounded-md border bg-background p-4">
              {isLoadingEvents ? (
                <div className="flex items-center justify-center h-full">
                  <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : !buildLogs ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <p>No build logs available. Logs appear after a build starts.</p>
                </div>
              ) : (
                <pre className="font-mono text-xs whitespace-pre-wrap text-foreground leading-relaxed">
                  {buildLogs.split("\n").map((line, idx) => {
                    const isError = line.toLowerCase().includes("error") || line.includes("npm ERR!");
                    const isWarning = line.toLowerCase().includes("warn");
                    return (
                      <div 
                        key={idx} 
                        className={`${isError ? "text-destructive" : isWarning ? "text-yellow-500" : ""}`}
                      >
                        {line}
                      </div>
                    );
                  })}
                </pre>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="activity" className="mt-2">
            <ScrollArea className="h-[350px] rounded-md border bg-muted/30 p-4">
              {logs.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  {isLoading ? (
                    <RefreshCw className="h-6 w-6 animate-spin" />
                  ) : (
                    <p>No activity logs yet</p>
                  )}
                </div>
              ) : (
                <div className="space-y-2 font-mono text-sm">
                  {logs.map((log) => {
                    const config = logTypeConfig[log.log_type] || logTypeConfig.info;
                    return (
                      <div key={log.id} className="flex items-start gap-2">
                        <span className="text-muted-foreground text-xs whitespace-nowrap">
                          {new Date(log.created_at).toLocaleTimeString()}
                        </span>
                        <Badge variant="outline" className={`${config.className} text-xs`}>
                          {config.icon}
                          <span className="ml-1">{log.log_type}</span>
                        </Badge>
                        <span className="flex-1 break-all">{log.message}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};

export default DeploymentLogsDialog;

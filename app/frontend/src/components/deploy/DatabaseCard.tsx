import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Database, MoreVertical, Play, Pause, RefreshCw, Trash2, Key, Loader2, ExternalLink, Settings, Terminal } from "lucide-react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { toast } from "sonner";
import { ConnectionStringDialog } from "./ConnectionStringDialog";
import { DatabaseDialog } from "./DatabaseDialog";

interface DatabaseCardProps {
  database: any;
  shareToken: string | null;
  onRefresh: () => void;
  onExplore?: () => void;
  showExploreOnly?: boolean;
}

export function DatabaseCard({ database, shareToken, onRefresh, onExplore, showExploreOnly = false }: DatabaseCardProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showConnectionDialog, setShowConnectionDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState<any>(null);

  const invokeCloudDatabase = async (action: string, extraBody: any = {}) => {
    setIsLoading(true);
    setLoadingAction(action);

    try {
      const { data, error } = await pronghornApi.functions.invoke("cloud-database", {
        body: {
          action,
          databaseId: database.id,
          shareToken,
          ...extraBody,
        },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || `Failed to ${action}`);
      }

      return data.data;
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

  const handleCreate = async () => {
    try {
      await invokeCloudDatabase("create");
      toast.success("Database provisioned successfully");
      onRefresh();
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const handleSyncStatus = async () => {
    try {
      await invokeCloudDatabase("status");
      toast.success("Status synced");
      onRefresh();
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const handleSuspend = async () => {
    try {
      await invokeCloudDatabase("suspend");
      toast.success("Database suspended");
      onRefresh();
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const handleResume = async () => {
    try {
      await invokeCloudDatabase("resume");
      toast.success("Database resumed");
      onRefresh();
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const handleRestart = async () => {
    try {
      await invokeCloudDatabase("restart");
      toast.success("Database restarting");
      onRefresh();
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const handleDelete = async () => {
    try {
      await invokeCloudDatabase("delete");
      toast.success("Database deleted");
      setShowDeleteDialog(false);
      onRefresh();
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const handleGetConnectionInfo = async () => {
    try {
      const info = await invokeCloudDatabase("connectionInfo");
      setConnectionInfo(info);
      setShowConnectionDialog(true);
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const getStatusBadge = () => {
    const statusColors: Record<string, string> = {
      pending: "bg-muted text-muted-foreground",
      creating: "bg-blue-500/20 text-blue-400",
      available: "bg-green-500/20 text-green-400",
      suspended: "bg-yellow-500/20 text-yellow-400",
      restarting: "bg-blue-500/20 text-blue-400",
      updating: "bg-blue-500/20 text-blue-400",
      failed: "bg-destructive/20 text-destructive",
      deleted: "bg-muted text-muted-foreground",
    };

    return (
      <Badge className={statusColors[database.status] || "bg-muted text-muted-foreground"}>
        {database.status}
      </Badge>
    );
  };

  const isProvisioned = database.has_connection_info || database.database_internal_name || database.render_postgres_id;
  const canCreate = database.status === "pending" && !isProvisioned;
  const canSuspend = false; // Suspended state is currently not supported by the backend - need to implement in Render first
  const canResume = false;
  const canRestart = false;
  const canGetConnection = database.has_connection_info && isProvisioned && database.status === "available";
  const canDelete = true;
  const canSync = isProvisioned && !["pending", "deleted"].includes(database.status);
  const canExplore = isProvisioned && database.status === "available";
  return (
    <>
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          {/* Mobile: stack vertically, Desktop: horizontal */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Top row on mobile: icon, status, menu */}
            <div className="flex items-center justify-between sm:hidden">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                  <Database className="h-5 w-5 text-primary" />
                </div>
                {getStatusBadge()}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" disabled={isLoading}>
                    {isLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <MoreVertical className="h-4 w-4" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canCreate && (
                    <DropdownMenuItem onClick={handleCreate}>
                      <Play className="h-4 w-4 mr-2" />
                      Create Database
                    </DropdownMenuItem>
                  )}
                  {canGetConnection && (
                    <DropdownMenuItem onClick={handleGetConnectionInfo}>
                      <Key className="h-4 w-4 mr-2" />
                      Get Connection String
                    </DropdownMenuItem>
                  )}
                  {canExplore && onExplore && (
                    <DropdownMenuItem onClick={onExplore}>
                      <Terminal className="h-4 w-4 mr-2" />
                      Explore Database
                    </DropdownMenuItem>
                  )}
                  {canSync && (
                    <DropdownMenuItem onClick={handleSyncStatus}>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Sync Status
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setShowEditDialog(true)}>
                    <Settings className="h-4 w-4 mr-2" />
                    Edit Configuration
                  </DropdownMenuItem>
                  {database.dashboard_url && (
                    <DropdownMenuItem asChild>
                      <a href={database.dashboard_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Open Dashboard
                      </a>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  {canSuspend && (
                    <DropdownMenuItem onClick={handleSuspend}>
                      <Pause className="h-4 w-4 mr-2" />
                      Suspend
                    </DropdownMenuItem>
                  )}
                  {canResume && (
                    <DropdownMenuItem onClick={handleResume}>
                      <Play className="h-4 w-4 mr-2" />
                      Resume
                    </DropdownMenuItem>
                  )}
                  {canRestart && (
                    <DropdownMenuItem onClick={handleRestart}>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Restart
                    </DropdownMenuItem>
                  )}
                  {canDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setShowDeleteDialog(true)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Title and subtitle - full width on mobile */}
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base sm:text-lg break-words">{database.name}</CardTitle>
              <p className="text-sm text-muted-foreground mt-0.5">
                PostgreSQL • {database.plan}
              </p>
            </div>

            {/* Desktop only: icon, status, menu in row */}
            <div className="hidden sm:flex items-center gap-2 shrink-0">
              <div className="p-2 rounded-lg bg-primary/10">
                <Database className="h-5 w-5 text-primary" />
              </div>
              {getStatusBadge()}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" disabled={isLoading}>
                    {isLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <MoreVertical className="h-4 w-4" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canCreate && (
                    <DropdownMenuItem onClick={handleCreate}>
                      <Play className="h-4 w-4 mr-2" />
                      Create Database
                    </DropdownMenuItem>
                  )}
                  {canGetConnection && (
                    <DropdownMenuItem onClick={handleGetConnectionInfo}>
                      <Key className="h-4 w-4 mr-2" />
                      Get Connection String
                    </DropdownMenuItem>
                  )}
                  {canExplore && onExplore && (
                    <DropdownMenuItem onClick={onExplore}>
                      <Terminal className="h-4 w-4 mr-2" />
                      Explore Database
                    </DropdownMenuItem>
                  )}
                  {canSync && (
                    <DropdownMenuItem onClick={handleSyncStatus}>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Sync Status
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setShowEditDialog(true)}>
                    <Settings className="h-4 w-4 mr-2" />
                    Edit Configuration
                  </DropdownMenuItem>
                  {database.dashboard_url && (
                    <DropdownMenuItem asChild>
                      <a href={database.dashboard_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Open Dashboard
                      </a>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  {canSuspend && (
                    <DropdownMenuItem onClick={handleSuspend}>
                      <Pause className="h-4 w-4 mr-2" />
                      Suspend
                    </DropdownMenuItem>
                  )}
                  {canResume && (
                    <DropdownMenuItem onClick={handleResume}>
                      <Play className="h-4 w-4 mr-2" />
                      Resume
                    </DropdownMenuItem>
                  )}
                  {canRestart && (
                    <DropdownMenuItem onClick={handleRestart}>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Restart
                    </DropdownMenuItem>
                  )}
                  {canDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setShowDeleteDialog(true)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {showExploreOnly ? (
            // Simplified view for Manage tab - just show explore button
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                PostgreSQL {database.postgres_version || "16"} • {database.region || "oregon"}
              </div>
              {canExplore && onExplore ? (
                <Button onClick={onExplore} variant="default" size="sm">
                  <Terminal className="h-4 w-4 mr-2" />
                  Explore Database
                </Button>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {database.status === "pending" ? "Database not created yet" : "Database not available"}
                </span>
              )}
            </div>
          ) : (
            // Full view for Deploy tab
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                {/* <div>
                  <span className="text-muted-foreground">Region</span>
                  <p className="font-medium">{database.region || "oregon"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Version</span>
                  <p className="font-medium">PostgreSQL {database.postgres_version || "16"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Plan</span>
                  <p className="font-medium capitalize">{database.plan}</p>
                </div> */}
                <div>
                  <span className="text-muted-foreground">Created</span>
                  <p className="font-medium">{new Date(database.created_at).toLocaleDateString()}</p>
                </div>
              </div>

              {canCreate && (
                <div className="mt-4 pt-4 border-t border-border">
                  <Button onClick={handleCreate} disabled={isLoading} className="w-full">
                    {loadingAction === "create" ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4 mr-2" />
                        Provision Azure PostgreSQL Database
                      </>
                    )}
                  </Button>
                </div>
              )}

              {canGetConnection && (
                <div className="mt-4 pt-4 border-t border-border">
                  <div className="flex gap-2">
                    <Button onClick={handleGetConnectionInfo} variant="outline" disabled={isLoading} className="flex-1">
                      {loadingAction === "connectionInfo" ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Fetching...
                        </>
                      ) : (
                        <>
                          <Key className="h-4 w-4 mr-2" />
                          Connection String
                        </>
                      )}
                    </Button>
                    {onExplore && (
                      <Button onClick={onExplore} variant="default" disabled={isLoading} className="flex-1">
                        <Terminal className="h-4 w-4 mr-2" />
                        Explore
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Database?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the database "{database.name}" and all its data.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {loadingAction === "delete" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConnectionStringDialog
        open={showConnectionDialog}
        onOpenChange={setShowConnectionDialog}
        connectionInfo={connectionInfo}
        databaseName={database.name}
      />

      <DatabaseDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        mode="edit"
        database={database}
        projectId={database.project_id}
        shareToken={shareToken}
        onSuccess={onRefresh}
      />

    </>
  );
}

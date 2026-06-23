import { useState, useEffect, useCallback, useRef } from "react";
import { PrimaryNav } from "@/components/layout/PrimaryNav";
import { ProjectSidebar } from "@/components/layout/ProjectSidebar";
import { ProjectPageHeader } from "@/components/layout/ProjectPageHeader";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy, EyeOff, ImageIcon, Globe } from "lucide-react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useShareToken } from "@/hooks/useShareToken";
import { TokenRecoveryMessage } from "@/components/project/TokenRecoveryMessage";

import { useAuth } from "@/contexts/AuthContext";
import { useAdmin } from "@/contexts/AdminContext";
import { DeleteProjectDialog } from "@/components/dashboard/DeleteProjectDialog";
import { CloneProjectDialog } from "@/components/dashboard/CloneProjectDialog";
import { TokenManagement } from "@/components/project/TokenManagement";
import { AccessLevelBanner } from "@/components/project/AccessLevelBanner";
import { SplashImageSelector } from "@/components/project/SplashImageSelector";
import { PublishProjectDialog } from "@/components/admin/PublishProjectDialog";
import { useRealtimeArtifacts } from "@/hooks/useRealtimeArtifacts";

import { Switch } from "@/components/ui/switch";
import { ProjectActivityHeatmap } from "@/components/project/ProjectActivityHeatmap";
import { getEnabledModels, supportsThinking } from "@/config/aiModels";

export default function ProjectSettings() {
  const { projectId } = useParams<{ projectId: string }>();
  const { token: shareToken, isTokenSet, tokenMissing } = useShareToken(projectId);
  const { user } = useAuth();
  const { isSuperAdmin } = useAdmin();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [organization, setOrganization] = useState("");
  const [budget, setBudget] = useState("");
  const [scope, setScope] = useState("");
  const [timelineStart, setTimelineStart] = useState("");
  const [timelineEnd, setTimelineEnd] = useState("");
  const [priority, setPriority] = useState("medium");
  const [tags, setTags] = useState("");
  const [splashImageUrl, setSplashImageUrl] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("gpt-4o");
  const [maxTokens, setMaxTokens] = useState(32768);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [thinkingBudget, setThinkingBudget] = useState(-1);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Fetch artifacts for splash image selector
  const { artifacts } = useRealtimeArtifacts(projectId, shareToken, isTokenSet);

  const channelRef = useRef<ReturnType<typeof pronghornApi.channel> | null>(null);

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

  const { data: project, refetch: refetchProject } = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const { data, error } = await pronghornApi.rpc("get_project_with_token", {
        p_project_id: projectId,
        p_token: shareToken || null,
      });

      if (error) throw error;
      return data;
    },
    enabled: !!projectId && isTokenSet,
  });

  // Real-time subscription for project changes
  useEffect(() => {
    if (!projectId || !isTokenSet) return;

    const channel = pronghornApi
      .channel(`project-${projectId}`)
      .on("broadcast", { event: "project_refresh" }, () => refetchProject())
      .subscribe();

    channelRef.current = channel;

    return () => {
      pronghornApi.removeChannel(channel);
      channelRef.current = null;
    };
  }, [projectId, isTokenSet, refetchProject]);

  // Get user's role via authorize_project_access
  const { data: userRole } = useQuery({
    queryKey: ["project-role", projectId, shareToken],
    queryFn: async () => {
      const { data, error } = await pronghornApi.rpc("authorize_project_access", {
        p_project_id: projectId,
        p_token: shareToken || null,
      });
      if (error) return null;
      return data as string | null;
    },
    enabled: !!projectId && isTokenSet,
  });

  const isOwner = userRole === "owner";

  // Fetch project tokens to auto-update URL with owner token
  const { data: tokens } = useQuery({
    queryKey: ["project-tokens", projectId],
    queryFn: async () => {
      const { data, error } = await pronghornApi.rpc("get_project_tokens_with_token", {
        p_project_id: projectId,
        p_token: shareToken || null,
      });
      if (error) return [];
      return data as Array<{ id: string; token: string; role: string; label: string | null }>;
    },
    // Enable for authenticated users OR when token is ready
    enabled: !!projectId && isOwner && (!!user || isTokenSet),
  });

  // Auto-update URL with owner token if not present
  useEffect(() => {
    if (!tokens || tokens.length === 0 || shareToken) return;
    
    // Find "Default Owner Token" first, then any owner token
    const defaultOwnerToken = tokens.find(
      (t) => t.role === "owner" && t.label === "Default Owner Token"
    );
    const firstOwnerToken = tokens.find((t) => t.role === "owner");
    const ownerToken = defaultOwnerToken || firstOwnerToken;
    
    if (ownerToken) {
      navigate(`/project/${projectId}/settings/t/${ownerToken.token}`, { replace: true });
    }
  }, [tokens, shareToken, projectId, navigate]);

  // Helper to format ISO date string to yyyy-MM-dd for date inputs
  const formatDateForInput = (dateStr: string | null | undefined): string => {
    if (!dateStr) return "";
    // If already in yyyy-MM-dd format, return as is
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
    // Extract just the date part from ISO format (e.g., "2026-02-04T00:00:00.000Z" -> "2026-02-04")
    const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : "";
  };

  useEffect(() => {
    if (project) {
      setProjectName(project.name || "");
      setProjectDescription(project.description || "");
      setOrganization(project.organization || "");
      setBudget(project.budget?.toString() || "");
      setScope(project.scope || "");
      setTimelineStart(formatDateForInput(project.timeline_start));
      setTimelineEnd(formatDateForInput(project.timeline_end));
      setPriority(project.priority || "medium");
      setTags(project.tags?.join(", ") || "");
      setSplashImageUrl((project as any).splash_image_url || null);
      setSelectedModel(project.selected_model || "gpt-4o");
      setMaxTokens(project.max_tokens || 32768);
      setThinkingEnabled(project.thinking_enabled || false);
      setThinkingBudget(project.thinking_budget || -1);
    }
  }, [project]);

  const updateProjectMutation = useMutation({
    mutationFn: async () => {
      console.log("[ProjectSettings] Saving project with timeline:", { timelineStart, timelineEnd });
      
      const { data, error } = await pronghornApi.rpc("update_project_with_token", {
        p_project_id: projectId,
        p_token: shareToken || null,
        p_name: projectName,
        p_description: projectDescription,
        p_organization: organization,
        p_budget: budget ? parseFloat(budget) : null,
        p_scope: scope,
        p_timeline_start: timelineStart || null,
        p_timeline_end: timelineEnd || null,
        p_priority: priority,
        p_tags: tags
          ? tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : null,
        // Pass actual value or null (not undefined) - the RPC uses '__UNCHANGED__' as default
        p_splash_image_url: splashImageUrl ?? null,
      });

      console.log("[ProjectSettings] Update response:", { data, error });

      if (error) throw error;
      if (!data) throw new Error("Project update failed - no data returned");

      // Update LLM settings via RPC
      const { error: llmError } = await pronghornApi.rpc("update_project_llm_settings_with_token", {
        p_project_id: projectId,
        p_token: shareToken || null,
        p_selected_model: selectedModel,
        p_max_tokens: maxTokens,
        p_thinking_enabled: thinkingEnabled,
        p_thinking_budget: thinkingBudget,
      });

      if (llmError) throw llmError;

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      broadcastRefresh();
      toast.success("Project details updated successfully");
    },
    onError: (error: any) => {
      console.error("Project update error:", error);
      const errorMessage = error?.message || error?.error || "Failed to update project details";
      toast.error(errorMessage);
    },
  });

  // Copy current URL for sharing
  
  // Show token recovery message if token is missing
  if (tokenMissing) {
    return (
      <div className="min-h-screen bg-background">
        <PrimaryNav />
        <TokenRecoveryMessage />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PrimaryNav />
      <div className="flex relative">
        <ProjectSidebar projectId={projectId!} isOpen={isSidebarOpen} onOpenChange={setIsSidebarOpen} />
        <main className="flex-1 overflow-auto w-full">
          <div className="px-4 md:px-6 py-6 md:py-8">
            <ProjectPageHeader
              title="Project Settings"
              subtitle="Configure your project settings and sharing options"
              onMenuClick={() => setIsSidebarOpen(true)}
            />
            <div className="space-y-6">
              {/* Show TokenManagement for owners, AccessLevelBanner for non-owners */}
                {isOwner ? (
                  <TokenManagement projectId={projectId!} shareToken={shareToken} />
                ) : (
                  <AccessLevelBanner projectId={projectId!} shareToken={shareToken} />
                )}

                {/* Project Details */}
                <Card>
                  <CardHeader>
                    <CardTitle>Project Details</CardTitle>
                    <CardDescription>Basic information about your project</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Project Name</Label>
                      <Input id="name" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="description">Project Description</Label>
                      <Textarea
                        id="description"
                        value={projectDescription}
                        onChange={(e) => setProjectDescription(e.target.value)}
                        placeholder="Enter detailed project description that can be used for AI context..."
                        rows={8}
                        className="resize-none"
                      />
                    </div>

                    {/* Splash Image Section */}
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2">
                        <ImageIcon className="h-4 w-4" />
                        Project Cover Image
                      </Label>
                      <p className="text-xs text-muted-foreground mb-2">
                        This image is displayed on the dashboard card and gallery
                      </p>
                      <SplashImageSelector
                        projectId={projectId!}
                        shareToken={shareToken}
                        currentImageUrl={splashImageUrl}
                        artifacts={artifacts}
                        onImageSelect={setSplashImageUrl}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="organization">Organization</Label>
                      <Input
                        id="organization"
                        placeholder="Organization name"
                        value={organization}
                        onChange={(e) => setOrganization(e.target.value)}
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="budget">Budget</Label>
                        <Input
                          id="budget"
                          type="number"
                          placeholder="0.00"
                          value={budget}
                          onChange={(e) => setBudget(e.target.value)}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="priority">Priority</Label>
                        <Select value={priority} onValueChange={setPriority}>
                          <SelectTrigger id="priority">
                            <SelectValue placeholder="Select priority" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="low">Low</SelectItem>
                            <SelectItem value="medium">Medium</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                            <SelectItem value="critical">Critical</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="scope">Scope</Label>
                      <Textarea
                        id="scope"
                        placeholder="Define project scope and boundaries..."
                        value={scope}
                        onChange={(e) => setScope(e.target.value)}
                        rows={3}
                        className="resize-none"
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="timeline-start">Timeline Start</Label>
                        <Input
                          id="timeline-start"
                          type="date"
                          value={timelineStart}
                          onChange={(e) => setTimelineStart(e.target.value)}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="timeline-end">Timeline End</Label>
                        <Input
                          id="timeline-end"
                          type="date"
                          value={timelineEnd}
                          onChange={(e) => setTimelineEnd(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="tags">Tags</Label>
                      <Input
                        id="tags"
                        placeholder="tag1, tag2, tag3"
                        value={tags}
                        onChange={(e) => setTags(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">Comma-separated tags for project categorization</p>
                    </div>

                    <Button onClick={() => updateProjectMutation.mutate()} disabled={updateProjectMutation.isPending}>
                      {updateProjectMutation.isPending ? "Saving..." : "Save Changes"}
                    </Button>
                  </CardContent>
                </Card>

                {/* LLM Configuration */}
                <Card>
                  <CardHeader>
                    <CardTitle>LLM Configuration</CardTitle>
                    <CardDescription>Configure AI model settings for chat (Azure AI Foundry)</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="model-select">Model</Label>
                      <Select value={selectedModel} onValueChange={setSelectedModel}>
                        <SelectTrigger id="model-select">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {getEnabledModels().map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              {model.displayName} ({model.description.split(" - ")[1] || model.description})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        All models powered by Azure AI Foundry via APIM with Managed Identity
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="max-tokens-select">Response Length</Label>
                      <Select value={maxTokens.toString()} onValueChange={(val) => setMaxTokens(Number(val))}>
                        <SelectTrigger id="max-tokens-select">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="2048">Short (2,048 tokens)</SelectItem>
                          <SelectItem value="8192">Medium (8,192 tokens)</SelectItem>
                          <SelectItem value="16384">Large (16,384 tokens)</SelectItem>
                          <SelectItem value="32768">XL (32,768 tokens)</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">Longer responses may take more time to generate</p>
                    </div>

                    {supportsThinking(selectedModel) && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label htmlFor="thinking-enabled">Extended Thinking</Label>
                          <Switch
                            id="thinking-enabled"
                            checked={thinkingEnabled}
                            onCheckedChange={setThinkingEnabled}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Enable extended reasoning for complex problems (supported by this model)
                        </p>

                        {thinkingEnabled && (
                          <div className="space-y-2 mt-3">
                            <Label htmlFor="thinking-budget-select">Thinking Budget</Label>
                            <Select
                              value={thinkingBudget.toString()}
                              onValueChange={(val) => setThinkingBudget(Number(val))}
                            >
                              <SelectTrigger id="thinking-budget-select">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="-1">Auto (Recommended)</SelectItem>
                                <SelectItem value="5000">Small (5,000 tokens)</SelectItem>
                                <SelectItem value="10000">Medium (10,000 tokens)</SelectItem>
                                <SelectItem value="20000">Large (20,000 tokens)</SelectItem>
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                              Higher budgets allow more reasoning steps for complex problems
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    <Button onClick={() => updateProjectMutation.mutate()} disabled={updateProjectMutation.isPending}>
                      {updateProjectMutation.isPending ? "Saving..." : "Save LLM Settings"}
                    </Button>
                  </CardContent>
                </Card>

                {/* Project Activity Heatmap */}
                <ProjectActivityHeatmap projectId={projectId!} shareToken={shareToken} isTokenSet={isTokenSet} />

                {/* Clone Project */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Copy className="h-5 w-5" />
                      Clone Project
                    </CardTitle>
                    <CardDescription>
                      Create a copy of this project with selected components
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <CloneProjectDialog
                      projectId={projectId!}
                      projectName={project?.name || "Project"}
                      shareToken={shareToken}
                      trigger={
                        <Button variant="outline">
                          <Copy className="mr-2 h-4 w-4" />
                          Clone This Project
                        </Button>
                      }
                    />
                  </CardContent>
                </Card>

                {/* Danger Zone - Project Deletion (owner role required) */}
                {isOwner && (
                  <Card className="border-destructive">
                    <CardHeader>
                      <CardTitle className="text-destructive">Danger Zone</CardTitle>
                      <CardDescription>
                        Irreversible actions that will permanently delete your project and all associated data.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Superadmin: Publish controls */}
                      {isSuperAdmin && (
                        <div className="space-y-3 pb-4 border-b border-border">
                          <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-2 font-medium">
                                <Globe className="h-4 w-4" />
                                Publish to Gallery
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Make this project available in the public gallery for others to clone
                              </p>
                            </div>
                            <PublishProjectDialog
                              projectId={projectId!}
                              projectName={project?.name || ""}
                              projectDescription={project?.description}
                              projectTags={project?.tags}
                              splashImageUrl={splashImageUrl}
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-2 font-medium">
                                <EyeOff className="h-4 w-4" />
                                Toggle Visibility
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Hide or show this project in the public gallery
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={async () => {
                                try {
                                  // First get the published_project id
                                  const { data: pubData } = await pronghornApi
                                    .from("published_projects")
                                    .select("id")
                                    .eq("project_id", projectId)
                                    .single();
                                  
                                  if (!pubData) {
                                    toast.error("Project is not published yet");
                                    return;
                                  }
                                  
                                  const { error } = await pronghornApi.rpc("toggle_published_project_visibility", {
                                    p_published_id: pubData.id
                                  });
                                  if (error) throw error;
                                  toast.success("Visibility toggled!");
                                } catch (err) {
                                  toast.error(err instanceof Error ? err.message : "Failed to toggle visibility");
                                }
                              }}
                            >
                              <EyeOff className="mr-2 h-4 w-4" />
                              Toggle
                            </Button>
                          </div>
                        </div>
                      )}
                      
                      <div className="flex items-start gap-3 p-3 rounded-md bg-destructive/10">
                        <div className="flex-1 space-y-2">
                          <p className="text-sm text-muted-foreground">
                            Deleting this project will permanently remove all associated data including requirements, canvas nodes, standards, chat sessions, and artifacts. This action cannot be undone.
                          </p>
                          <DeleteProjectDialog
                            projectId={projectId!}
                            projectName={project?.name || "this project"}
                            shareToken={shareToken}
                            onDelete={() => {
                              toast.success("Project deleted successfully");
                              navigate("/dashboard");
                            }}
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
          </div>
        </main>
      </div>
    </div>
  );
}


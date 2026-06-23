import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import {
  Copy,
  FileText,
  MessageSquare,
  Layers,
  GitBranch,
  Database,
  Sparkles,
  Shield,
  Cpu,
  Image as ImageIcon,
  Rocket,
  CheckCircle2,
  XCircle,
} from "lucide-react";

interface ContentSummary {
  requirements: number;
  canvas_nodes: number;
  canvas_edges: number;
  canvas_layers: number;
  chat_sessions: number;
  chat_messages: number;
  artifacts: number;
  artifacts_with_images: number;
  specifications: number;
  standards: number;
  tech_stacks: number;
  repos: number;
  repo_files: number;
  databases: number;
  deployments: number;
}

interface GalleryPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publishedId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  tags: string[] | null;
  onClone: () => void;
}

interface ContentItemProps {
  icon: React.ReactNode;
  label: string;
  count: number;
  subLabel?: string;
}

function ContentItem({ icon, label, count, subLabel }: ContentItemProps) {
  const hasContent = count > 0;
  
  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border ${
      hasContent ? "bg-primary/5 border-primary/20" : "bg-muted/30 border-border/50"
    }`}>
      <div className={`${hasContent ? "text-primary" : "text-muted-foreground"}`}>
        {icon}
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium ${hasContent ? "" : "text-muted-foreground"}`}>
            {label}
          </span>
          {hasContent ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-muted-foreground/50" />
          )}
        </div>
        {subLabel && count > 0 && (
          <span className="text-xs text-muted-foreground">{subLabel}</span>
        )}
      </div>
      <Badge variant={hasContent ? "default" : "secondary"} className="min-w-[40px] justify-center">
        {count}
      </Badge>
    </div>
  );
}

export function GalleryPreviewDialog({
  open,
  onOpenChange,
  publishedId,
  name,
  description,
  imageUrl,
  tags,
  onClone,
}: GalleryPreviewDialogProps) {
  const [summary, setSummary] = useState<ContentSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    if (open && publishedId) {
      fetchSummary();
    }
  }, [open, publishedId]);

  const fetchSummary = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await pronghornApi.rpc("get_published_project_content_summary", {
        p_published_id: publishedId,
      });
      
      if (error) throw error;
      setSummary(data as unknown as ContentSummary);
    } catch (error) {
      console.error("Error fetching content summary:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="text-xl">{name}</DialogTitle>
          {description && (
            <DialogDescription className="text-base">{description}</DialogDescription>
          )}
        </DialogHeader>

        {/* Image */}
        {imageUrl && !imageError && (
          <div className="relative aspect-video rounded-lg overflow-hidden bg-muted">
            <img
              src={imageUrl}
              alt={name}
              className="w-full h-full object-cover"
              onError={() => setImageError(true)}
            />
          </div>
        )}

        {/* Tags */}
        {tags && tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {/* Content Summary */}
        <div>
          <h4 className="text-sm font-semibold mb-3">Project Contents</h4>
          <ScrollArea className="h-[280px] pr-4">
            {isLoading ? (
              <div className="space-y-2">
                {[...Array(8)].map((_, i) => (
                  <Skeleton key={i} className="h-14" />
                ))}
              </div>
            ) : summary ? (
              <div className="space-y-2">
                <ContentItem
                  icon={<FileText className="h-5 w-5" />}
                  label="Requirements"
                  count={summary.requirements}
                />
                <ContentItem
                  icon={<Layers className="h-5 w-5" />}
                  label="Canvas"
                  count={summary.canvas_nodes}
                  subLabel={`${summary.canvas_edges} connections, ${summary.canvas_layers} layers`}
                />
                <ContentItem
                  icon={<MessageSquare className="h-5 w-5" />}
                  label="Chat Sessions"
                  count={summary.chat_sessions}
                  subLabel={`${summary.chat_messages} messages`}
                />
                <ContentItem
                  icon={<ImageIcon className="h-5 w-5" />}
                  label="Artifacts"
                  count={summary.artifacts}
                  subLabel={`${summary.artifacts_with_images} with images`}
                />
                <ContentItem
                  icon={<Sparkles className="h-5 w-5" />}
                  label="Specifications"
                  count={summary.specifications}
                />
                <ContentItem
                  icon={<Shield className="h-5 w-5" />}
                  label="Standards"
                  count={summary.standards}
                />
                <ContentItem
                  icon={<Cpu className="h-5 w-5" />}
                  label="Tech Stacks"
                  count={summary.tech_stacks}
                />
                <ContentItem
                  icon={<GitBranch className="h-5 w-5" />}
                  label="Repository Files"
                  count={summary.repo_files}
                />
                <ContentItem
                  icon={<Database className="h-5 w-5" />}
                  label="Databases"
                  count={summary.databases}
                />
                <ContentItem
                  icon={<Rocket className="h-5 w-5" />}
                  label="Deployments"
                  count={summary.deployments}
                />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Failed to load content summary</p>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={onClone}>
            <Copy className="h-4 w-4 mr-2" />
            Clone This Project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

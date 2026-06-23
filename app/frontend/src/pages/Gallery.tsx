import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { PrimaryNav } from "@/components/layout/PrimaryNav";
import { GalleryCard } from "@/components/gallery/GalleryCard";
import { GalleryPreviewDialog } from "@/components/gallery/GalleryPreviewDialog";
import { GalleryCloneDialog } from "@/components/gallery/GalleryCloneDialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Search,
  LayoutGrid,
  List,
  Sparkles,
  LogIn,
  Image as ImageIcon,
  Eye,
  Copy,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

interface PublishedProject {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  category: string | null;
  tags: string[] | null;
  view_count: number | null;
  clone_count: number | null;
  published_at: string;
}

export default function Gallery() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [previewProject, setPreviewProject] = useState<PublishedProject | null>(null);
  const [cloneProject, setCloneProject] = useState<PublishedProject | null>(null);

  // Fetch published projects
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["published-projects"],
    queryFn: async () => {
      const { data, error } = await pronghornApi.rpc("get_published_projects");

      if (error) {
        console.error("Error loading published projects:", error);
        return [];
      }

      return (data || []) as PublishedProject[];
    },
    staleTime: 60000, // 1 minute
  });

  // Get unique categories
  const categories = useMemo(() => {
    const cats = new Set<string>();
    projects.forEach((p) => {
      if (p.category) cats.add(p.category);
    });
    return Array.from(cats).sort();
  }, [projects]);

  // Get all unique tags for filtering
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    projects.forEach((p) => {
      p.tags?.forEach((t) => tagSet.add(t));
    });
    return Array.from(tagSet).sort();
  }, [projects]);

  // Filter projects
  const filteredProjects = useMemo(() => {
    return projects.filter((p) => {
      // Search filter
      const searchLower = searchQuery.toLowerCase();
      const matchesSearch =
        !searchQuery ||
        p.name.toLowerCase().includes(searchLower) ||
        p.description?.toLowerCase().includes(searchLower) ||
        p.tags?.some((t) => t.toLowerCase().includes(searchLower));

      // Category filter
      const matchesCategory = categoryFilter === "all" || p.category === categoryFilter;

      return matchesSearch && matchesCategory;
    });
  }, [projects, searchQuery, categoryFilter]);

  const handlePreview = (project: PublishedProject) => {
    setPreviewProject(project);
  };

  const handleClone = (project: PublishedProject) => {
    if (!user) {
      navigate("/auth");
      return;
    }
    setCloneProject(project);
  };

  return (
    <div className="min-h-screen bg-background">
      <PrimaryNav />
      <main className="container px-4 md:px-6 py-6 md:py-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between gap-4 mb-6 md:mb-8">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold mb-2 flex items-center gap-2">
              <Sparkles className="h-7 w-7 text-primary" />
              Project Gallery
            </h1>
            <p className="text-sm md:text-base text-muted-foreground">
              Browse and clone published projects to kickstart your work
            </p>
          </div>

          {/* Stats */}
          <div className="flex items-center gap-4">
            <div className="text-center px-4 py-2 bg-muted/50 rounded-lg">
              <p className="text-2xl font-bold text-primary">{projects.length}</p>
              <p className="text-xs text-muted-foreground">Projects</p>
            </div>
          </div>
        </div>

        {/* Login prompt for non-authenticated users */}
        {!user && (
          <Alert className="mb-6">
            <LogIn className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between">
              <span>Sign in to clone projects to your account</span>
              <Button variant="outline" size="sm" onClick={() => navigate("/auth")}>
                Sign In
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Filters and Search */}
        <div className="flex flex-col md:flex-row gap-4 mb-6">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Category filter */}
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* View toggle */}
          <ToggleGroup type="single" value={viewMode} onValueChange={(v) => v && setViewMode(v as "grid" | "list")}>
            <ToggleGroupItem value="grid" aria-label="Grid view">
              <LayoutGrid className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List view">
              <List className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* Tag chips (show top tags) */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-6">
            {allTags.slice(0, 10).map((tag) => (
              <Badge
                key={tag}
                variant={searchQuery === tag ? "default" : "outline"}
                className="cursor-pointer hover:bg-primary/10 transition-colors"
                onClick={() => setSearchQuery(searchQuery === tag ? "" : tag)}
              >
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {/* Loading state */}
        {isLoading ? (
          <div className={`grid gap-6 ${viewMode === "grid" ? "md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : ""}`}>
            {[...Array(8)].map((_, i) => (
              <div key={i} className="space-y-3">
                <Skeleton className="aspect-video w-full" />
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="text-center py-16">
            <ImageIcon className="h-16 w-16 mx-auto mb-4 text-muted-foreground/30" />
            <h3 className="text-lg font-semibold mb-2">No projects found</h3>
            <p className="text-muted-foreground">
              {searchQuery || categoryFilter !== "all"
                ? "Try adjusting your search or filters"
                : "No projects have been published yet"}
            </p>
          </div>
        ) : viewMode === "grid" ? (
          /* Grid View */
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredProjects.map((project) => (
              <GalleryCard
                key={project.id}
                id={project.id}
                name={project.name}
                description={project.description}
                imageUrl={project.image_url}
                category={project.category}
                tags={project.tags}
                viewCount={project.view_count || 0}
                cloneCount={project.clone_count || 0}
                onPreview={() => handlePreview(project)}
                onClone={() => handleClone(project)}
              />
            ))}
          </div>
        ) : (
          /* List View */
          <div className="space-y-4">
            {filteredProjects.map((project) => (
              <div
                key={project.id}
                className="flex gap-4 p-4 rounded-lg border bg-card hover:shadow-md transition-shadow"
              >
                {/* Thumbnail */}
                <div className="w-32 h-20 rounded-md overflow-hidden bg-muted flex-shrink-0">
                  {project.image_url ? (
                    <img
                      src={project.image_url}
                      alt={project.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <ImageIcon className="h-8 w-8 text-muted-foreground/30" />
                    </div>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-lg line-clamp-1">{project.name}</h3>
                  {project.description && (
                    <p className="text-sm text-muted-foreground line-clamp-1 mb-2">
                      {project.description}
                    </p>
                  )}
                  <div className="flex items-center gap-4">
                    {project.category && (
                      <Badge variant="secondary">{project.category}</Badge>
                    )}
                    {project.tags?.slice(0, 3).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Eye className="h-3 w-3" />
                      {project.view_count || 0}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Copy className="h-3 w-3" />
                      {project.clone_count || 0}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => handlePreview(project)}>
                    Preview
                  </Button>
                  <Button size="sm" onClick={() => handleClone(project)}>
                    Clone
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Preview Dialog */}
      {previewProject && (
        <GalleryPreviewDialog
          open={!!previewProject}
          onOpenChange={(open) => !open && setPreviewProject(null)}
          publishedId={previewProject.id}
          name={previewProject.name}
          description={previewProject.description}
          imageUrl={previewProject.image_url}
          tags={previewProject.tags}
          onClone={() => {
            setPreviewProject(null);
            handleClone(previewProject);
          }}
        />
      )}

      {/* Clone Dialog */}
      {cloneProject && (
        <GalleryCloneDialog
          open={!!cloneProject}
          onOpenChange={(open) => !open && setCloneProject(null)}
          publishedId={cloneProject.id}
          projectName={cloneProject.name}
        />
      )}
    </div>
  );
}

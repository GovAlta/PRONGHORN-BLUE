import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Eye, Copy, Image as ImageIcon } from "lucide-react";

interface GalleryCardProps {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  category: string | null;
  tags: string[] | null;
  viewCount: number;
  cloneCount: number;
  onPreview: () => void;
  onClone: () => void;
}

export function GalleryCard({
  name,
  description,
  imageUrl,
  category,
  tags,
  viewCount,
  cloneCount,
  onPreview,
  onClone,
}: GalleryCardProps) {
  const [imageError, setImageError] = useState(false);

  return (
    <Card className="group overflow-hidden hover:shadow-lg transition-all duration-300 border-border/50 hover:border-primary/30">
      {/* Image area */}
      <div className="relative aspect-video bg-gradient-to-br from-primary/20 via-primary/10 to-background overflow-hidden">
        {imageUrl && !imageError ? (
          <img
            src={imageUrl}
            alt={name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            onError={() => setImageError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}
        
        {/* Category badge */}
        {category && (
          <Badge 
            variant="secondary" 
            className="absolute top-3 left-3 bg-background/80 backdrop-blur-sm"
          >
            {category}
          </Badge>
        )}
        
        {/* Hover overlay with actions */}
        <div className="absolute inset-0 bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center gap-3">
          <Button variant="secondary" size="sm" onClick={onPreview}>
            <Eye className="h-4 w-4 mr-2" />
            Preview
          </Button>
          <Button size="sm" onClick={onClone}>
            <Copy className="h-4 w-4 mr-2" />
            Clone
          </Button>
        </div>
      </div>
      
      {/* Content area */}
      <CardContent className="p-4">
        <h3 className="font-semibold text-lg mb-1 line-clamp-1 group-hover:text-primary transition-colors">
          {name}
        </h3>
        
        {description && (
          <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
            {description}
          </p>
        )}
        
        {/* Tags */}
        {tags && tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
            {tags.length > 3 && (
              <Badge variant="outline" className="text-xs">
                +{tags.length - 3}
              </Badge>
            )}
          </div>
        )}
        
        {/* Stats row */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Eye className="h-3 w-3" />
            {viewCount || 0}
          </span>
          <span className="flex items-center gap-1">
            <Copy className="h-3 w-3" />
            {cloneCount || 0}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

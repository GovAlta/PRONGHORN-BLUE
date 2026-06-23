import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Image, X, ScanEye } from "lucide-react";
import { cn } from "@/lib/utils";
import { CompactDropZone } from "./CompactDropZone";

export interface ImageFile {
  id: string;
  file: File;
  preview: string;
  selected: boolean;
}

interface ArtifactImageGalleryProps {
  images: ImageFile[];
  onImagesChange: (images: ImageFile[]) => void;
  vrOverriddenContent?: Map<string, string>;
}

export function ArtifactImageGallery({ 
  images, 
  onImagesChange, 
  vrOverriddenContent 
}: ArtifactImageGalleryProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null);

  const handleDragOver = () => {
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    addFiles(files);
  };

  const handleFileSelect = (files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith("image/"));
    addFiles(imageFiles);
  };

  const addFiles = (files: File[]) => {
    const newImages: ImageFile[] = files.map(file => ({
      id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      file,
      preview: URL.createObjectURL(file),
      selected: true,
    }));
    onImagesChange([...images, ...newImages]);
  };

  const toggleSelection = (id: string) => {
    onImagesChange(
      images.map(img => 
        img.id === id ? { ...img, selected: !img.selected } : img
      )
    );
  };

  const removeImage = (id: string) => {
    const image = images.find(img => img.id === id);
    if (image) {
      URL.revokeObjectURL(image.preview);
    }
    onImagesChange(images.filter(img => img.id !== id));
    if (expandedImageId === id) {
      setExpandedImageId(null);
    }
  };

  const selectAll = () => {
    onImagesChange(images.map(img => ({ ...img, selected: true })));
  };

  const selectNone = () => {
    onImagesChange(images.map(img => ({ ...img, selected: false })));
  };

  const clearAll = () => {
    images.forEach(img => URL.revokeObjectURL(img.preview));
    onImagesChange([]);
    setExpandedImageId(null);
  };

  const getVrContent = (imageId: string): string | undefined => {
    if (!vrOverriddenContent) return undefined;
    return vrOverriddenContent.get(`gallery-${imageId}`);
  };

  const selectedCount = images.filter(i => i.selected).length;
  const ocrCount = images.filter(img => getVrContent(img.id)).length;

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <CompactDropZone
        icon={Image}
        label="Drop images here or click to browse"
        buttonText="Select"
        acceptText="JPG, PNG, GIF, WebP"
        accept="image/*"
        onFilesSelected={handleFileSelect}
        isDragging={isDragging}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      />

      {images.length > 0 && (
        <>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <Button variant="outline" size="sm" onClick={selectAll}>
              Select All
            </Button>
            <Button variant="outline" size="sm" onClick={selectNone}>
              Select None
            </Button>
            <Button variant="outline" size="sm" onClick={clearAll}>
              Clear All
            </Button>
            <span className="text-sm text-muted-foreground ml-auto">
              {selectedCount} of {images.length} selected
              {ocrCount > 0 && (
                <Badge variant="secondary" className="ml-2 gap-1">
                  <ScanEye className="h-3 w-3" />
                  {ocrCount} OCR
                </Badge>
              )}
            </span>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 p-1">
              {images.map(image => {
                const vrContent = getVrContent(image.id);
                const hasOcr = !!vrContent;
                const isExpanded = expandedImageId === image.id;

                return (
                  <div
                    key={image.id}
                    className={cn(
                      "relative group rounded-lg overflow-hidden border-2 transition-colors",
                      image.selected ? "border-primary" : "border-transparent",
                      isExpanded && "col-span-2 row-span-2"
                    )}
                  >
                    <img
                      src={image.preview}
                      alt={image.file.name}
                      className={cn(
                        "w-full object-cover cursor-pointer",
                        isExpanded ? "aspect-auto max-h-80" : "aspect-square"
                      )}
                      onClick={() => setExpandedImageId(isExpanded ? null : image.id)}
                    />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                    <div className="absolute top-2 left-2 z-10">
                      <Checkbox
                        checked={image.selected}
                        onCheckedChange={() => toggleSelection(image.id)}
                        className="bg-background"
                      />
                    </div>
                    
                    {/* OCR indicator badge */}
                    {hasOcr && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge 
                              variant="secondary" 
                              className="absolute top-2 left-9 gap-1 cursor-pointer"
                              onClick={() => setExpandedImageId(isExpanded ? null : image.id)}
                            >
                              <ScanEye className="h-3 w-3" />
                              OCR
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-sm">
                            <p className="text-xs whitespace-pre-wrap line-clamp-6">{vrContent}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}

                    <Button
                      variant="destructive"
                      size="icon"
                      className="absolute top-2 right-2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                      onClick={() => removeImage(image.id)}
                    >
                      <X className="h-3 w-3" />
                    </Button>

                    {/* Filename at bottom */}
                    <div className="absolute bottom-0 left-0 right-0 bg-black/60 p-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <p className="text-xs text-white truncate">{image.file.name}</p>
                    </div>

                    {/* Expanded OCR text panel */}
                    {isExpanded && hasOcr && (
                      <div className="absolute bottom-0 left-0 right-0 bg-background/95 border-t p-3 max-h-32 overflow-auto">
                        <p className="text-xs font-medium mb-1 flex items-center gap-1">
                          <ScanEye className="h-3 w-3" />
                          Extracted Text:
                        </p>
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                          {vrContent}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </>
      )}
    </div>
  );
}

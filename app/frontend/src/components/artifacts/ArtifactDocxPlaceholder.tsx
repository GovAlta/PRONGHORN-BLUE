import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FileText, X, AlertCircle } from "lucide-react";
import { CompactDropZone } from "./CompactDropZone";

interface ArtifactDocxPlaceholderProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
}

export function ArtifactDocxPlaceholder({ files, onFilesChange }: ArtifactDocxPlaceholderProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = () => {
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    setIsDragging(false);
    const droppedFiles = Array.from(e.dataTransfer.files).filter(f => 
      f.name.toLowerCase().endsWith(".docx") || f.name.toLowerCase().endsWith(".doc")
    );
    onFilesChange([...files, ...droppedFiles]);
  };

  const handleFileSelect = (selectedFiles: File[]) => {
    const docxFiles = selectedFiles.filter(f => 
      f.name.toLowerCase().endsWith(".docx") || f.name.toLowerCase().endsWith(".doc")
    );
    onFilesChange([...files, ...docxFiles]);
  };

  const removeFile = (index: number) => {
    onFilesChange(files.filter((_, i) => i !== index));
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <CompactDropZone
        icon={FileText}
        label="Drop Word documents here or click to browse"
        buttonText="Select"
        acceptText="DOCX, DOC files"
        accept=".docx,.doc"
        onFilesSelected={handleFileSelect}
        isDragging={isDragging}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      />

      <Alert className="shrink-0">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Word document processing coming soon. Files will be converted to artifacts in a future update.
        </AlertDescription>
      </Alert>

      {files.length > 0 && (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-2 p-1">
            {files.map((file, index) => (
              <div
                key={`${file.name}-${index}`}
                className="flex items-center gap-3 p-3 border rounded-lg bg-muted/30"
              >
                <FileText className="h-5 w-5 text-blue-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeFile(index)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

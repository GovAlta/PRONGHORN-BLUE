import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, ChevronDown, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CompactDropZone } from "./CompactDropZone";

export interface TextFile {
  id: string;
  file: File;
  content: string;
  selected: boolean;
  expanded: boolean;
}

interface ArtifactTextFileListProps {
  files: TextFile[];
  onFilesChange: (files: TextFile[]) => void;
}

const TEXT_EXTENSIONS = [".txt", ".md", ".json", ".xml", ".csv", ".yaml", ".yml", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".py", ".rb", ".java", ".c", ".cpp", ".h", ".sh", ".bash", ".sql", ".log", ".env", ".gitignore"];

export function ArtifactTextFileList({ files, onFilesChange }: ArtifactTextFileListProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = () => {
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    setIsDragging(false);
    const droppedFiles = Array.from(e.dataTransfer.files).filter(f => 
      TEXT_EXTENSIONS.some(ext => f.name.toLowerCase().endsWith(ext)) || 
      f.type.startsWith("text/")
    );
    await addFiles(droppedFiles);
  };

  const handleFileSelect = async (selectedFiles: File[]) => {
    const textFiles = selectedFiles.filter(f => 
      TEXT_EXTENSIONS.some(ext => f.name.toLowerCase().endsWith(ext)) || 
      f.type.startsWith("text/")
    );
    await addFiles(textFiles);
  };

  const addFiles = async (newFiles: File[]) => {
    const textFiles: TextFile[] = await Promise.all(
      newFiles.map(async file => ({
        id: `txt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        file,
        content: await file.text(),
        selected: true,
        expanded: false,
      }))
    );
    onFilesChange([...files, ...textFiles]);
  };

  const toggleSelection = (id: string) => {
    onFilesChange(
      files.map(f => 
        f.id === id ? { ...f, selected: !f.selected } : f
      )
    );
  };

  const toggleExpanded = (id: string) => {
    onFilesChange(
      files.map(f => 
        f.id === id ? { ...f, expanded: !f.expanded } : f
      )
    );
  };

  const removeFile = (id: string) => {
    onFilesChange(files.filter(f => f.id !== id));
  };

  const selectAll = () => {
    onFilesChange(files.map(f => ({ ...f, selected: true })));
  };

  const selectNone = () => {
    onFilesChange(files.map(f => ({ ...f, selected: false })));
  };

  const clearAll = () => {
    onFilesChange([]);
  };

  const selectedCount = files.filter(f => f.selected).length;
  const acceptExtensions = TEXT_EXTENSIONS.join(",");

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <CompactDropZone
        icon={FileText}
        label="Drop text files here or click to browse"
        buttonText="Select"
        acceptText="TXT, MD, JSON, CSV, XML, YAML, code files"
        accept={acceptExtensions}
        onFilesSelected={handleFileSelect}
        isDragging={isDragging}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      />

      {files.length > 0 && (
        <>
          <div className="flex items-center gap-2 shrink-0">
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
              {selectedCount} of {files.length} selected
            </span>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <div className="space-y-2 p-1">
              {files.map(file => (
                <div
                  key={file.id}
                  className={cn(
                    "border rounded-lg overflow-hidden transition-colors",
                    file.selected ? "border-primary" : "border-border"
                  )}
                >
                  <div className="flex items-center gap-2 p-2 bg-muted/50">
                    <Checkbox
                      checked={file.selected}
                      onCheckedChange={() => toggleSelection(file.id)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => toggleExpanded(file.id)}
                    >
                      {file.expanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-sm truncate">{file.file.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {(file.file.size / 1024).toFixed(1)} KB
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                      onClick={() => removeFile(file.id)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  {file.expanded && (
                    <pre className="p-3 text-xs bg-muted/30 max-h-48 overflow-auto font-mono whitespace-pre-wrap">
                      {file.content.slice(0, 5000)}
                      {file.content.length > 5000 && "..."}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </>
      )}
    </div>
  );
}

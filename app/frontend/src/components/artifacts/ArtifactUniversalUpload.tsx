import React, { useState } from "react";
import { Upload, Image, FileSpreadsheet, FileText, FileIcon, Presentation, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { CompactDropZone } from "./CompactDropZone";

interface FileCategory {
  type: string;
  label: string;
  icon: React.ElementType;
  count: number;
  color: string;
}

interface ArtifactUniversalUploadProps {
  onImagesAdded: (files: File[]) => void;
  onExcelAdded: (file: File) => void;
  onTextFilesAdded: (files: File[]) => void;
  onDocxFilesAdded: (files: File[]) => void;
  onPdfFilesAdded: (files: File[]) => void;
  onPptxFilesAdded: (files: File[]) => void;
  counts: {
    images: number;
    excel: number;
    textFiles: number;
    docx: number;
    pdf: number;
    pptx: number;
  };
}

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"];
const EXCEL_EXTENSIONS = [".xlsx", ".xls"];
const TEXT_EXTENSIONS = [".txt", ".md", ".json", ".xml", ".csv", ".yaml", ".yml", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".py", ".rb", ".java", ".c", ".cpp", ".h", ".sh", ".bash", ".sql", ".log", ".env", ".gitignore"];
const DOCX_EXTENSIONS = [".docx", ".doc"];
const PDF_EXTENSIONS = [".pdf"];
const PPTX_EXTENSIONS = [".pptx", ".ppt"];

const getFileExtension = (filename: string): string => {
  const idx = filename.lastIndexOf(".");
  return idx !== -1 ? filename.slice(idx).toLowerCase() : "";
};

const categorizeFile = (file: File): string | null => {
  const ext = getFileExtension(file.name);
  
  if (IMAGE_EXTENSIONS.includes(ext) || file.type.startsWith("image/")) return "image";
  if (EXCEL_EXTENSIONS.includes(ext)) return "excel";
  if (TEXT_EXTENSIONS.includes(ext) || file.type.startsWith("text/")) return "text";
  if (DOCX_EXTENSIONS.includes(ext)) return "docx";
  if (PDF_EXTENSIONS.includes(ext)) return "pdf";
  if (PPTX_EXTENSIONS.includes(ext)) return "pptx";
  
  return null;
};

export function ArtifactUniversalUpload({
  onImagesAdded,
  onExcelAdded,
  onTextFilesAdded,
  onDocxFilesAdded,
  onPdfFilesAdded,
  onPptxFilesAdded,
  counts,
}: ArtifactUniversalUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [recentUpload, setRecentUpload] = useState<{ images: number; excel: number; text: number; docx: number; pdf: number; pptx: number } | null>(null);

  const handleDragOver = () => {
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    processFiles(files);
  };

  const handleFileSelect = (files: File[]) => {
    processFiles(files);
  };

  const processFiles = (files: File[]) => {
    const images: File[] = [];
    const excel: File[] = [];
    const text: File[] = [];
    const docx: File[] = [];
    const pdf: File[] = [];
    const pptx: File[] = [];

    files.forEach(file => {
      const category = categorizeFile(file);
      switch (category) {
        case "image": images.push(file); break;
        case "excel": excel.push(file); break;
        case "text": text.push(file); break;
        case "docx": docx.push(file); break;
        case "pdf": pdf.push(file); break;
        case "pptx": pptx.push(file); break;
      }
    });

    if (images.length > 0) onImagesAdded(images);
    if (excel.length > 0) onExcelAdded(excel[0]);
    if (text.length > 0) onTextFilesAdded(text);
    if (docx.length > 0) onDocxFilesAdded(docx);
    if (pdf.length > 0) onPdfFilesAdded(pdf);
    if (pptx.length > 0) onPptxFilesAdded(pptx);

    const uploadSummary = {
      images: images.length,
      excel: excel.length,
      text: text.length,
      docx: docx.length,
      pdf: pdf.length,
      pptx: pptx.length,
    };
    
    if (Object.values(uploadSummary).some(v => v > 0)) {
      setRecentUpload(uploadSummary);
      setTimeout(() => setRecentUpload(null), 3000);
    }
  };

  const categories: FileCategory[] = [
    { type: "images", label: "Images", icon: Image, count: counts.images, color: "text-blue-500" },
    { type: "excel", label: "Excel", icon: FileSpreadsheet, count: counts.excel, color: "text-green-500" },
    { type: "textFiles", label: "Text Files", icon: FileText, count: counts.textFiles, color: "text-yellow-500" },
    { type: "docx", label: "Word", icon: FileText, count: counts.docx, color: "text-blue-600" },
    { type: "pdf", label: "PDF", icon: FileIcon, count: counts.pdf, color: "text-red-500" },
    { type: "pptx", label: "PowerPoint", icon: Presentation, count: counts.pptx, color: "text-orange-500" },
  ];

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <CompactDropZone
        icon={Upload}
        label="Drop any files here - they'll be sorted automatically"
        buttonText="Browse"
        acceptText="Images, Excel, Text, Word, PDF, PowerPoint"
        accept="*/*"
        onFilesSelected={handleFileSelect}
        isDragging={isDragging}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      />

      {recentUpload && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3 flex items-center gap-2 animate-in fade-in slide-in-from-top-2 shrink-0">
          <Check className="h-4 w-4 text-green-500 shrink-0" />
          <span className="text-sm text-green-700 dark:text-green-400">
            Added: {[
              recentUpload.images > 0 && `${recentUpload.images} image${recentUpload.images !== 1 ? "s" : ""}`,
              recentUpload.excel > 0 && `${recentUpload.excel} excel`,
              recentUpload.text > 0 && `${recentUpload.text} text`,
              recentUpload.docx > 0 && `${recentUpload.docx} word`,
              recentUpload.pdf > 0 && `${recentUpload.pdf} pdf`,
              recentUpload.pptx > 0 && `${recentUpload.pptx} pptx`,
            ].filter(Boolean).join(", ")}
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 shrink-0">
        {categories.map(cat => (
          <div
            key={cat.type}
            className={cn(
              "border rounded-lg p-4 flex flex-col items-center gap-2 transition-colors",
              cat.count > 0 ? "border-primary/50 bg-primary/5" : "border-border"
            )}
          >
            <cat.icon className={cn("h-8 w-8", cat.count > 0 ? cat.color : "text-muted-foreground")} />
            <span className="text-sm font-medium">{cat.label}</span>
            <span className={cn(
              "text-2xl font-bold",
              cat.count > 0 ? "text-foreground" : "text-muted-foreground"
            )}>
              {cat.count}
            </span>
          </div>
        ))}
      </div>

      <p className="text-sm text-muted-foreground text-center mt-auto shrink-0">
        Files are automatically sorted into their respective categories.
        <br />
        Switch to individual tabs to review and select specific items.
      </p>
    </div>
  );
}

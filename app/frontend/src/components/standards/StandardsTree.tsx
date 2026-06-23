import { useState } from "react";
import { ChevronRight, ChevronDown, ExternalLink, FileText, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface Standard {
  id: string;
  code: string;
  title: string;
  description?: string;
  content?: string;
  children?: Standard[];
  attachments?: StandardAttachment[];
}

export interface StandardAttachment {
  id: string;
  type: "file" | "url" | "sharepoint" | "website";
  name: string;
  url: string;
  description?: string;
}

interface StandardsTreeProps {
  standards: Standard[];
  onStandardSelect?: (standard: Standard) => void;
  onLinkStandard?: (standard: Standard) => void;
  showLinkButton?: boolean;
}

function StandardNode({
  standard,
  level = 0,
  onSelect,
  onLink,
  showLinkButton,
}: {
  standard: Standard;
  level?: number;
  onSelect?: (standard: Standard) => void;
  onLink?: (standard: Standard) => void;
  showLinkButton?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(level < 1);
  const hasChildren = standard.children && standard.children.length > 0;
  const hasAttachments = standard.attachments && standard.attachments.length > 0;

  return (
    <div className="select-none">
      <div
        className="group py-2 px-1 md:px-2 rounded-md hover:bg-muted/50 transition-colors"
        style={{ paddingLeft: `${level * 10 + 4}px` }}
      >
        {/* Mobile Layout */}
        <div className="md:hidden">
          <div className="flex items-start gap-1">
            {hasChildren ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 p-0 flex-shrink-0 mt-0.5"
                onClick={() => setIsExpanded(!isExpanded)}
              >
                {isExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </Button>
            ) : (
              <div className="h-5 w-5 flex-shrink-0" />
            )}
            
            <div className="flex-1 min-w-0">
              {/* Code badge on its own line */}
              <Badge variant="outline" className="font-mono text-[10px] mb-1">
                {standard.code}
              </Badge>
              
              {/* Title */}
              <div
                className="text-xs font-medium cursor-pointer"
                onClick={() => onSelect?.(standard)}
              >
                {standard.title}
              </div>
              
              {/* Description full width */}
              {standard.description && (
                <p className="text-[10px] text-muted-foreground mt-1 line-clamp-3">
                  {standard.description}
                </p>
              )}
              
              {/* Actions on their own row */}
              <div className="flex items-center gap-1 mt-2">
                {hasAttachments && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-6 w-6">
                          <FileText className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <div className="space-y-1">
                          {standard.attachments!.map((att) => (
                            <div key={att.id} className="text-xs">
                              <a
                                href={att.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:underline flex items-center gap-1"
                              >
                                <ExternalLink className="h-2 w-2" />
                                {att.name}
                              </a>
                            </div>
                          ))}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                
                {showLinkButton && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => onLink?.(standard)}
                  >
                    <LinkIcon className="h-3 w-3 mr-1" />
                    Link
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Desktop Layout */}
        <div className="hidden md:flex items-center gap-2">
          {hasChildren ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 p-0 flex-shrink-0"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </Button>
          ) : (
            <div className="h-5 w-5 flex-shrink-0" />
          )}

          <div className="flex-1 min-w-0 overflow-hidden">
            <div
              className="flex items-center gap-2 cursor-pointer"
              onClick={() => onSelect?.(standard)}
            >
              <Badge variant="outline" className="font-mono text-xs flex-shrink-0">
                {standard.code}
              </Badge>
              <span className="text-sm font-medium truncate">{standard.title}</span>
            </div>
            {standard.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {standard.description}
              </p>
            )}
          </div>

          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
            {hasAttachments && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-6 w-6">
                      <FileText className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="space-y-1">
                      {standard.attachments!.map((att) => (
                        <div key={att.id} className="text-xs">
                          <a
                            href={att.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline flex items-center gap-1"
                          >
                            <ExternalLink className="h-2 w-2" />
                            {att.name}
                          </a>
                        </div>
                      ))}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            
            {showLinkButton && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => onLink?.(standard)}
              >
                <LinkIcon className="h-3 w-3 mr-1" />
                Link
              </Button>
            )}
          </div>
        </div>
      </div>

      {isExpanded && hasChildren && (
        <div>
          {standard.children!.map((child) => (
            <StandardNode
              key={child.id}
              standard={child}
              level={level + 1}
              onSelect={onSelect}
              onLink={onLink}
              showLinkButton={showLinkButton}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function StandardsTree({
  standards,
  onStandardSelect,
  onLinkStandard,
  showLinkButton = false,
}: StandardsTreeProps) {
  return (
    <div className="space-y-1">
      {standards.map((standard) => (
        <StandardNode
          key={standard.id}
          standard={standard}
          onSelect={onStandardSelect}
          onLink={onLinkStandard}
          showLinkButton={showLinkButton}
        />
      ))}
    </div>
  );
}

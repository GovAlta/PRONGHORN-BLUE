import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { TechStackTreeManager } from "./TechStackTreeManager";
import { DocsViewer } from "@/components/docs/DocsViewer";
import { Edit, Trash2, Check, X, BookOpen } from "lucide-react";
import { useAdmin } from "@/contexts/AdminContext";
import { pronghornApi } from "@/integrations/pronghorn-api/client";

interface TechStackCardProps {
  techStack: any;
  onDelete: (techStackId: string) => void;
  onUpdate: (techStackId: string, name: string, description: string, longDescription?: string) => void;
  onRefresh: () => void;
}

export function TechStackCard({ techStack, onDelete, onUpdate, onRefresh }: TechStackCardProps) {
  const { isAdmin } = useAdmin();
  const [isEditing, setIsEditing] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [isExpanded, setIsExpanded] = useState<string | undefined>(undefined);
  const [name, setName] = useState(techStack.name);
  const [description, setDescription] = useState(techStack.description || "");
  const [longDescription, setLongDescription] = useState(techStack.long_description || "");
  const [childCount, setChildCount] = useState(0);

  useEffect(() => {
    const countChildren = async () => {
      const { count } = await pronghornApi
        .from("tech_stacks")
        .select("*", { count: "exact", head: true })
        .eq("parent_id", techStack.id);
      setChildCount(count || 0);
    };
    countChildren();
  }, [techStack.id]);

  const handleSave = () => {
    onUpdate(techStack.id, name, description, longDescription);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setName(techStack.name);
    setDescription(techStack.description || "");
    setLongDescription(techStack.long_description || "");
    setIsEditing(false);
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="p-3 md:p-4">
        {isEditing ? (
          <div className="space-y-2">
            <div>
              <Label className="text-xs">Tech Stack Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Tech stack name"
                className="text-base font-semibold h-8"
              />
            </div>
            <div>
              <Label className="text-xs">Short Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description"
                rows={2}
                className="text-sm"
              />
            </div>
            <div>
              <Label className="text-xs">Long Description</Label>
              <Textarea
                value={longDescription}
                onChange={(e) => setLongDescription(e.target.value)}
                placeholder="Full documentation..."
                rows={4}
                className="text-sm font-mono"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} className="h-7">
                <Check className="h-3 w-3 mr-1" />
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={handleCancel} className="h-7">
                <X className="h-3 w-3 mr-1" />
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base md:text-lg truncate">{techStack.name}</CardTitle>
              <div className="flex gap-1 flex-shrink-0">
                <Button size="sm" variant="outline" onClick={() => setShowDocs(true)} className="h-7 gap-1 px-2">
                  <BookOpen className="h-3 w-3" />
                  <span className="hidden md:inline text-xs">Docs</span>
                </Button>
                {isAdmin && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setIsEditing(true)} className="h-7 w-7 p-0">
                      <Edit className="h-3 w-3" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onDelete(techStack.id)} className="h-7 w-7 p-0">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </>
                )}
              </div>
            </div>
            {techStack.description && <CardDescription className="text-xs mt-1">{techStack.description}</CardDescription>}
          </>
        )}
      </CardHeader>

      <Accordion 
        type="single" 
        collapsible 
        className="px-3 md:px-4 pb-3 md:pb-4"
        value={isExpanded}
        onValueChange={setIsExpanded}
      >
        <AccordionItem value="items" className="border rounded-md bg-muted/30">
          <AccordionTrigger className="px-3 py-2 text-sm hover:no-underline hover:bg-muted/50 rounded-md [&[data-state=open]>div>.expand-text]:hidden [&[data-state=closed]>div>.collapse-text]:hidden">
            <div className="flex items-center gap-2 w-full">
              <span className="font-medium">{childCount} item{childCount !== 1 ? "s" : ""}</span>
              <span className="hidden md:inline text-xs text-muted-foreground expand-text">— Click to expand</span>
              <span className="hidden md:inline text-xs text-muted-foreground collapse-text">— Click to collapse</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-3 pt-2 pb-3">
            <TechStackTreeManager
              techStackId={techStack.id}
              onRefresh={onRefresh}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <DocsViewer
        open={showDocs}
        onClose={() => setShowDocs(false)}
        entityType="tech_stack"
        rootEntity={{
          id: techStack.id,
          name: techStack.name,
          description: techStack.description,
          long_description: techStack.long_description,
        }}
      />
    </Card>
  );
}

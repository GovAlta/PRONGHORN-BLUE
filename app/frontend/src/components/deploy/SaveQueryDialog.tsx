import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Save } from "lucide-react";

interface SavedQuery {
  id: string;
  name: string;
  description?: string;
  sql_content: string;
}

interface SaveQueryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, description: string, sqlContent: string) => Promise<void>;
  sqlContent: string;
  editingQuery?: SavedQuery | null;
}

export function SaveQueryDialog({
  open,
  onOpenChange,
  onSave,
  sqlContent,
  editingQuery,
}: SaveQueryDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      if (editingQuery) {
        setName(editingQuery.name);
        setDescription(editingQuery.description || "");
      } else {
        setName("");
        setDescription("");
      }
    }
  }, [open, editingQuery]);

  const handleSave = async () => {
    if (!name.trim()) return;
    
    setIsSaving(true);
    try {
      await onSave(name.trim(), description.trim(), editingQuery?.sql_content || sqlContent);
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editingQuery ? "Edit Saved Query" : "Save Query"}
          </DialogTitle>
          <DialogDescription>
            {editingQuery 
              ? "Update the name and description of your saved query."
              : "Save this query for quick access later."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              placeholder="e.g., Get all users"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Optional description of what this query does..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          {!editingQuery && (
            <div className="space-y-2">
              <Label>SQL Preview</Label>
              <div className="bg-muted rounded-md p-3 max-h-32 overflow-auto">
                <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                  {sqlContent.slice(0, 500)}
                  {sqlContent.length > 500 && "..."}
                </pre>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim() || isSaving}
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            {editingQuery ? "Update" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

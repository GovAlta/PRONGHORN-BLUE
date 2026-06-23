import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface AgentPromptEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentLabel: string;
  systemPrompt: string;
  userPrompt?: string;
  onSave: (systemPrompt: string, userPrompt: string) => void;
}

export function AgentPromptEditDialog({
  open,
  onOpenChange,
  agentLabel,
  systemPrompt,
  userPrompt = "",
  onSave,
}: AgentPromptEditDialogProps) {
  const [editedSystemPrompt, setEditedSystemPrompt] = useState(systemPrompt);
  const [editedUserPrompt, setEditedUserPrompt] = useState(userPrompt);

  const handleSave = () => {
    onSave(editedSystemPrompt, editedUserPrompt);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Agent Prompts - {agentLabel}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="system-prompt">System Prompt</Label>
            <Textarea
              id="system-prompt"
              value={editedSystemPrompt}
              onChange={(e) => setEditedSystemPrompt(e.target.value)}
              className="min-h-[200px] font-mono text-xs"
              placeholder="System instructions for this agent..."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="user-prompt">Additional User Instructions (Optional)</Label>
            <Textarea
              id="user-prompt"
              value={editedUserPrompt}
              onChange={(e) => setEditedUserPrompt(e.target.value)}
              className="min-h-[150px] font-mono text-xs"
              placeholder="Additional instructions or constraints for this specific execution..."
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save Changes</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

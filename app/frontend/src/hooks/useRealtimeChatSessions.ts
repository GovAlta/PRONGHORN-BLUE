import { useEffect, useState, useRef } from "react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { toast } from "sonner";

export interface ChatSession {
  id: string;
  project_id: string;
  title: string | null;
  ai_title: string | null;
  ai_summary: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface ChatMessage {
  id: string;
  chat_session_id: string;
  role: string;
  content: string;
  created_at: string;
  created_by: string | null;
}

export const useRealtimeChatSessions = (
  projectId: string | undefined,
  shareToken: string | null,
  enabled: boolean = true
) => {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof pronghornApi.channel> | null>(null);

  const loadSessions = async () => {
    if (!projectId || !enabled) return;

    try {
      const { data, error } = await pronghornApi.rpc("get_chat_sessions_with_token", {
        p_project_id: projectId,
        p_token: shareToken || null,
      });

      if (error) throw error;
      setSessions(data || []);
    } catch (error) {
      console.error("Error loading chat sessions:", error);
      toast.error("Failed to load chat sessions");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();

    if (!projectId || !enabled) return;

    const channel = pronghornApi
      .channel(`chat-sessions-${projectId}`)
      .on("broadcast", { event: "chat_session_refresh" }, () => {
        loadSessions();
      })
      .subscribe();

    channelRef.current = channel;

    return () => {
      pronghornApi.removeChannel(channel);
      channelRef.current = null;
    };
  }, [projectId, enabled]);

  const createSession = async (title: string = "New Chat") => {
    if (!projectId) return;

    try {
      const { data, error } = await pronghornApi.rpc("insert_chat_session_with_token", {
        p_project_id: projectId,
        p_token: shareToken || null,
        p_title: title,
      });

      if (error) throw error;
      if (data) {
        setSessions((prev) => [data, ...prev]);
      }
      
      // Broadcast using the subscribed channel reference (like Canvas does)
      if (channelRef.current && typeof channelRef.current.send === "function") {
        channelRef.current.send({
          type: "broadcast",
          event: "chat_session_refresh",
          payload: {}
        });
      }
      
      toast.success("Chat session created");
      return data;
    } catch (error) {
      console.error("Error creating chat session:", error);
      toast.error("Failed to create chat session");
      throw error;
    }
  };

  const updateSession = async (
    id: string,
    title?: string,
    aiTitle?: string,
    aiSummary?: string
  ) => {
    // Optimistic update
    const originalSessions = sessions;
    setSessions((prev) =>
      prev.map((session) =>
        session.id === id
          ? {
              ...session,
              ...(title !== undefined && { title }),
              ...(aiTitle !== undefined && { ai_title: aiTitle }),
              ...(aiSummary !== undefined && { ai_summary: aiSummary }),
            }
          : session
      )
    );

    try {
      const { data, error } = await pronghornApi.rpc("update_chat_session_with_token", {
        p_id: id,
        p_token: shareToken || null,
        p_title: title || null,
        p_ai_title: aiTitle || null,
        p_ai_summary: aiSummary || null,
      });

      if (error) throw error;
      
      // Broadcast using the subscribed channel reference (like Canvas does)
      if (channelRef.current && typeof channelRef.current.send === "function") {
        channelRef.current.send({
          type: "broadcast",
          event: "chat_session_refresh",
          payload: {}
        });
      }
      
      toast.success("Chat session updated");
      return data;
    } catch (error) {
      console.error("Error updating chat session:", error);
      toast.error("Failed to update chat session");
      // Rollback on error
      setSessions(originalSessions);
      throw error;
    }
  };

  const deleteSession = async (id: string) => {
    // Optimistic update
    const originalSessions = sessions;
    setSessions((prev) => prev.filter((session) => session.id !== id));

    try {
      const { error } = await pronghornApi.rpc("delete_chat_session_with_token", {
        p_id: id,
        p_token: shareToken || null,
      });

      if (error) throw error;
      
      // Broadcast using the subscribed channel reference (like Canvas does)
      if (channelRef.current && typeof channelRef.current.send === "function") {
        channelRef.current.send({
          type: "broadcast",
          event: "chat_session_refresh",
          payload: {}
        });
      }
      
      toast.success("Chat session deleted");
    } catch (error) {
      console.error("Error deleting chat session:", error);
      toast.error("Failed to delete chat session");
      // Rollback on error
      setSessions(originalSessions);
      throw error;
    }
  };

  const cloneSession = async (id: string) => {
    if (!projectId) return null;

    try {
      const { data, error } = await pronghornApi.rpc("clone_chat_session_with_token", {
        p_id: id,
        p_token: shareToken || null,
      });

      if (error) throw error;
      
      if (data) {
        setSessions((prev) => [data, ...prev]);
      }
      
      // Broadcast using the subscribed channel reference
      if (channelRef.current && typeof channelRef.current.send === "function") {
        channelRef.current.send({
          type: "broadcast",
          event: "chat_session_refresh",
          payload: {}
        });
      }
      
      toast.success("Chat session cloned");
      return data;
    } catch (error) {
      console.error("Error cloning chat session:", error);
      toast.error("Failed to clone chat session");
      return null;
    }
  };

  return {
    sessions,
    isLoading,
    createSession,
    updateSession,
    deleteSession,
    cloneSession,
    refresh: loadSessions,
  };
};

export const useRealtimeChatMessages = (
  chatSessionId: string | undefined,
  shareToken: string | null,
  enabled: boolean = true,
  projectId?: string // Optional projectId for broadcasting session-level refresh
) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof pronghornApi.channel> | null>(null);
  const sessionChannelRef = useRef<ReturnType<typeof pronghornApi.channel> | null>(null);
  // Track recently saved message IDs to skip redundant realtime reloads
  const recentlySavedIdsRef = useRef<Set<string>>(new Set());

  const loadMessages = async () => {
    if (!chatSessionId || !enabled) return;

    try {
      const { data, error } = await pronghornApi.rpc("get_chat_messages_with_token", {
        p_chat_session_id: chatSessionId,
        p_token: shareToken || null,
      });

      if (error) throw error;
      
      // Preserve temporary messages (streaming) that haven't been saved yet
      // This prevents realtime DB updates from wiping the streaming assistant message
      setMessages((prev) => {
        const tempMessages = prev.filter((m) => m.id.startsWith("temp-"));
        const dbMessages = data || [];
        
        // If no temp messages, just use DB data
        if (tempMessages.length === 0) {
          return dbMessages;
        }
        
        // Merge: DB messages first, then any temp messages not yet in DB
        const dbMessageIds = new Set(dbMessages.map((m: ChatMessage) => m.id));
        const newTempMessages = tempMessages.filter((m) => !dbMessageIds.has(m.id));
        
        return [...dbMessages, ...newTempMessages];
      });
    } catch (error) {
      console.error("Error loading messages:", error);
      toast.error("Failed to load messages");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadMessages();

    if (!chatSessionId || !enabled) return;

    const channel = pronghornApi
      .channel(`chat-messages-${chatSessionId}`)
      .on("broadcast", { event: "chat_message_refresh" }, () => {
        loadMessages();
      })
      .subscribe();

    channelRef.current = channel;

    // Also subscribe to project-level channel for local runner sync
    let projectChannel: ReturnType<typeof pronghornApi.channel> | null = null;
    if (projectId) {
      projectChannel = pronghornApi
        .channel(`chat-messages-${projectId}`)
        .on("broadcast", { event: "chat_message_refresh" }, () => {
          loadMessages();
        })
        .subscribe();
      sessionChannelRef.current = projectChannel;
    }

    return () => {
      pronghornApi.removeChannel(channel);
      channelRef.current = null;
      if (projectChannel) {
        pronghornApi.removeChannel(projectChannel);
        sessionChannelRef.current = null;
      }
    };
  }, [chatSessionId, enabled, projectId]);

  const addMessage = async (role: string, content: string) => {
    if (!chatSessionId) return;

    // Optimistically add message to current session
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimisticMessage: ChatMessage = {
      id: tempId,
      chat_session_id: chatSessionId,
      role,
      content,
      created_at: new Date().toISOString(),
      created_by: null,
    };

    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      const { data, error } = await pronghornApi.rpc("insert_chat_message_with_token", {
        p_chat_session_id: chatSessionId,
        p_token: shareToken || null,
        p_role: role,
        p_content: content,
      });

      if (error) throw error;

      // Replace temp message with real one from DB
      if (data) {
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId ? data : m))
        );
      }

      // Broadcast using the subscribed channel reference (like Canvas does)
      if (channelRef.current && typeof channelRef.current.send === "function") {
        channelRef.current.send({
          type: "broadcast",
          event: "chat_message_refresh",
          payload: {}
        });
      }

      // Also broadcast to project-level channel for local runner sync
      if (projectId && sessionChannelRef.current) {
        sessionChannelRef.current.send({
          type: "broadcast",
          event: "chat_message_refresh",
          payload: { action: "message_added", sessionId: chatSessionId }
        });
      }

      return data;
    } catch (error) {
      console.error("Error adding message:", error);
      toast.error("Failed to send message");
      // Roll back optimistic message on error
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      throw error;
    }
  };

  const addTemporaryMessage = (role: string, content: string): string => {
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempMessage: ChatMessage = {
      id: tempId,
      chat_session_id: chatSessionId!,
      role,
      content,
      created_at: new Date().toISOString(),
      created_by: null,
    };
    setMessages((prev) => [...prev, tempMessage]);
    return tempId;
  };

  const updateStreamingMessage = (tempId: string, content: string, realId?: string) => {
    setMessages((prev) =>
      prev.map((m) => 
        m.id === tempId 
          ? { ...m, content, ...(realId && { id: realId }) }
          : m
      )
    );
  };

  // Save assistant message (for AI responses after streaming completes)
  // This does the RPC call AND broadcasts - unlike direct RPC calls
  const saveAssistantMessage = async (content: string): Promise<ChatMessage | null> => {
    if (!chatSessionId) return null;

    try {
      const { data, error } = await pronghornApi.rpc("insert_chat_message_with_token", {
        p_chat_session_id: chatSessionId,
        p_token: shareToken || null,
        p_role: "assistant",
        p_content: content,
      });

      if (error) throw error;

      // Track this ID so realtime doesn't reload for it (prevents flicker)
      if (data?.id) {
        recentlySavedIdsRef.current.add(data.id);
        // Clear after a short delay to allow future updates
        setTimeout(() => {
          recentlySavedIdsRef.current.delete(data.id);
        }, 2000);
      }

      // Broadcast using the subscribed channel reference (like Canvas does)
      if (channelRef.current && typeof channelRef.current.send === "function") {
        channelRef.current.send({
          type: "broadcast",
          event: "chat_message_refresh",
          payload: {}
        });
      }

      // Also broadcast to project-level channel for local runner sync
      if (projectId && sessionChannelRef.current) {
        sessionChannelRef.current.send({
          type: "broadcast",
          event: "chat_message_refresh",
          payload: { action: "assistant_message_saved", sessionId: chatSessionId }
        });
      }

      return data;
    } catch (error) {
      console.error("Error saving assistant message:", error);
      throw error;
    }
  };

  const deleteMessage = async (id: string) => {
    if (!chatSessionId) return;

    // Optimistic update
    const originalMessages = messages;
    setMessages((prev) => prev.filter((m) => m.id !== id));

    try {
      const { error } = await pronghornApi.rpc("delete_chat_message_with_token", {
        p_id: id,
        p_token: shareToken || null,
      });

      if (error) throw error;
      
      // Broadcast using the subscribed channel reference
      if (channelRef.current && typeof channelRef.current.send === "function") {
        channelRef.current.send({
          type: "broadcast",
          event: "chat_message_refresh",
          payload: {}
        });
      }
      
      toast.success("Message deleted");
    } catch (error) {
      console.error("Error deleting message:", error);
      toast.error("Failed to delete message");
      // Rollback on error
      setMessages(originalMessages);
    }
  };

  return {
    messages,
    isLoading,
    addMessage,
    addTemporaryMessage,
    updateStreamingMessage,
    saveAssistantMessage,
    deleteMessage,
    refresh: loadMessages,
    channelRef,
  };
};


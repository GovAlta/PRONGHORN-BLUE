/**
 * Chat/AI Routes
 * Handles AI streaming via Azure AI Foundry through APIM
 */
import { Router, Request, Response } from "express";
import { Errors } from "../middleware/errorHandler";
import { logger } from "../utils/logger";
import db from "../utils/database";
import { getModelConfig, buildEndpointUrl } from "../config/aiModels";
import { getAzureTokenForScope, AzureScope } from "../utils/azureCredential";
import { resolveAttachedContext } from "../utils/resolveAttachedContext";

const router = Router();

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Get Azure AD token for Foundry authentication
 */
async function getAzureToken(): Promise<string> {
  return getAzureTokenForScope(AzureScope.CognitiveServices);
}

/**
 * POST /api/chat/stream/foundry
 * Stream chat responses from Azure AI Foundry (OpenAI models)
 */
router.post("/stream/foundry", async (req: Request, res: Response) => {
  try {
    const {
      systemPrompt,
      userPrompt,
      messages = [],
      model = "gpt-4o",
      maxOutputTokens = 4096,
      attachedContext = null,
      projectId = null,
      shareToken = null,
    } = req.body;

    logger.info("Azure Foundry chat stream request", { model, projectId });

    // Validate project access if projectId provided
    if (projectId) {
      const { rows } = await db.query(
        "SELECT id FROM projects WHERE id = $1 AND (user_id = $2 OR id IN (SELECT project_id FROM project_shares WHERE token = $3))",
        [projectId, req.user?.id, shareToken]
      );
      if (rows.length === 0) {
        throw Errors.forbidden("Access denied to project");
      }
    }

    // Get model config
    const modelConfig = getModelConfig(model);
    if (!modelConfig || modelConfig.provider !== "azure-foundry") {
      throw Errors.badRequest(`Model ${model} is not an Azure Foundry model`);
    }

    // Build endpoint URL
    const endpoint = buildEndpointUrl(model);

    // Get authentication token
    const token = await getAzureToken();

    // Set up SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Enrich artifact content from blob storage
    const resolvedContext = attachedContext
      ? await resolveAttachedContext(attachedContext, projectId)
      : null;

    // Build enriched system prompt with context
    let enrichedSystemPrompt = systemPrompt || "You are a helpful AI assistant.";
    if (resolvedContext) {
      const contextParts: string[] = [];
      if (resolvedContext.projectMetadata) contextParts.push("PROJECT METADATA: included");
      if (resolvedContext.artifacts?.length) contextParts.push(`ARTIFACTS: ${resolvedContext.artifacts.length}`);
      if (resolvedContext.requirements?.length) contextParts.push(`REQUIREMENTS: ${resolvedContext.requirements.length}`);

      if (contextParts.length > 0) {
        const jsonString = JSON.stringify(resolvedContext, null, 2);
        enrichedSystemPrompt = `${enrichedSystemPrompt}\n\n===== ATTACHED CONTEXT =====\n${contextParts.join("\n")}\n\n${jsonString}`;
      }
    }

    // Build messages array
    const chatMessages = [
      { role: "system", content: enrichedSystemPrompt },
      ...(messages.length > 0
        ? messages.map((m: ChatMessage) => ({ role: m.role, content: m.content }))
        : [{ role: "user", content: userPrompt }])
    ];

    // Stream from Azure OpenAI
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: chatMessages,
        max_tokens: maxOutputTokens,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("Azure Foundry API error", { status: response.status, error: errorText });
      throw Errors.internal(`Azure Foundry API error: ${response.status} ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw Errors.internal("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;

        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") {
            if (jsonStr === "[DONE]") {
              res.write(`data: ${JSON.stringify({ type: "done", finishReason: "STOP" })}\n\n`);
            }
            continue;
          }

          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              res.write(`data: ${JSON.stringify({ type: "delta", text: delta.content })}\n\n`);
            }
            if (parsed.choices?.[0]?.finish_reason) {
              res.write(`data: ${JSON.stringify({ type: "done", finishReason: parsed.choices[0].finish_reason })}\n\n`);
            }
          } catch {
            // Skip parse errors
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    res.end();
  } catch (error) {
    logger.error("Foundry stream error", error);
    if (!res.headersSent) {
      const statusCode = error instanceof Error && "statusCode" in error ? (error as any).statusCode : 500;
      res.status(statusCode).json({ error: error instanceof Error ? error.message : "Unknown error" });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "Unknown error" })}\n\n`);
      res.end();
    }
  }
});

/**
 * POST /api/chat/summarize
 * Summarize chat session using Azure AI Foundry
 */
router.post("/summarize", async (req: Request, res: Response) => {
  try {
    const { sessionId, messages } = req.body;

    if (!sessionId || !messages) {
      throw Errors.badRequest("sessionId and messages are required");
    }

    // Use Azure AI Foundry via APIM
    const endpoint = buildEndpointUrl("gpt-4o-mini");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{
          role: "user",
          content: `Summarize this chat conversation in 2-3 sentences:\n\n${JSON.stringify(messages)}`,
        }],
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      throw Errors.internal("Failed to generate summary");
    }

    const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const summary = result.choices?.[0]?.message?.content || "Chat session";

    // Update session with summary
    await db.query(
      "UPDATE chat_sessions SET summary = $1 WHERE id = $2",
      [summary, sessionId]
    );

    res.json({ summary });
  } catch (error) {
    throw error;
  }
});

export default router;

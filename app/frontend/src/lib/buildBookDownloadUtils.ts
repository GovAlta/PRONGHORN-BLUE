import { pronghornApi } from "@/integrations/pronghorn-api/client";

const DISCLAIMER = "DISCLAIMER: This information is provided for Reference Purposes Only by the Government of Alberta to support in the development of technologies. The Government of Alberta bears no liability for its use or misuse, and this publication does not constitute an endorsement of the vendors, organizations, or technologies represented herein.";

export interface ResourceInfo {
  name: string;
  url: string;
  resource_type: string;
  description: string | null;
}

export interface StandardInfo {
  id: string;
  code: string;
  title: string;
  description: string | null;
  long_description: string | null;
  content: string | null;
  category: string | null;
  resources: ResourceInfo[];
}

export interface TechStackInfo {
  id: string;
  name: string;
  type: string | null;
  version: string | null;
  version_constraint: string | null;
  description: string | null;
  long_description: string | null;
  resources: ResourceInfo[];
}

export interface BuildBookFullData {
  buildBook: {
    id: string;
    name: string;
    short_description: string | null;
    long_description: string | null;
    tags: string[] | null;
  };
  standards: StandardInfo[];
  techStacks: TechStackInfo[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

function buildMetadataHeader(buildBookName: string, format: "markdown"): string;
function buildMetadataHeader(buildBookName: string, format: "json"): object;
function buildMetadataHeader(buildBookName: string, format: "markdown" | "json"): string | object {
  const now = new Date().toISOString();
  
  if (format === "markdown") {
    return `---
source: Pronghorn.RED Build Book - ${buildBookName}
downloaded: ${now}
---

> **DISCLAIMER**: ${DISCLAIMER}

---

`;
  }
  
  return {
    source: `Pronghorn.RED Build Book - ${buildBookName}`,
    downloaded: now,
    disclaimer: DISCLAIMER
  };
}

function buildChatMetadataHeader(buildBookName: string): string {
  const now = new Date().toISOString();
  return `---
source: Pronghorn.RED Build Book Chat - ${buildBookName}
downloaded: ${now}
---

> **DISCLAIMER**: ${DISCLAIMER}

---

`;
}

export async function fetchBuildBookFullData(
  buildBookId: string,
  standardIds: string[],
  techStackIds: string[]
): Promise<{ standards: StandardInfo[]; techStacks: TechStackInfo[] }> {
  const standards: StandardInfo[] = [];
  const techStacks: TechStackInfo[] = [];

  // Fetch standards with full data
  if (standardIds.length > 0) {
    const { data: standardsData } = await pronghornApi
      .from("standards")
      .select("id, code, title, description, long_description, content, category:standard_categories(name)")
      .in("id", standardIds);

    if (standardsData) {
      // Fetch resources for all standards
      const { data: standardResources } = await pronghornApi
        .from("standard_resources")
        .select("standard_id, resource_type, name, url, description")
        .in("standard_id", standardIds);

      for (const s of standardsData) {
        const resources = (standardResources || [])
          .filter(r => r.standard_id === s.id)
          .map(r => ({
            name: r.name,
            url: r.url,
            resource_type: r.resource_type,
            description: r.description,
          }));

        standards.push({
          id: s.id,
          code: s.code,
          title: s.title,
          description: s.description,
          long_description: s.long_description,
          content: s.content,
          category: (s.category as any)?.name || null,
          resources,
        });
      }
    }
  }

  // Fetch tech stacks with full data
  if (techStackIds.length > 0) {
    const { data: techStacksData } = await pronghornApi
      .from("tech_stacks")
      .select("id, name, type, version, version_constraint, description, long_description")
      .in("id", techStackIds);

    if (techStacksData) {
      // Fetch resources for all tech stacks
      const { data: techStackResources } = await pronghornApi
        .from("tech_stack_resources")
        .select("tech_stack_id, resource_type, name, url, description")
        .in("tech_stack_id", techStackIds);

      for (const t of techStacksData) {
        const resources = (techStackResources || [])
          .filter(r => r.tech_stack_id === t.id)
          .map(r => ({
            name: r.name,
            url: r.url,
            resource_type: r.resource_type,
            description: r.description,
          }));

        techStacks.push({
          id: t.id,
          name: t.name,
          type: t.type,
          version: t.version,
          version_constraint: t.version_constraint,
          description: t.description,
          long_description: t.long_description,
          resources,
        });
      }
    }
  }

  return { standards, techStacks };
}

export function buildBuildBookMarkdown(
  buildBook: BuildBookFullData["buildBook"],
  standards: StandardInfo[],
  techStacks: TechStackInfo[]
): string {
  let markdown = buildMetadataHeader(buildBook.name, "markdown");

  // Build Book Header
  markdown += `# ${buildBook.name}\n\n`;
  
  if (buildBook.short_description) {
    markdown += `${buildBook.short_description}\n\n`;
  }

  if (buildBook.long_description) {
    markdown += `## Overview\n\n${buildBook.long_description}\n\n`;
  }

  if (buildBook.tags && buildBook.tags.length > 0) {
    markdown += `**Tags:** ${buildBook.tags.join(", ")}\n\n`;
  }

  markdown += "---\n\n";

  // Standards Section
  if (standards.length > 0) {
    markdown += "## Standards\n\n";

    // Group by category
    const categorized = new Map<string, StandardInfo[]>();
    for (const s of standards) {
      const cat = s.category || "Uncategorized";
      if (!categorized.has(cat)) categorized.set(cat, []);
      categorized.get(cat)!.push(s);
    }

    for (const [category, catStandards] of categorized) {
      markdown += `### Category: ${category}\n\n`;

      for (const s of catStandards) {
        markdown += `#### [${s.code}] ${s.title}\n\n`;
        
        if (s.description) {
          markdown += `${s.description}\n\n`;
        }

        if (s.content) {
          markdown += `**Requirements:**\n\n${s.content}\n\n`;
        }

        if (s.long_description) {
          markdown += `**Detailed Documentation:**\n\n${s.long_description}\n\n`;
        }

        if (s.resources.length > 0) {
          markdown += "**Resources:**\n\n";
          for (const r of s.resources) {
            markdown += `- [${r.resource_type.toUpperCase()}] ${r.name}: ${r.url}`;
            if (r.description) markdown += ` - ${r.description}`;
            markdown += "\n";
          }
          markdown += "\n";
        }
      }
    }
  }

  // Tech Stacks Section
  if (techStacks.length > 0) {
    markdown += "---\n\n## Technology Stack\n\n";

    for (const t of techStacks) {
      markdown += `### ${t.name}`;
      if (t.type) markdown += ` (${t.type})`;
      markdown += "\n\n";

      if (t.version) {
        markdown += `**Version:** ${t.version_constraint || ""}${t.version}\n\n`;
      }

      if (t.description) {
        markdown += `${t.description}\n\n`;
      }

      if (t.long_description) {
        markdown += `**Details:**\n\n${t.long_description}\n\n`;
      }

      if (t.resources.length > 0) {
        markdown += "**Resources:**\n\n";
        for (const r of t.resources) {
          markdown += `- [${r.resource_type.toUpperCase()}] ${r.name}: ${r.url}`;
          if (r.description) markdown += ` - ${r.description}`;
          markdown += "\n";
        }
        markdown += "\n";
      }
    }
  }

  return markdown;
}

export function buildBuildBookJSON(
  buildBook: BuildBookFullData["buildBook"],
  standards: StandardInfo[],
  techStacks: TechStackInfo[]
): object {
  return {
    metadata: buildMetadataHeader(buildBook.name, "json"),
    buildBook: {
      name: buildBook.name,
      shortDescription: buildBook.short_description,
      longDescription: buildBook.long_description,
      tags: buildBook.tags,
    },
    standards: standards.map(s => ({
      code: s.code,
      title: s.title,
      description: s.description,
      longDescription: s.long_description,
      content: s.content,
      category: s.category,
      resources: s.resources.map(r => ({
        type: r.resource_type,
        name: r.name,
        url: r.url,
        description: r.description,
      })),
    })),
    techStacks: techStacks.map(t => ({
      name: t.name,
      type: t.type,
      version: t.version,
      versionConstraint: t.version_constraint,
      description: t.description,
      longDescription: t.long_description,
      resources: t.resources.map(r => ({
        type: r.resource_type,
        name: r.name,
        url: r.url,
        description: r.description,
      })),
    })),
  };
}

export function buildChatMarkdown(
  buildBookName: string,
  messages: ChatMessage[]
): string {
  let markdown = buildChatMetadataHeader(buildBookName);

  markdown += `# Ask AI Chat: ${buildBookName}\n\n`;
  markdown += "## Conversation\n\n";

  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    markdown += `**${role}:**\n\n${msg.content}\n\n---\n\n`;
  }

  return markdown;
}

export function downloadAsMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.md`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadAsJSON(content: object, filename: string): void {
  const blob = new Blob([JSON.stringify(content, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

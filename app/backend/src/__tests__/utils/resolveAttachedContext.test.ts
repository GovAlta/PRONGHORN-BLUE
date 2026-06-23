/**
 * Tests for resolveAttachedContext utility.
 *
 * Verifies that artifact content is correctly enriched from blob storage
 * and that edge cases (missing content, errors, empty input) are handled
 * gracefully.
 */

jest.mock("../../staging/artifactContentStore", () => ({
  getArtifactContent: jest.fn(),
}));

jest.mock("../../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { resolveAttachedContext } from "../../utils/resolveAttachedContext";
import { getArtifactContent } from "../../staging/artifactContentStore";

const mockGetArtifactContent = getArtifactContent as jest.MockedFunction<
  typeof getArtifactContent
>;

describe("resolveAttachedContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns null/undefined input unchanged", async () => {
    expect(await resolveAttachedContext(null, "proj-1")).toBeNull();
    expect(await resolveAttachedContext(undefined, "proj-1")).toBeUndefined();
  });

  it("returns context unchanged when projectId is empty", async () => {
    const ctx = { artifacts: [{ id: "a1", ai_title: "Doc" }] };
    expect(await resolveAttachedContext(ctx, "")).toBe(ctx);
  });

  it("returns context unchanged when no artifacts", async () => {
    const ctx = { requirements: [{ id: "r1" }] };
    const result = await resolveAttachedContext(ctx, "proj-1");
    expect(result).toBe(ctx);
    expect(mockGetArtifactContent).not.toHaveBeenCalled();
  });

  it("returns context unchanged when artifacts array is empty", async () => {
    const ctx = { artifacts: [] };
    const result = await resolveAttachedContext(ctx, "proj-1");
    expect(result).toBe(ctx);
    expect(mockGetArtifactContent).not.toHaveBeenCalled();
  });

  it("enriches artifacts with blob content", async () => {
    mockGetArtifactContent.mockResolvedValueOnce("Full document text");

    const ctx = {
      artifacts: [{ id: "art-1", ai_title: "Design Doc", ai_summary: "A summary" }],
      requirements: [{ id: "req-1" }],
    };

    const result = await resolveAttachedContext(ctx, "proj-1");

    expect(mockGetArtifactContent).toHaveBeenCalledWith("proj-1", "art-1");
    expect(result.artifacts[0].content).toBe("Full document text");
    expect(result.artifacts[0].ai_title).toBe("Design Doc");
    expect(result.artifacts[0].ai_summary).toBe("A summary");
    // Original requirements should be preserved
    expect(result.requirements).toEqual([{ id: "req-1" }]);
  });

  it("does not mutate the original context object", async () => {
    mockGetArtifactContent.mockResolvedValueOnce("Content");

    const original = {
      artifacts: [{ id: "art-1", ai_title: "Doc" }],
    };
    const originalArtifact = original.artifacts[0];

    const result = await resolveAttachedContext(original, "proj-1");

    expect(result).not.toBe(original);
    expect(result.artifacts[0]).not.toBe(originalArtifact);
    expect(originalArtifact).not.toHaveProperty("content");
  });

  it("skips artifacts that already have content", async () => {
    const ctx = {
      artifacts: [{ id: "art-1", ai_title: "Doc", content: "Already loaded" }],
    };

    const result = await resolveAttachedContext(ctx, "proj-1");

    expect(mockGetArtifactContent).not.toHaveBeenCalled();
    expect(result.artifacts[0].content).toBe("Already loaded");
  });

  it("skips artifacts without an id", async () => {
    const ctx = {
      artifacts: [{ ai_title: "No ID artifact" }],
    };

    const result = await resolveAttachedContext(ctx, "proj-1");

    expect(mockGetArtifactContent).not.toHaveBeenCalled();
    expect(result.artifacts[0]).toEqual({ ai_title: "No ID artifact" });
  });

  it("handles null blob content gracefully", async () => {
    mockGetArtifactContent.mockResolvedValueOnce(null);

    const ctx = {
      artifacts: [{ id: "art-1", ai_title: "Missing Blob" }],
    };

    const result = await resolveAttachedContext(ctx, "proj-1");

    expect(result.artifacts[0]).not.toHaveProperty("content");
    expect(result.artifacts[0].ai_title).toBe("Missing Blob");
  });

  it("handles blob fetch errors gracefully", async () => {
    mockGetArtifactContent.mockRejectedValueOnce(new Error("Blob not found"));

    const ctx = {
      artifacts: [{ id: "art-1", ai_title: "Error Doc" }],
    };

    const result = await resolveAttachedContext(ctx, "proj-1");

    expect(result.artifacts[0]).not.toHaveProperty("content");
    expect(result.artifacts[0].ai_title).toBe("Error Doc");
  });

  it("enriches multiple artifacts in parallel", async () => {
    mockGetArtifactContent
      .mockResolvedValueOnce("Content A")
      .mockResolvedValueOnce("Content B")
      .mockResolvedValueOnce(null); // Third one missing

    const ctx = {
      artifacts: [
        { id: "art-1", ai_title: "Doc A" },
        { id: "art-2", ai_title: "Doc B" },
        { id: "art-3", ai_title: "Doc C" },
      ],
    };

    const result = await resolveAttachedContext(ctx, "proj-1");

    expect(mockGetArtifactContent).toHaveBeenCalledTimes(3);
    expect(result.artifacts[0].content).toBe("Content A");
    expect(result.artifacts[1].content).toBe("Content B");
    expect(result.artifacts[2]).not.toHaveProperty("content");
  });

  it("truncates content when maxArtifactContentLength is set", async () => {
    const longContent = "A".repeat(500);
    mockGetArtifactContent.mockResolvedValueOnce(longContent);

    const ctx = {
      artifacts: [{ id: "art-1", ai_title: "Long Doc" }],
    };

    const result = await resolveAttachedContext(ctx, "proj-1", {
      maxArtifactContentLength: 100,
    });

    expect(result.artifacts[0].content).toHaveLength(100 + "\n…[truncated]".length);
    expect(result.artifacts[0].content).toContain("…[truncated]");
  });

  it("does not truncate when content is within limit", async () => {
    const content = "Short content";
    mockGetArtifactContent.mockResolvedValueOnce(content);

    const ctx = {
      artifacts: [{ id: "art-1", ai_title: "Short Doc" }],
    };

    const result = await resolveAttachedContext(ctx, "proj-1", {
      maxArtifactContentLength: 1000,
    });

    expect(result.artifacts[0].content).toBe(content);
  });

  it("does not truncate when maxArtifactContentLength is 0 (disabled)", async () => {
    const longContent = "A".repeat(100000);
    mockGetArtifactContent.mockResolvedValueOnce(longContent);

    const ctx = {
      artifacts: [{ id: "art-1", ai_title: "Huge Doc" }],
    };

    const result = await resolveAttachedContext(ctx, "proj-1", {
      maxArtifactContentLength: 0,
    });

    expect(result.artifacts[0].content).toBe(longContent);
  });

  it("handles mixed success and failure across artifacts", async () => {
    mockGetArtifactContent
      .mockResolvedValueOnce("Good content")
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce("Also good");

    const ctx = {
      artifacts: [
        { id: "art-1", ai_title: "Good" },
        { id: "art-2", ai_title: "Failing" },
        { id: "art-3", ai_title: "Also Good" },
      ],
    };

    const result = await resolveAttachedContext(ctx, "proj-1");

    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts[0].content).toBe("Good content");
    expect(result.artifacts[1]).not.toHaveProperty("content");
    expect(result.artifacts[2].content).toBe("Also good");
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAnonymousProjects } from "../useAnonymousProjects";

const STORAGE_KEY = "embly_anonymous_projects";

const mockProject = {
  id: "proj-1",
  shareToken: "token-abc",
  name: "Test Project",
  createdAt: "2025-01-01T00:00:00Z",
};

describe("useAnonymousProjects", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("initializes with empty projects", () => {
    const { result } = renderHook(() => useAnonymousProjects());
    expect(result.current.projects).toEqual([]);
  });

  it("loads projects from sessionStorage on mount", () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([mockProject]));
    const { result } = renderHook(() => useAnonymousProjects());
    expect(result.current.projects).toEqual([mockProject]);
  });

  it("addProject persists to sessionStorage and updates state", () => {
    const { result } = renderHook(() => useAnonymousProjects());

    act(() => {
      result.current.addProject(mockProject);
    });

    expect(result.current.projects).toHaveLength(1);
    expect(result.current.projects[0].id).toBe("proj-1");

    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe("proj-1");
  });

  it("addProject appends to existing projects", () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([mockProject]));
    const { result } = renderHook(() => useAnonymousProjects());

    const project2 = { ...mockProject, id: "proj-2", name: "Second" };
    act(() => {
      result.current.addProject(project2);
    });

    expect(result.current.projects).toHaveLength(2);
  });

  it("removeProject removes by id and updates storage", () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([mockProject]));
    const { result } = renderHook(() => useAnonymousProjects());

    act(() => {
      result.current.removeProject("proj-1");
    });

    expect(result.current.projects).toHaveLength(0);
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY)!);
    expect(stored).toHaveLength(0);
  });

  it("removeProject is a no-op for non-existent id", () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([mockProject]));
    const { result } = renderHook(() => useAnonymousProjects());

    act(() => {
      result.current.removeProject("nonexistent");
    });

    expect(result.current.projects).toHaveLength(1);
  });

  it("clearAll removes all projects and clears storage", () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([mockProject]));
    const { result } = renderHook(() => useAnonymousProjects());

    act(() => {
      result.current.clearAll();
    });

    expect(result.current.projects).toHaveLength(0);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("handles corrupted sessionStorage gracefully", () => {
    sessionStorage.setItem(STORAGE_KEY, "not-valid-json");
    // Should not throw — the hook catches parse errors
    const { result } = renderHook(() => useAnonymousProjects());
    expect(result.current.projects).toEqual([]);
  });
});

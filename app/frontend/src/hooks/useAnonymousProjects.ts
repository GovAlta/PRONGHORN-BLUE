import { useEffect, useState } from "react";

const ANONYMOUS_PROJECTS_KEY = "embly_anonymous_projects";

interface AnonymousProject {
  id: string;
  shareToken: string;
  name: string;
  createdAt: string;
}

export function useAnonymousProjects() {
  const [projects, setProjects] = useState<AnonymousProject[]>([]);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = () => {
    try {
      const stored = sessionStorage.getItem(ANONYMOUS_PROJECTS_KEY);
      if (stored) {
        setProjects(JSON.parse(stored));
      }
    } catch (error) {
      console.error("Failed to load anonymous projects:", error);
    }
  };

  const addProject = (project: AnonymousProject) => {
    try {
      const updated = [...projects, project];
      sessionStorage.setItem(ANONYMOUS_PROJECTS_KEY, JSON.stringify(updated));
      setProjects(updated);
      console.log("[useAnonymousProjects] Project added to session:", project.id);
    } catch (error) {
      console.error("Failed to save anonymous project:", error);
    }
  };

  const removeProject = (projectId: string) => {
    try {
      const updated = projects.filter(p => p.id !== projectId);
      sessionStorage.setItem(ANONYMOUS_PROJECTS_KEY, JSON.stringify(updated));
      setProjects(updated);
    } catch (error) {
      console.error("Failed to remove anonymous project:", error);
    }
  };

  const clearAll = () => {
    try {
      sessionStorage.removeItem(ANONYMOUS_PROJECTS_KEY);
      setProjects([]);
    } catch (error) {
      console.error("Failed to clear anonymous projects:", error);
    }
  };

  return {
    projects,
    addProject,
    removeProject,
    clearAll,
  };
}

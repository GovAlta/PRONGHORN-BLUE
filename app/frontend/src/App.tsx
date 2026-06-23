import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { ScrollToTop } from "./components/ScrollToTop";
import { PWAUpdatePrompt } from "./components/PWAUpdatePrompt";
import { PageLoader } from "./components/PageLoader";

// Eagerly loaded (lightweight pages)
import Landing from "./pages/Landing";
import Auth from "./pages/Auth";
import AuthCallback from "./pages/AuthCallback";
import NotFound from "./pages/NotFound";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";
import License from "./pages/License";

// Resilient lazy loader: auto-reloads the page if a chunk fails to load
// (e.g., after a new deployment when old chunk hashes no longer exist)
function lazyWithRetry(importFn: () => Promise<any>) {
  return lazy(() =>
    importFn().catch((error) => {
      // Only reload once to avoid infinite loops
      const hasReloaded = sessionStorage.getItem("chunk_reload");
      if (!hasReloaded) {
        sessionStorage.setItem("chunk_reload", "true");
        window.location.reload();
      }
      throw error;
    })
  );
}

// Clear the reload flag on successful page load
sessionStorage.removeItem("chunk_reload");

// Lazy loaded (heavy pages with large dependencies)
const Dashboard = lazyWithRetry(() => import("./pages/Dashboard"));
const Gallery = lazyWithRetry(() => import("./pages/Gallery"));
const Standards = lazyWithRetry(() => import("./pages/Standards"));
const TechStacks = lazyWithRetry(() => import("./pages/TechStacks"));
const BuildBooks = lazyWithRetry(() => import("./pages/BuildBooks"));
const BuildBookDetail = lazyWithRetry(() => import("./pages/BuildBookDetail"));
const BuildBookEditor = lazyWithRetry(() => import("./pages/BuildBookEditor"));
const Settings = lazyWithRetry(() => import("./pages/Settings"));

// Project pages (all use heavy libraries like Monaco, ReactFlow, etc.)
const Requirements = lazyWithRetry(() => import("./pages/project/Requirements"));
const ProjectStandards = lazyWithRetry(() => import("./pages/project/Standards"));
const Canvas = lazyWithRetry(() => import("./pages/project/Canvas"));
const Audit = lazyWithRetry(() => import("./pages/project/Audit"));
const Build = lazyWithRetry(() => import("./pages/project/Build"));
const Repository = lazyWithRetry(() => import("./pages/project/Repository"));
const ProjectSettings = lazyWithRetry(() => import("./pages/project/ProjectSettings"));
const Specifications = lazyWithRetry(() => import("./pages/project/Specifications"));
const Deploy = lazyWithRetry(() => import("./pages/project/Deploy"));
const Database = lazyWithRetry(() => import("./pages/project/Database"));
const Artifacts = lazyWithRetry(() => import("./pages/project/Artifacts"));
const Chat = lazyWithRetry(() => import("./pages/project/Chat"));
const Present = lazyWithRetry(() => import("./pages/project/Present"));
const GitHubCallback = lazyWithRetry(() => import("./pages/GitHubCallback"));

const App = () => (
  <>
    <ScrollToTop />
    <PWAUpdatePrompt />
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Public routes - no signup validation required */}
        <Route path="/" element={<Landing />} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/github/callback" element={<GitHubCallback />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/license" element={<License />} />
        
        {/* Protected routes */}
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/gallery" element={<Gallery />} />
        <Route path="/standards" element={<Standards />} />
        <Route path="/tech-stacks" element={<TechStacks />} />
        <Route path="/build-books" element={<BuildBooks />} />
        <Route path="/build-books/new" element={<BuildBookEditor />} />
        <Route path="/build-books/:id" element={<BuildBookDetail />} />
        <Route path="/build-books/:id/edit" element={<BuildBookEditor />} />
        <Route path="/settings/organization" element={<Settings />} />
        <Route path="/settings/profile" element={<Settings />} />
        
        {/* Project Routes - Standard (authenticated users) */}
        <Route path="/project/:projectId/settings" element={<ProjectSettings />} />
        <Route path="/project/:projectId/artifacts" element={<Artifacts />} />
        <Route path="/project/:projectId/chat" element={<Chat />} />
        <Route path="/project/:projectId/requirements" element={<Requirements />} />
        <Route path="/project/:projectId/standards" element={<ProjectStandards />} />
        <Route path="/project/:projectId/canvas" element={<Canvas />} />
        <Route path="/project/:projectId/audit" element={<Audit />} />
        <Route path="/project/:projectId/build" element={<Build />} />
        <Route path="/project/:projectId/repository" element={<Repository />} />
        <Route path="/project/:projectId/specifications" element={<Specifications />} />
        <Route path="/project/:projectId/database" element={<Database />} />
        <Route path="/project/:projectId/deploy" element={<Deploy />} />
        <Route path="/project/:projectId/present" element={<Present />} />
        
        {/* Project Routes - With Token (shared access via path-based token) */}
        <Route path="/project/:projectId/settings/t/:token" element={<ProjectSettings />} />
        <Route path="/project/:projectId/artifacts/t/:token" element={<Artifacts />} />
        <Route path="/project/:projectId/chat/t/:token" element={<Chat />} />
        <Route path="/project/:projectId/requirements/t/:token" element={<Requirements />} />
        <Route path="/project/:projectId/standards/t/:token" element={<ProjectStandards />} />
        <Route path="/project/:projectId/canvas/t/:token" element={<Canvas />} />
        <Route path="/project/:projectId/audit/t/:token" element={<Audit />} />
        <Route path="/project/:projectId/build/t/:token" element={<Build />} />
        <Route path="/project/:projectId/repository/t/:token" element={<Repository />} />
        <Route path="/project/:projectId/specifications/t/:token" element={<Specifications />} />
        <Route path="/project/:projectId/database/t/:token" element={<Database />} />
        <Route path="/project/:projectId/deploy/t/:token" element={<Deploy />} />
        <Route path="/project/:projectId/present/t/:token" element={<Present />} />
        
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  </>
);

export default App;

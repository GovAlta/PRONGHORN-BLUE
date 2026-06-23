# 010 — Toast System Migration: Radix useToast → Sonner

## Summary

The frontend has **two toast systems** installed but only **one** is wired up to render. All toast calls using the Radix/shadcn `useToast` hook are silently swallowed — no UI feedback reaches the user.

## Root Cause

| System | Package | Renderer | Mounted? |
|--------|---------|----------|----------|
| **Sonner** | `sonner` (^1.7.4) | `<Toaster>` from `@/components/ui/sonner` | **Yes** — `main.tsx` line 25 |
| **Radix/shadcn** | `@radix-ui/react-toast` (^1.2.14) | `<Toaster>` from `@/components/ui/toaster` | **No** — not mounted anywhere |

The `useToast` hook from `@/hooks/use-toast` dispatches to an in-memory reducer that queues toast state, but the `<Toaster>` component that reads and renders that state is never included in the component tree. Every `toast({...})` call via `useToast` updates internal state with no visible effect.

## Scale

| Metric | Sonner (working) | Radix useToast (broken) |
|--------|:-----------------:|:-----------------------:|
| **Files importing** | 91 | 12 |
| **Approximate toast calls** | ~500+ | 68 |
| **Percentage of toast-using files** | 88% | 12% |

## Affected Files (12 files, 68 broken toast calls)

| Toast Calls | File | Area |
|:-----------:|------|------|
| 21 | `pages/project/Canvas.tsx` | Canvas page |
| 7 | `components/repository/ManagePATDialog.tsx` | Repository PAT management |
| 6 | `components/superadmin/SuperadminRenderManager.tsx` | Superadmin |
| 6 | `components/superadmin/SuperadminCloudManager.tsx` | Superadmin |
| 6 | `components/canvas/AIArchitectDialog.tsx` | Canvas AI dialog |
| 4 | `components/superadmin/SuperadminGitHubManager.tsx` | Superadmin |
| 4 | `components/repository/CodeEditor.tsx` | Code editor |
| 3 | `components/gallery/GalleryCloneDialog.tsx` | Gallery |
| 3 | `components/dashboard/CloneProjectDialog.tsx` | Dashboard |
| 3 | `components/build/CommitHistory.tsx` | Build |
| 3 | `components/build/AgentPromptPanel.tsx` | Build |
| 2 | `components/repository/RepoCard.tsx` | Repository card |

### Dead infrastructure files (to remove after migration)

| File | Purpose |
|------|---------|
| `hooks/use-toast.ts` | Reducer-based toast state manager |
| `hooks/__tests__/use-toast.test.ts` | Tests for dead hook |
| `components/ui/toast.tsx` | Radix toast primitives (Provider, Viewport, etc.) |
| `components/ui/toaster.tsx` | Unmounted renderer component |
| `components/ui/use-toast.ts` | Re-export shim |

## Migration Pattern

Each affected file requires two changes:

**1. Replace import:**
```diff
- import { useToast } from "@/hooks/use-toast";
+ import { toast } from "sonner";
```

**2. Remove hook call:**
```diff
- const { toast } = useToast();
```

**3. Convert toast call syntax:**
```diff
// Error toast
- toast({ title: "Error", description: "Something failed", variant: "destructive" });
+ toast.error("Something failed");

// Error toast with description
- toast({ title: "Push Failed", description: `Details: ${msg}`, variant: "destructive" });
+ toast.error("Push Failed", { description: `Details: ${msg}` });

// Success toast
- toast({ title: "Success", description: "File saved" });
+ toast.success("File saved");

// Info/neutral toast
- toast({ title: "Info", description: "Processing..." });
+ toast("Processing...");
```

## Post-Migration Cleanup

After all 12 files are migrated:

1. Remove dead files:
   - `src/hooks/use-toast.ts`
   - `src/hooks/__tests__/use-toast.test.ts`
   - `src/components/ui/toast.tsx`
   - `src/components/ui/toaster.tsx`
   - `src/components/ui/use-toast.ts`

2. Remove package dependency:
   - `@radix-ui/react-toast` from `package.json`

3. Run `npm install` to update lockfile.

## Validation

- `npx tsc --noEmit` — no type errors
- `npm run build` — production build succeeds
- `npm run lint` — no lint errors
- `npm run test` — all tests pass (remove `use-toast.test.ts` first)
- Manual: trigger error/success paths in each affected component and verify toast appears in top-right

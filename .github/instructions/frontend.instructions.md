---
applyTo: "app/frontend/src/**"
---

# Frontend Layer — Pronghorn Web App

## Stack
- React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Query, React Router
- Auth: MSAL / Azure Entra ID via `app/frontend/src/config/`, `app/frontend/src/contexts/`
- AI config: `app/frontend/src/config/aiModels.ts` — Azure Foundry only, all AI calls go through the API

## Architecture
- Direct **Web App → API** communication. All data fetching goes through the API endpoints.
- Use the `@/` import alias (`@/* → src/*`) for all imports.
- Reuse existing components from `app/frontend/src/components/`, hooks from `app/frontend/src/hooks/`, utilities from `app/frontend/src/lib/` and `app/frontend/src/utils/` before creating new ones.

## UI/UX Layout Immutability (NON-NEGOTIABLE)
**The existing UI/UX layout MUST NOT be modified.** This is an explicit client requirement.
- DO NOT change page layouts, sidebar/header/footer structure, or navigation flows.
- DO NOT rearrange component positioning, modal/dialog patterns, or responsive breakpoints.
- DO NOT alter visual hierarchy or page structure.
- Styling changes (colors, fonts, spacing) within the existing layout ARE permitted when they don't alter structural layout.
- Any layout change requires explicit written approval from the client.

## Testing
- Framework: Vitest
- Test files: `app/frontend/src/test/`
- Config: `app/frontend/vitest.config.ts`
- Run: `cd app/frontend && npm test`

## Build & Lint
- Lint: `cd app/frontend && npm run lint`
- Build: `cd app/frontend && npm run build`

## Patterns
- Follow existing Tailwind token/theme usage; do not hard-code new design tokens.
- Keep state/data-fetching patterns consistent with existing React Query and context usage.
- Respect MSAL/Azure auth integration and existing env-var-driven configuration.
- When adding or modifying shadcn/ui components, follow the `shadcn-ui` skill guidance for Radix UI primitives, Tailwind CSS theming, and accessible component patterns.

## MCP Tools Available
- **GitHub MCP**: PR context, code review, file contents

## Production Quality Skills (installed via `npx skills`)
The following skills are installed in `.agents/skills/` and provide detailed guidance for production-quality frontend development. Reference them when working on frontend features:

- **`accessibility`** — WCAG 2.2 compliance, screen reader support, keyboard navigation, ARIA patterns, color contrast. Use for any new component or UI change.
- **`performance`** — Web performance optimization: lazy loading, code splitting, bundle analysis, image optimization, caching strategies.
- **`core-web-vitals`** — LCP, INP, CLS optimization for page experience and search ranking.
- **`best-practices`** — Modern web security, compatibility, code quality patterns. CSP, HTTPS, input validation.
- **`shadcn-ui`** — Component patterns for shadcn/ui with Radix UI, Tailwind CSS theming, accessible variants, form validation with Zod.

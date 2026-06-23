# Frontend Unit Tests

## Quick Start

```bash
# Run all tests once
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

## Stack

| Tool | Purpose |
|---|---|
| [Vitest](https://vitest.dev/) | Test runner (Vite-native, Jest-compatible API) |
| [jsdom](https://github.com/jsdom/jsdom) | Browser environment for DOM tests |
| [@testing-library/react](https://testing-library.com/docs/react-testing-library/intro/) | Component rendering and queries |
| [@testing-library/jest-dom](https://github.com/testing-library/jest-dom) | Custom DOM matchers (`toBeInTheDocument`, etc.) |
| [@testing-library/user-event](https://testing-library.com/docs/user-event/intro/) | Simulated user interactions |

## Configuration

- **Vitest config:** `vitest.config.ts` — jsdom environment, `@/` path alias, v8 coverage provider.
- **Setup file:** `src/test/setup.ts` — loads jest-dom matchers and mocks `window.matchMedia` (not implemented in jsdom).
- **Globals:** `vi`, `describe`, `it`, `expect`, `beforeEach`, etc. are available globally (no imports needed).

## Project Structure

Tests live in `__tests__/` directories next to the source they cover:

```
src/
├── test/
│   ├── setup.ts              # Global test setup
│   └── README.md             # ← You are here
├── components/__tests__/
│   ├── NavLink.test.tsx       # NavLink routing behavior
│   ├── NotFound.test.tsx      # 404 page rendering
│   ├── PageLoader.test.tsx    # Loading spinner states
│   └── ThemeToggle.test.tsx   # Dark/light theme toggle
├── config/__tests__/
│   └── aiModels.test.ts       # AI model configuration helpers
├── contexts/__tests__/
│   └── AuthContext.test.tsx    # Auth provider boundary check
├── hooks/__tests__/
│   ├── use-mobile.test.tsx    # Mobile breakpoint detection
│   ├── use-toast.test.ts      # Toast notification hook
│   └── useAnonymousProjects.test.ts  # Session-backed project store
├── lib/__tests__/
│   ├── apiClient.test.ts      # API client and token helpers
│   ├── authTypes.test.ts      # Auth type guards and mappers
│   ├── connectionLogic.test.ts # Canvas connection validation
│   ├── sqlParser.test.ts      # SQL splitting and DDL parsing
│   ├── tokenCache.test.ts     # Dual-layer token cache
│   └── utils.test.ts          # General utility functions
└── utils/__tests__/
    ├── parseJson.test.ts      # JSON parsing and normalization
    ├── sqlGenerator.test.ts   # SQL generation from table data
    ├── tableMatching.test.ts  # Table name matching logic
    └── typeInference.test.ts  # Column type inference
```

## Writing Tests

### Pure functions (easiest)

```ts
import { describe, it, expect } from "vitest";
import { myFunction } from "@/lib/myModule";

describe("myFunction", () => {
  it("returns expected output", () => {
    expect(myFunction("input")).toBe("output");
  });
});
```

### React hooks

```tsx
import { renderHook, act } from "@testing-library/react";
import { useMyHook } from "@/hooks/useMyHook";

it("updates state", () => {
  const { result } = renderHook(() => useMyHook());
  act(() => result.current.doSomething());
  expect(result.current.value).toBe(42);
});
```

### React components

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MyComponent } from "@/components/MyComponent";

it("handles click", async () => {
  const user = userEvent.setup();
  render(<MyComponent />);
  await user.click(screen.getByRole("button"));
  expect(screen.getByText("Clicked")).toBeInTheDocument();
});
```

### Mocking modules

```ts
vi.mock("@/lib/someModule", () => ({
  someExport: vi.fn().mockReturnValue("mocked"),
}));
```

## Running a Single File

```bash
npx vitest run src/lib/__tests__/sqlParser.test.ts
```

## Notes

- Install with `npm install --legacy-peer-deps` (required due to a vite-plugin-pwa peer dep).
- Heavy dependencies like `@azure/msal-browser` must be mocked to avoid worker OOM; see `AuthContext.test.tsx` for the pattern.
- The `@/` alias resolves to `./src/` in both app code and tests.

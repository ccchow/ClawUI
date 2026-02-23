# Security Lockdown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Lock both services to 127.0.0.1 and add a per-restart auth token so only authorized clients can access the API.

**Architecture:** Backend generates a random token on startup, writes it to `.clawui/auth-token`, and rejects any `/api/*` request missing it. Frontend reads the token from `localStorage` (seeded via `?auth=` URL param) and attaches it to all fetch calls. Next.js proxy reads the token file and injects the header when proxying SSR requests to the backend. All services bind to `127.0.0.1` only.

**Tech Stack:** Node.js `crypto`, Express middleware, Next.js rewrites, React client component, `localStorage`.

**Design doc:** `docs/plans/2026-02-22-security-lockdown-design.md`

---

### Task 1: Backend — Create `auth.ts` (token generation + middleware)

**Files:**
- Create: `backend/src/auth.ts`
- Test: `backend/src/__tests__/auth.test.ts`

**Step 1: Write the failing test**

Create `backend/src/__tests__/auth.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock fs so token file write doesn't hit disk
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

import { requireLocalAuth, LOCAL_AUTH_TOKEN } from "../auth.js";

describe("auth", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(requireLocalAuth);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));
  });

  it("generates a 32-char hex token", () => {
    expect(LOCAL_AUTH_TOKEN).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects requests without token with 403", async () => {
    const res = await request(app).get("/api/test");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
  });

  it("accepts requests with valid x-clawui-token header", async () => {
    const res = await request(app)
      .get("/api/test")
      .set("x-clawui-token", LOCAL_AUTH_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("accepts requests with valid ?auth= query param", async () => {
    const res = await request(app).get(`/api/test?auth=${LOCAL_AUTH_TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("rejects requests with invalid token", async () => {
    const res = await request(app)
      .get("/api/test")
      .set("x-clawui-token", "wrong-token");
    expect(res.status).toBe(403);
  });

  it("skips auth for non-/api/ paths", async () => {
    app = express();
    app.use(requireLocalAuth);
    app.get("/health", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/auth.test.ts`
Expected: FAIL — `../auth.js` does not exist

**Step 3: Write implementation**

Create `backend/src/auth.ts`:

```typescript
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response, NextFunction } from "express";
import { CLAWUI_DB_DIR } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("auth");

// Generate a fresh 32-char hex token each process start
export const LOCAL_AUTH_TOKEN = crypto.randomBytes(16).toString("hex");

// Write token to shared file so Next.js proxy can read it
const tokenDir = join(process.cwd(), CLAWUI_DB_DIR);
try {
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, "auth-token"), LOCAL_AUTH_TOKEN, "utf-8");
} catch (err) {
  log.warn(`Failed to write auth token file: ${err}`);
}

/**
 * Express middleware: require valid auth token on all /api/* routes.
 * Token can be provided via `x-clawui-token` header or `?auth=` query param.
 * Non-API paths are passed through (e.g. health checks).
 */
export const requireLocalAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith("/api/")) {
    return next();
  }

  const clientToken = req.headers["x-clawui-token"] || req.query.auth;

  if (!clientToken || clientToken !== LOCAL_AUTH_TOKEN) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Missing or invalid Local Auth Token.",
    });
  }
  next();
};
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/__tests__/auth.test.ts`
Expected: all 6 tests PASS

**Step 5: Commit**

```bash
git add backend/src/auth.ts backend/src/__tests__/auth.test.ts
git commit -m "feat(auth): add local auth token generation and middleware"
```

---

### Task 2: Backend — Network lockdown + wire auth middleware

**Files:**
- Modify: `backend/src/index.ts` (lines 31, 43)

**Step 1: Modify `index.ts`**

Three changes:

1. Import auth module and token:
```typescript
// Add after existing imports (line 9)
import { requireLocalAuth, LOCAL_AUTH_TOKEN } from "./auth.js";
```

2. Lock down CORS and add auth middleware (replace line 31 `app.use(cors())`):
```typescript
app.use(cors({ origin: "http://127.0.0.1:3000" }));
app.use(express.json({ limit: "10mb" }));

// Auth middleware — must be before route handlers
app.use(requireLocalAuth);
```

3. Bind to 127.0.0.1 and print auth URL (replace lines 43-45):
```typescript
const HOST = "127.0.0.1";

app.listen(PORT, HOST, () => {
  log.info(`ClawUI backend locked to http://${HOST}:${PORT}`);
  log.info("");
  log.info("========================================================");
  log.info("  ClawUI Secure Dashboard Ready");
  log.info("  Local:     http://localhost:3000");
  log.info(`  Tailscale: http://<your-tailscale-ip>:3000/?auth=${LOCAL_AUTH_TOKEN}`);
  log.info("========================================================");
  log.info("");
});
```

**Step 2: Run existing route tests to check auth doesn't break them**

The existing `routes.test.ts` creates its own Express app with `supertest` — it imports `router` directly and doesn't go through `index.ts`, so it bypasses the middleware. Tests should still pass unchanged.

Run: `cd backend && npx vitest run`
Expected: all tests PASS

**Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(security): bind backend to 127.0.0.1, wire auth middleware, lock CORS"
```

---

### Task 3: Frontend — Lock hostname to 127.0.0.1

**Files:**
- Modify: `frontend/package.json` (lines 13, 18, 19)

**Step 1: Update scripts**

Change all three `--hostname 0.0.0.0` to `--hostname 127.0.0.1`:

```json
"scripts": {
  "dev": "next dev --port 3000 --hostname 127.0.0.1",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "test": "vitest run",
  "dev:stable": "NEXT_PUBLIC_API_PORT=3001 next start --port 3000 --hostname 127.0.0.1",
  "dev:dev": "NEXT_PUBLIC_API_PORT=3101 next dev --port 3100 --hostname 127.0.0.1"
}
```

**Step 2: Commit**

```bash
git add frontend/package.json
git commit -m "feat(security): bind frontend dev/stable servers to 127.0.0.1"
```

---

### Task 4: Frontend — Switch API client to relative paths + attach auth token

**Files:**
- Modify: `frontend/src/lib/api.ts` (lines 1-4, 56-63)
- Test: `frontend/src/lib/api.test.ts` (update expectations)

**Step 1: Update `api.ts`**

Replace lines 1-4 (API_BASE construction) with:

```typescript
const API_BASE = "/api";

function getAuthToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("clawui_token") || "";
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { "x-clawui-token": token } : {};
}
```

Replace `fetchJSON` function (lines 56-63) with:

```typescript
async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}
```

Also update `getSessionMeta` (line 101) and `getSessionExecution` (line 344) which use raw `fetch()` directly — they need auth headers too:

```typescript
export function getSessionMeta(
  sessionId: string
): Promise<Partial<SessionMeta> | null> {
  return fetch(`${API_BASE}/sessions/${sessionId}/meta`, {
    headers: authHeaders(),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
}
```

```typescript
export function getSessionExecution(
  sessionId: string
): Promise<NodeExecution | null> {
  return fetch(`${API_BASE}/sessions/${sessionId}/execution`, {
    headers: authHeaders(),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
}
```

**Step 2: Update frontend API tests**

The existing `api.test.ts` checks that fetch was called with URLs like `http://localhost:3001/api/...`. These need to change to `/api/...`. Also, the fetch calls now include auth headers.

Update the test to mock `localStorage`:

```typescript
// Add after mockFetch setup in beforeEach:
vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => "test-token-123"),
  setItem: vi.fn(),
  removeItem: vi.fn(),
});
```

Update URL expectations throughout: replace `http://localhost:3001/api/` with `/api/`.

Update fetch call expectations to include the `x-clawui-token` header. For example, a simple GET call should now be called with:
```typescript
expect(mockFetch).toHaveBeenCalledWith("/api/projects", {
  headers: { "x-clawui-token": "test-token-123" },
});
```

For POST/PATCH/PUT calls that already pass headers, the auth header should be merged in:
```typescript
expect(mockFetch).toHaveBeenCalledWith("/api/sessions/s1/meta", {
  method: "PATCH",
  headers: { "Content-Type": "application/json", "x-clawui-token": "test-token-123" },
  body: JSON.stringify({ starred: true }),
});
```

**Step 3: Run frontend tests**

Run: `cd frontend && npx vitest run src/lib/api.test.ts`
Expected: all tests PASS

**Step 4: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/api.test.ts
git commit -m "feat(api): switch to relative /api/* paths and attach auth token header"
```

---

### Task 5: Frontend — Next.js proxy injects auth token

**Files:**
- Modify: `frontend/next.config.mjs`

**Step 1: Update `next.config.mjs`**

The Next.js proxy needs to read the token from the shared file and inject it as a header when forwarding requests to the backend. Next.js `rewrites` don't support custom headers, so we need to switch to `middleware.ts` or use a custom server header approach.

Actually, Next.js rewrites are transparent proxies — they forward the browser's request headers. Since the browser attaches `x-clawui-token` via `fetchJSON`, the header will be forwarded automatically. No change needed to `next.config.mjs` for the rewrite itself.

However, for SSR requests (server components calling `/api/*`), the browser headers aren't available. Since the current app uses `"use client"` for all components (per CLAUDE.md conventions), SSR API calls don't happen — all fetches run in the browser. So the existing rewrite + browser-side token attachment is sufficient.

Keep `next.config.mjs` as-is. No changes needed.

**Step 2: Verify no SSR fetch calls exist**

Run a quick check: search for any server-side `fetch` to `/api/` in page.tsx or layout.tsx files. The convention is all components are `"use client"`, so this should find nothing.

Run: `grep -r "fetch.*\/api" frontend/src/app/ --include="*.tsx" -l` (or use Grep tool)
Expected: No results (all API calls happen in client components via `lib/api.ts`)

**Step 3: Commit (skip if no changes)**

No commit needed — no file changes.

---

### Task 6: Frontend — AuthProvider gate component

**Files:**
- Create: `frontend/src/components/AuthProvider.tsx`
- Modify: `frontend/src/app/layout.tsx`
- Test: `frontend/src/components/AuthProvider.test.tsx`

**Step 1: Write the failing test**

Create `frontend/src/components/AuthProvider.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthProvider } from "./AuthProvider";

let mockStorage: Record<string, string> = {};

beforeEach(() => {
  mockStorage = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => mockStorage[key] ?? null),
    setItem: vi.fn((key: string, val: string) => { mockStorage[key] = val; }),
    removeItem: vi.fn((key: string) => { delete mockStorage[key]; }),
  });

  // Mock window.location and history
  Object.defineProperty(window, "location", {
    value: { search: "", pathname: "/", href: "http://localhost:3000/" },
    writable: true,
  });
  vi.stubGlobal("history", { replaceState: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuthProvider", () => {
  it("shows children when token is in localStorage", () => {
    mockStorage["clawui_token"] = "abc123";
    render(<AuthProvider><div>Dashboard</div></AuthProvider>);
    expect(screen.getByText("Dashboard")).toBeTruthy();
  });

  it("shows unauthorized message when no token exists", () => {
    render(<AuthProvider><div>Dashboard</div></AuthProvider>);
    expect(screen.queryByText("Dashboard")).toBeNull();
    expect(screen.getByText(/Unauthorized/i)).toBeTruthy();
  });

  it("extracts token from ?auth= param and stores it", () => {
    window.location.search = "?auth=mytoken123";
    render(<AuthProvider><div>Dashboard</div></AuthProvider>);
    expect(localStorage.setItem).toHaveBeenCalledWith("clawui_token", "mytoken123");
    expect(history.replaceState).toHaveBeenCalled();
    expect(screen.getByText("Dashboard")).toBeTruthy();
  });

  it("allows localhost access without token", () => {
    window.location.hostname = "localhost";
    render(<AuthProvider><div>Dashboard</div></AuthProvider>);
    // On localhost without token, still show unauthorized
    // (token is always required, even on localhost, for consistency)
    expect(screen.queryByText("Dashboard")).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/AuthProvider.test.tsx`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `frontend/src/components/AuthProvider.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    // Check URL for ?auth= param
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("auth");

    if (urlToken) {
      localStorage.setItem("clawui_token", urlToken);
      // Strip auth param from URL to prevent leakage
      params.delete("auth");
      const cleanSearch = params.toString();
      const cleanUrl = window.location.pathname + (cleanSearch ? `?${cleanSearch}` : "");
      history.replaceState(null, "", cleanUrl);
      setAuthorized(true);
      return;
    }

    // Check localStorage
    const storedToken = localStorage.getItem("clawui_token");
    setAuthorized(!!storedToken);
  }, []);

  // Loading state (first render before useEffect runs)
  if (authorized === null) {
    return null;
  }

  if (!authorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <div className="max-w-md rounded-lg border border-border-primary bg-bg-secondary p-8 text-center">
          <div className="mb-4 text-4xl">&#128274;</div>
          <h1 className="mb-2 text-xl font-bold text-text-primary">Unauthorized</h1>
          <p className="text-text-secondary">
            Please open the secure link printed in the ClawUI terminal to access this dashboard.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
```

**Step 4: Wire into layout.tsx**

Modify `frontend/src/app/layout.tsx` — wrap children with `AuthProvider`:

```tsx
import type { Metadata } from "next";
import { NavBar } from "@/components/NavBar";
import { AuthProvider } from "@/components/AuthProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClawUI — Claude Code Session Viewer",
  description: "Visualize and interact with Claude Code sessions",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg-primary text-text-primary antialiased">
        <AuthProvider>
          <NavBar />
          <main className="mx-auto max-w-5xl px-3 sm:px-4 py-6 overflow-x-hidden">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
```

**Step 5: Run tests**

Run: `cd frontend && npx vitest run src/components/AuthProvider.test.tsx`
Expected: all 4 tests PASS

**Step 6: Commit**

```bash
git add frontend/src/components/AuthProvider.tsx frontend/src/components/AuthProvider.test.tsx frontend/src/app/layout.tsx
git commit -m "feat(auth): add AuthProvider gate — extracts token from URL, blocks unauthorized access"
```

---

### Task 7: Update config + docs

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md` (conventions section)

**Step 1: Update `.env.example`**

Add a comment about the auth token:

```
# Auth token is auto-generated on each backend restart.
# Written to .clawui/auth-token — do NOT set manually.
```

**Step 2: Update CLAUDE.md**

Add to **Key Design Decisions** section:

```
- **Localhost-only binding**: Both frontend and backend bind to `127.0.0.1`. External access is via `tailscale serve` which proxies to localhost. Never bind to `0.0.0.0`.
- **Local Auth Token**: Backend generates `crypto.randomBytes(16)` hex token on startup, writes to `.clawui/auth-token`. All `/api/*` requests require `x-clawui-token` header. Frontend reads token from `localStorage` (seeded via `?auth=` URL param on first visit).
```

Add to **Gotchas** section:

```
- **Auth token on restart**: Token rotates on every backend restart. Phone/tablet users must re-copy the secure URL from terminal output. The old `?auth=` bookmark will 403.
```

**Step 3: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: add auth token and localhost binding to config docs"
```

---

### Task 8: Type-check and full test suite

**Step 1: Type-check both packages**

Run: `cd backend && npx tsc --noEmit && cd ../frontend && npx tsc --noEmit`
Expected: no type errors

**Step 2: Run all backend tests**

Run: `cd backend && npx vitest run`
Expected: all tests PASS

**Step 3: Run all frontend tests**

Run: `cd frontend && npx vitest run`
Expected: all tests PASS

**Step 4: Final commit (if any fixes needed)**

```bash
git add -A && git commit -m "fix: resolve type/test issues from security lockdown"
```

---

### Task 9: Manual acceptance testing

**Step 1: Start the app**

Run: `npm run dev`

**Step 2: Verify network lockdown**

From another terminal, confirm backend rejects non-localhost:
```bash
curl http://$(ipconfig getifaddr en0):3001/api/projects
```
Expected: `Connection refused`

**Step 3: Verify auth required**

```bash
curl http://127.0.0.1:3001/api/projects
```
Expected: `{"error":"Forbidden","message":"Missing or invalid Local Auth Token."}`

**Step 4: Verify auth works**

Read token from `.clawui/auth-token`, then:
```bash
TOKEN=$(cat .clawui/auth-token)
curl -H "x-clawui-token: $TOKEN" http://127.0.0.1:3001/api/projects
```
Expected: JSON array of projects

**Step 5: Verify frontend auth gate**

Open `http://localhost:3000` in browser — should show "Unauthorized" page.

Open `http://localhost:3000/?auth=$(cat .clawui/auth-token)` — should load dashboard normally.

Refresh the page (no `?auth=` param) — should still work (token in localStorage).

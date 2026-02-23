# ClawUI Security & Network Lockdown Design

**Date:** 2026-02-22
**Status:** Approved

## Problem

Both backend (Express :3001) and frontend (Next.js :3000) bind to `0.0.0.0`, exposing the service to any device on the local network or beyond. No authentication exists. Any machine that can reach the ports has full access to session data and can execute Claude CLI commands.

## Architecture

```
Phone (internet) --> Tailscale --> localhost:3000 (Next.js)
                                       | proxy /api/*
                                       v
                                  localhost:3001 (Express)

Both services bound to 127.0.0.1 only.
Auth token required for all /api/* requests.
Single port (3000) exposed via `tailscale serve`.
```

### Dual-Layer Isolation

1. **Network layer:** Services listen on `127.0.0.1` only. External access is handled by `tailscale serve` which proxies to localhost.
2. **Application layer:** A random Local Auth Token is generated on each backend startup. All API requests must carry this token.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| API routing | Always through Next.js proxy (`/api/*`) | Only one port to expose via Tailscale. Simpler setup. |
| Token sharing | Shared file (`.clawui/auth-token`) | Backend writes, Next.js reads. No env coordination. |
| Token lifetime | Rotate on restart | More secure for a dev tool. Phone users re-copy URL from terminal. |
| CORS | Lock to `127.0.0.1:3000` | All browser requests go through Next.js proxy; no cross-origin needed. |
| WebSocket auth | N/A | Project uses HTTP polling, no WebSockets. |

## Phase 1: Network Lockdown

### Backend (`backend/src/index.ts`)

Change `app.listen(PORT, "0.0.0.0", ...)` to `app.listen(PORT, "127.0.0.1", ...)`.

### Frontend (`frontend/package.json`)

Change all `--hostname 0.0.0.0` to `--hostname 127.0.0.1` in `dev`, `dev:stable`, `dev:dev` scripts.

### CORS (`backend/src/index.ts`)

Replace `app.use(cors())` with explicit origin allowlist: `http://127.0.0.1:3000`.

## Phase 2: Auth Token

### Token Generation & File (`backend/src/auth.ts`)

- `crypto.randomBytes(16).toString('hex')` on import (new each process start)
- Write token to `.clawui/auth-token` (overwrite)
- Export `LOCAL_AUTH_TOKEN` constant
- Export `requireLocalAuth` Express middleware:
  - Reads `x-clawui-token` header OR `?auth=` query param
  - Returns 403 if missing/mismatched
- Print secure URL to terminal on startup

### Middleware Registration (`backend/src/index.ts`)

Apply `requireLocalAuth` before all route handlers.

## Phase 3: Frontend Token Consumption

### API Client (`frontend/src/lib/api.ts`)

- Remove `window.location.hostname:3001` direct access
- Always use relative `/api/*` paths (Next.js proxy handles routing)
- Read token from `localStorage` key `clawui_token`
- Attach `x-clawui-token` header to every `fetch()` call

### Next.js Proxy (`frontend/next.config.mjs`)

- Read token from `.clawui/auth-token` file at build/startup time
- Inject `x-clawui-token` header into proxied `/api/*` requests

### Auth Gate (new `AuthProvider` component in `frontend/src/app/layout.tsx`)

- On mount: check URL for `?auth=xxx` → save to `localStorage` → `replaceState` to strip param
- If no token in URL or `localStorage` → fullscreen "Unauthorized" message
- Wraps all page children

## Out of Scope

- HTTPS at app level (Tailscale provides end-to-end encryption)
- Session/cookie auth (single-user dev tool; token-in-header suffices)
- WebSocket auth (no WebSockets in project)

## Acceptance Criteria

1. `curl http://<LAN-IP>:3001/api/projects` from another device returns "Connection Refused"
2. `curl http://127.0.0.1:3001/api/projects` without token returns 403
3. `curl -H "x-clawui-token: <token>" http://127.0.0.1:3001/api/projects` returns data
4. Accessing `http://localhost:3000` without token shows auth gate
5. Accessing `http://localhost:3000/?auth=<token>` saves token and loads normally

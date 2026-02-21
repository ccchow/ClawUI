# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawUI ("Claude Code Session Viewer") reads Claude Code session JSONL files from `~/.claude/projects/`, visualizes them as a vertical timeline, and provides interactive continuation via `claude --resume -p`.

The project is evolving toward an "Agent Cockpit" — a real-time AG-UI protocol dashboard (see `docs/PRD-v2.md` and README). The `packages/web/` directory holds early scaffolding for that direction, while `backend/` and `frontend/` contain the working MVP.

## Commands

```bash
# Run both backend and frontend in dev mode
npm run dev

# Run just the backend (Express on port 3001)
npm run dev:backend

# Run just the frontend (Next.js on port 3000)
npm run dev:frontend

# Build everything
npm run build

# Build backend only (TypeScript → dist/)
npm run build:backend

# Build frontend only (Next.js production build)
npm run build:frontend

# Lint backend only (root eslint.config.mjs targets backend/src/**/*.ts)
npm run lint
```

No test framework is set up yet.

## Architecture

**Monorepo** with npm workspaces: `backend` and `frontend`.

### Backend (`backend/`)

Node.js TypeScript Express server on port 3001. ESM (`"type": "module"`), uses `tsx watch` for dev.

- **jsonl-parser.ts** — Reads `~/.claude/projects/<project-hash>/<session-uuid>.jsonl`. Parses each JSON line into `TimelineNode[]` with types: user, assistant, tool_use, tool_result. Provides `listProjects()`, `listSessions()`, `parseTimeline()`.
- **cli-runner.ts** — Wraps `claude --dangerously-skip-permissions --resume <sessionId> -p "prompt"`. Single unified `runPrompt()` function that appends a `---SUGGESTIONS---` suffix to every prompt so Claude returns both the response and 3 continuation suggestions in one call.
- **routes.ts** — REST endpoints:
  - `GET /api/projects` — list all Claude Code projects
  - `GET /api/projects/:id/sessions` — list sessions for a project
  - `GET /api/sessions/:id/timeline` — parse session into timeline nodes
  - `POST /api/sessions/:id/run` — execute prompt, returns `{ output, suggestions }`
- **index.ts** — Express server entry with CORS and JSON body parsing.

### Frontend (`frontend/`)

Next.js 14 app with React 18, Tailwind CSS 3, dark theme.

- **Pages** — Session list (`/`) with project selector, session detail (`/session/[id]`) with timeline view.
- **Components** — `SessionList`, `Timeline`, `TimelineNode`, `SuggestionButtons`, `PromptInput`.
- **API Client** — `lib/api.ts` fetches from `/api/*` which Next.js rewrites to `localhost:3001` (see `next.config.mjs`).

### Data Flow

```
~/.claude/projects/*/*.jsonl → Backend (JSONL Parser) → REST API → Frontend (Timeline)
                                         ↑
              claude --resume -p ← CLI Runner ← POST /api/sessions/:id/run
```

## Conventions

- Backend uses Node16 module resolution with `.js` extensions in imports (e.g., `import { foo } from "./bar.js"`).
- Frontend uses `@/*` path alias mapping to `./src/*`.
- Root `eslint.config.mjs` uses `typescript-eslint`, scoped to `backend/src/**/*.ts` only (frontend is excluded).
- All frontend components are client components (`"use client"`).
- Dark theme with custom color tokens (bg-primary, accent-blue, etc.) defined in `frontend/tailwind.config.ts`.
- Next.js config is `.mjs` (not `.ts`) for Next.js 14 compatibility.

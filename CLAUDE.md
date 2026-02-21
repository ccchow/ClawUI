# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawUI ("Claude Code Session Viewer") reads Claude Code session JSONL files from `~/.claude/projects/`, visualizes them as a vertical timeline, and provides interactive continuation via `claude --resume -p`.

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

# Lint backend
npm run lint
```

## Architecture

**Monorepo** with npm workspaces: `backend` and `frontend`.

### Backend (`backend/`)

Node.js TypeScript Express server on port 3001.

- **jsonl-parser.ts** — Reads `~/.claude/projects/<project-hash>/<session-uuid>.jsonl`. Parses each JSON line into `TimelineNode[]` with types: user, assistant, tool_use, tool_result. Extracts content from message blocks (text, tool_use, tool_result, thinking). Provides `listProjects()`, `listSessions()`, `parseTimeline()`.
- **cli-runner.ts** — Wraps `claude --dangerously-skip-permissions --resume <sessionId> -p "prompt"`. Two functions: `getSuggestions()` (asks for 3 JSON suggestions) and `runPrompt()` (executes arbitrary prompt).
- **routes.ts** — REST endpoints:
  - `GET /api/projects` — list all Claude Code projects
  - `GET /api/projects/:id/sessions` — list sessions for a project
  - `GET /api/sessions/:id/timeline` — parse session into timeline nodes
  - `POST /api/sessions/:id/suggest` — get 3 AI continuation suggestions
  - `POST /api/sessions/:id/run` — execute custom prompt via --resume -p
- **index.ts** — Express server entry with CORS and JSON body parsing.

### Frontend (`frontend/`)

Next.js 14 app with React 18, Tailwind CSS 3, dark theme.

- **Pages** — Session list (`/`) with project selector, session detail (`/session/[id]`) with timeline view.
- **Components** — `SessionList` (session cards), `Timeline` (vertical node list), `TimelineNode` (expandable node with type-colored icons), `SuggestionButtons` (3 AI-generated next steps), `PromptInput` (free text input).
- **API Client** — `lib/api.ts` fetches from `/api/*` which Next.js rewrites to `localhost:3001`.

### Data Flow

```
~/.claude/projects/*/*.jsonl → Backend (JSONL Parser) → REST API → Frontend (Timeline)
                                         ↑
              claude --resume -p ← CLI Runner ← POST /run or /suggest
```

## Conventions

- Backend uses Node16 module resolution with `.js` extensions in imports.
- Frontend uses `@/*` path alias mapping to `./src/*`.
- Backend ESLint: root `eslint.config.mjs` with `typescript-eslint`.
- All frontend components are client components (`"use client"`).
- Dark theme with custom color tokens (bg-primary, accent-blue, etc.) defined in tailwind.config.ts.
- Next.js config is `.mjs` (not `.ts`) for Next.js 14 compatibility.

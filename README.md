# ClawUI (Agent Cockpit)

Real-time monitoring and interaction dashboard for CLI-based AI agents (Claude Code, OpenClaw) via the AG-UI protocol.

## Architecture

```
┌─────────────────┐    WebSocket     ┌─────────────────┐
│  Adapter Layer   │◄───────────────►│ Presentation Layer│
│  (Node.js)       │   AG-UI Events  │  (Next.js PWA)   │
│                  │                 │                  │
│ • ProcessManager │                 │ • Dashboard      │
│ • StreamIntercept│                 │ • Session Detail │
│ • ProtocolXlate  │                 │ • A2UI Renderer  │
│ • WS Server      │  HumanAction   │ • Zustand Store  │
└─────────────────┘◄────────────────└─────────────────┘
```

## Tech Stack

- **Adapter**: Node.js, TypeScript, node-pty, ws
- **Web**: Next.js 16, React 19, Tailwind CSS 4, Zustand 5, shadcn/ui, next-pwa
- **Monorepo**: npm workspaces (`packages/adapter`, `packages/web`)

## Quick Start

```bash
# Install dependencies
npm install

# Start mock WebSocket server (port 4800)
npm run mock

# In another terminal, start the web dashboard
npm run dev:web
# Open http://localhost:3000
```

## Commands

```bash
npm run build              # Build adapter (TypeScript → dist/)
npm run mock               # Build + start mock WS server on port 4800
npm run dev:web            # Start Next.js dev server
npm run lint               # Lint adapter (eslint.config.mjs)
npm run lint --workspace=packages/web  # Lint web package
npm run build --workspace=packages/web # Production web build
npm run clean              # Remove all dist/ directories
```

## AG-UI Protocol

**Events** (adapter → frontend): `RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `STEP_STARTED`, `WAITING_FOR_HUMAN`, `RUN_FINISHED`

**Actions** (frontend → adapter): `APPROVE`, `REJECT`, `PROVIDE_INPUT`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `4800` | Adapter WebSocket server port |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:4800` | Web app WebSocket endpoint |

## Status

🚧 In Development

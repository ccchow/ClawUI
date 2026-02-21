# ClawUI (Agent-Cockpit MVP)

为高强度并行运行的命令行/本地 Agent (Claude Code, OpenClaw) 提供基于 AG-UI 协议的云端适配层和 Web/移动端展示层。

## Architecture

```
┌─────────────────┐    WebSocket    ┌─────────────────┐
│  Adapter Layer   │◄──────────────►│Presentation Layer│
│  (Cloud Host)    │   AG-UI Events │   (Web/Mobile)   │
│                  │                │                  │
│ • Process Mgmt   │                │ • State Viewer   │
│ • Stream Intercept│               │ • A2UI Renderer  │
│ • Protocol Xlate │                │ • Command Input  │
└─────────────────┘                └─────────────────┘
```

## Tech Stack

- **Adapter**: Node.js (TypeScript), child_process, WebSocket
- **Presentation**: TBD (React/Next.js)

## Status

🚧 In Development

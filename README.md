![CI](https://github.com/ccchow/ClawUI/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

# ClawUI: The Visual Orchestrator for Claude Code

> **Turn your linear Claude Code CLI into a macro-planning Node Graph.**

ClawUI is a next-generation visual dashboard and orchestration engine for Claude Code. It solves the biggest pain points of complex AI coding tasks: context window explosion and terminal scroll fatigue.

By upgrading your CLI experience with a **Blueprint DAG (Directed Acyclic Graph) System** and **Proactive Next Actions**, ClawUI transforms Claude Code from a simple chat interface into an autonomous, long-term project manager.

## Screenshots

| Blueprint List | Task Node List |
|---|---|
| ![Blueprint List](docs/images/blueprint-list.png) | ![Task Node List](docs/images/task-node-list.png) |

| Task Node Detail | Claude Code Session |
|---|---|
| ![Task Node Detail](docs/images/task-node.png) | ![Claude Code Session](docs/images/claude-code-session.png) |

## ✨ Why ClawUI?

* **🗺️ From Terminal to DAG:** Stop scrolling through endless terminal logs. ClawUI visualizes your macro-plans as a node graph. Let Claude plan the architecture, and execute it node-by-node.
* **⚡ Proactive Copilot:** Whenever a session pauses, ClawUI predicts your next moves. Click one of the 3 AI-generated suggestion buttons to inject commands directly into the CLI—no typing required.
* **🧩 Context Boundary Control:** Execute nodes in dependency order. Artifacts from completed nodes are automatically passed downstream, perfectly isolating context and preventing LLM hallucinations.
* **🔒 100% Local & Secure:** ClawUI sits directly on top of your local `~/.claude/` directory. No external cloud relays, no code leaving your machine (other than standard Anthropic API calls).

---

## 🚀 Core Features

### 1. AI-Powered Planning — From Idea to DAG

ClawUI's planning phase turns a one-line goal into a fully structured, dependency-aware execution plan:

```text
Your Goal ──► Smart Task Creation ──► Dependency Selection ──► DAG Blueprint
  "Add auth"     AI generates nodes      AI wires dependencies     Ready to execute
                 with grounded specs      between related nodes     node by node
```

* **Smart Task Creation** — Describe a high-level goal (e.g., *"add OAuth login"*). Claude Code analyzes your actual codebase — reading `CLAUDE.md`, existing code, and project structure — then generates concrete, implementation-ready task nodes with file paths, function signatures, and acceptance criteria. Every node is *grounded* in the real code, not generic boilerplate.
* **Smart Dependency Selection** — AI analyzes each node's scope to automatically wire dependency edges. A one-click sparkle button lets you re-run dependency analysis on any node at any time.
* **Smart Task Decomposition** — Any node that's too large can be *split* into 2-3 sub-nodes via AI decomposition. The original node is replaced in the DAG; downstream edges are automatically rewired to the last sub-node. The result is a clean DAG Blueprint ready for sequential or parallel execution.

### 2. Autonomous Execution — Self-Healing Task Graph

Once a Blueprint is approved, ClawUI executes each node in dependency order with full AI autonomy:

```text
Node Queued ──► Claude Code Session ──► Post-Completion Eval ──► Next Node
                 Isolated context          AI inspects result
                 Artifact handoff          ├─ COMPLETE → continue
                                           ├─ NEEDS_REFINEMENT → insert follow-up node
                                           └─ HAS_BLOCKER → insert blocker sibling
```

* **Grounded Execution Context** — Each node runs in its own Claude Code session. The prompt is built from the node's spec plus *handoff artifacts* (structured summaries) from all upstream dependencies — no raw output dumping, no context pollution.
* **Post-Completion Evaluation** — After a node finishes, AI evaluates whether the work is truly complete. Three outcomes: **COMPLETE** (advance to next node), **NEEDS_REFINEMENT** (auto-insert a follow-up node between this node and its dependents), or **HAS_BLOCKER** (create a blocker sibling that must be resolved first). The task graph *mutates itself* at runtime.
* **Smart Retry & Session Resume** — Failed nodes can be resumed in-place: ClawUI reopens the *same* Claude Code session with full prior context, sends a lightweight continuation prompt, and lets Claude pick up where it left off. No wasted tokens re-explaining the task.
* **Run All** — One click queues every eligible node. Nodes execute in dependency order; if any node fails, downstream nodes are held and the graph pauses for human review.

### 3. Session Timeline — Full Observability

Every Claude Code interaction — whether triggered by a Blueprint node or run manually — is captured as a rich, interactive timeline:

* **Structured I/O** — Collapsible views for Bash commands, file edits, reads, and MCP tool calls. Each tool invocation is paired with its result.
* **Proactive Suggestions** — When a session pauses, AI analyzes the output and proposes the top 3 next actions as one-click buttons.
* **Session Management** — Star, tag, search, and filter across your entire Claude Code history. Sessions are grouped by project and linked back to their Blueprint nodes.

---

## 🛠 Quick Start

### Prerequisites

* **Node.js 20+** and **npm 10+**
* **Claude Code CLI** installed globally
* **macOS or Linux** (requires `/usr/bin/expect` for TTY wrapping)

### Installation

```bash
# Clone the repository and install dependencies
git clone https://github.com/ccchow/ClawUI.git
cd ClawUI
npm install

# Start the full stack (Express backend :3001 + Next.js frontend :3000)
npm run dev

```

Open the secure URL printed in the terminal to access your dashboard (includes an auth token).

---

## 🏗 System Architecture

ClawUI operates on a highly optimized, non-intrusive 4-layer data architecture that treats your native Claude logs as the single source of truth.

```text
~/.claude/projects/**/*.jsonl     <- Layer 1: Raw Source (Read-only single source of truth)
        |
.clawui/index.db (SQLite)         <- Layer 2: Ultra-fast Index/Cache (Incremental sync)
.clawui/enrichments.json          <- Layer 3: User Meta (Stars, tags, bookmarks)
.clawui/app-state.json            <- Layer 4: UI Preferences
        |
Backend (Express :3001)           -> REST API & Process Manager
        |
Frontend (Next.js :3000)          -> DAG UI & Timeline Controller

```

*Delete the `.clawui/` directory anytime to reset. Layer 2 automatically rebuilds from your raw JSONL files in seconds.* 👉 Dive deeper into our [Four-Layer Data Model](docs/DATA-MODEL.md) and [Blueprint System Design](docs/PLAN-SYSTEM.md).

---

## 🔌 API Reference

ClawUI exposes a robust REST API for both Session monitoring and Blueprint execution.
*(Expand to view core endpoints)*

<details>
<summary><b>Session & Node APIs</b></summary>

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/projects` | List all Claude Code projects |
| GET | `/api/sessions/:id/timeline` | Parse session into rich timeline nodes |
| POST | `/api/sessions/:id/run` | Execute prompt, returns `{ output, suggestions }` |
| POST | `/api/blueprints/:id/generate` | AI-generate nodes from description |
| POST | `/api/blueprints/:id/nodes/:nodeId/run` | Execute a single node in a dedicated session |

</details>

## Security

ClawUI enforces a **dual-layer isolation** model to protect your machine:

### Network Layer — Localhost Lockdown

Both the backend (Express :3001) and frontend (Next.js :3000) bind exclusively to `127.0.0.1`. Direct connections from other devices on your LAN are refused at the TCP level. Remote access (e.g., from a phone or tablet) is handled by running `tailscale serve` as an external reverse proxy — ClawUI itself never listens on `0.0.0.0`.

### Application Layer — Local Auth Token

On every backend startup, a cryptographically random token is generated and written to `.clawui/auth-token`. All `/api/*` requests must include this token via the `x-clawui-token` header (or `?auth=` query param for initial browser access). The token rotates on each restart.

```text
# The terminal prints a secure URL on startup:
========================================================
  ClawUI Secure Dashboard Ready
  Local:     http://localhost:3000
  Tailscale: http://<your-tailscale-ip>:3000/?auth=<token>
========================================================
```

On first visit, the frontend extracts the token from the URL, stores it in `localStorage`, and strips the parameter from the address bar.

### Other Notes

- **`--dangerously-skip-permissions` flag**: Claude Code requires this flag for non-interactive (programmatic) use. ClawUI passes it automatically when executing prompts via `claude --resume`. This is a Claude Code requirement, not a ClawUI design choice.
- **CORS** is locked to `http://127.0.0.1:3000` — only the local frontend origin is allowed.
- **Tailscale recommended** for remote access. Run `tailscale serve --bg 3000` to securely expose the dashboard to your Tailnet.

## 🔮 Coming Soon

- **OpenClaw/Pi Support** — A standardized, open protocol for agent orchestration UIs to communicate with any coding agent backend. Decouple the frontend from Claude Code specifics so ClawUI (and other tools) can orchestrate any LLM-powered coding agent.

## 🤝 Contributing

**ClawUI is a project that can serve as its own development environment.** Point ClawUI at this repo as a Blueprint workspace, and you can build new features, fix bugs, and submit patches — all from a browser on your desktop or phone, orchestrated by Claude Code through the very UI you're improving.

This makes contributing uniquely accessible:

1. **Fork & clone** the repo, run `npm install && npm run dev`
2. **Create a Blueprint** in ClawUI with your repo path as the workspace
3. **Describe what you want to build** — ClawUI decomposes it into executable nodes
4. **Watch Claude Code implement it**, node by node, with full context isolation
5. **Review the results** in the Timeline viewer, then open a PR

No deep familiarity with the codebase required to get started — the Blueprint system gives Claude Code the structure it needs to navigate the architecture on its own.

See [CONTRIBUTING.md](CONTRIBUTING.md) for code style, dev/stable environment setup, and PR guidelines.

## 📄 License

MIT License (c) 2025-2026. See [LICENSE](LICENSE) for details.
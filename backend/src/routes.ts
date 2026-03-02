import { Router } from "express";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { getSessionCwd } from "./jsonl-parser.js";
import { runPrompt, validateSessionId } from "./cli-runner.js";
import { acquireSessionLock, releaseSessionLock, isSessionRunning } from "./session-lock.js";
import { getProjects, getSessions, getTimeline, getLastMessage, syncAll, syncSession, getAvailableAgents, getSessionAgentType, getSessionCwdFromDb } from "./db.js";
import { getEnrichments, updateSessionMeta, updateNodeMeta, getAllTags } from "./enrichment.js";
import type { AgentType } from "./agent-runtime.js";
import { getRegisteredRuntimes, getRuntimeByType } from "./agent-runtime.js";
// Side-effect imports: ensure all agent runtimes are registered before getRegisteredRuntimes() is called
import "./agent-claude.js";
import "./agent-pimono.js";
import "./agent-openclaw.js";
import "./agent-codex.js";
import { getAppState, updateAppState, trackSessionView } from "./app-state.js";
import type { SessionEnrichment, NodeEnrichment } from "./enrichment.js";
import { createLogger } from "./logger.js";
import { CLAWUI_DEV } from "./config.js";
import { getNodeInfoForSessions } from "./plan-db.js";
import { getAllRoles, getRole } from "./roles/role-registry.js";
// Side-effect imports: ensure all roles are registered before getAllRoles()/getRole() is called
import "./roles/role-sde.js";
import "./roles/role-qa.js";
import "./roles/role-pm.js";

const log = createLogger("routes");

/** Return a sanitized error message for API responses (no stack traces or internal paths). */
function safeError(err: unknown): string {
  if (err instanceof Error && err.message.includes("Invalid session ID")) return err.message;
  if (err instanceof Error && err.message.includes("Missing or empty")) return err.message;
  return "Internal server error";
}

const router = Router();

// GET /api/projects — list projects, optionally filtered by agent type
// ?agent=claude|openclaw|pi (default: all)
router.get("/api/projects", (req, res) => {
  try {
    const agentParam = req.query.agent as string | undefined;
    const agentType = agentParam && agentParam !== "all" ? agentParam as AgentType : undefined;
    const projects = getProjects(agentType);
    res.json(projects);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/projects/:id/sessions — list sessions with enrichment data merged in
// ?agent=claude|openclaw|pi (default: all)
router.get("/api/projects/:id/sessions", (req, res) => {
  try {
    const agentParam = req.query.agent as string | undefined;
    const agentType = agentParam && agentParam !== "all" ? agentParam as AgentType : undefined;
    const sessions = getSessions(req.params.id as string, agentType);
    const enrichments = getEnrichments();

    // Apply query filters
    const starredFilter = req.query.starred;
    const tagFilter = req.query.tag as string | undefined;
    const archivedParam = req.query.archived as string | undefined;
    // Default: hide archived unless explicitly requested
    const showArchived = archivedParam === "true";

    // Batch lookup macro node info for all sessions
    const sessionIds = sessions.map((s) => s.sessionId);
    const nodeInfoMap = getNodeInfoForSessions(sessionIds);

    const enriched = sessions
      .map((s) => {
        const meta = enrichments.sessions[s.sessionId] as SessionEnrichment | undefined;
        const nodeInfo = nodeInfoMap.get(s.sessionId);
        return {
          ...s,
          starred: meta?.starred ?? false,
          tags: meta?.tags ?? [],
          alias: meta?.alias,
          notes: meta?.notes,
          archived: meta?.archived ?? false,
          ...(nodeInfo ? {
            macroNodeTitle: nodeInfo.nodeTitle,
            macroNodeDescription: nodeInfo.nodeDescription,
            macroNodeBlueprintId: nodeInfo.blueprintId,
          } : {}),
        };
      })
      .filter((s) => {
        // Filter archived
        if (!showArchived && s.archived) return false;
        // Filter starred
        if (starredFilter === "true" && !s.starred) return false;
        // Filter by tag
        if (tagFilter && !s.tags.includes(tagFilter)) return false;
        return true;
      });

    res.json(enriched);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/sessions/:id/timeline — get cached timeline nodes from SQLite
router.get("/api/sessions/:id/timeline", (req, res) => {
  try {
    // Sync this session before reading (picks up any new data)
    syncSession(req.params.id as string);

    // Track this session view in app state
    trackSessionView(req.params.id as string);

    const nodes = getTimeline(req.params.id as string);
    if (nodes.length === 0) {
      res.status(404).json({ error: "Session not found or empty" });
      return;
    }

    // Merge node enrichments (bookmarks, annotations) from enrichments.json
    const enrichments = getEnrichments();
    for (const node of nodes) {
      const enrichment = enrichments.nodes[node.id];
      if (enrichment) {
        if (enrichment.bookmarked !== undefined) node.bookmarked = enrichment.bookmarked;
        if (enrichment.annotation !== undefined) node.annotation = enrichment.annotation;
      }
    }

    res.json(nodes);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/sessions/:id/last-message — get only the most recent timeline node (lightweight polling)
router.get("/api/sessions/:id/last-message", (req, res) => {
  try {
    syncSession(req.params.id as string);
    const lastMessage = getLastMessage(req.params.id as string);
    if (!lastMessage) {
      res.status(404).json({ error: "No messages found in session" });
      return;
    }
    res.json(lastMessage);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/sync — trigger manual re-sync
router.get("/api/sync", (_req, res) => {
  try {
    const start = Date.now();
    syncAll();
    const elapsed = Date.now() - start;
    res.json({ ok: true, elapsed_ms: elapsed });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/sessions/:id/run — execute a prompt and get suggestions in one call
// Dispatches through the correct AgentRuntime based on the session's agent type.
router.post("/api/sessions/:id/run", async (req, res) => {
  const sessionId = req.params.id as string;
  try {
    validateSessionId(sessionId);
    const { prompt } = req.body as { prompt?: string };
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'prompt' in request body" });
      return;
    }
    if (prompt.length > 10_000) {
      res.status(400).json({ error: "Prompt too long (max 10000 chars)" });
      return;
    }

    // Per-session lock: prevent concurrent runs on the same session
    if (!acquireSessionLock(sessionId)) {
      res.status(409).json({ error: "Session is already running" });
      return;
    }

    try {
      // Resolve the agent runtime for this session
      const agentType: AgentType = getSessionAgentType(sessionId) ?? "claude";
      const runtimes = getRegisteredRuntimes();
      const factory = runtimes.get(agentType) ?? runtimes.get("claude");
      if (!factory) {
        if (!res.writableEnded) res.status(500).json({ error: `No agent runtime available for type "${agentType}"` });
        return;
      }
      const runtime = factory();

      if (!runtime.capabilities.supportsResume) {
        if (!res.writableEnded) res.status(400).json({ error: `Agent type "${agentType}" does not support session resume` });
        return;
      }

      // Get CWD from DB (works for all agent types) with fallback to Claude-specific resolver
      const cwd = getSessionCwdFromDb(sessionId) ?? getSessionCwd(sessionId);
      const { output, suggestions } = await runPrompt(sessionId, prompt.trim(), cwd, runtime);

      // Re-sync this session after running a prompt (new data in JSONL)
      syncSession(sessionId);

      // Guard: response may have been destroyed by socket timeout during the long CLI run
      if (!res.writableEnded) {
        res.json({ output, suggestions });
      } else {
        log.warn(`POST /api/sessions/${sessionId.slice(0, 8)}/run: response already closed (client timeout?), discarding output`);
      }
    } finally {
      releaseSessionLock(sessionId);
    }
  } catch (err) {
    log.error(`POST /api/sessions/:id/run failed: ${String(err)}`);
    if (!res.writableEnded) {
      res.status(500).json({ error: safeError(err) });
    }
  }
});

// GET /api/sessions/:id/status — lightweight check if a session has an active run
router.get("/api/sessions/:id/status", (req, res) => {
  try {
    const sessionId = req.params.id as string;
    res.json({ running: isSessionRunning(sessionId) });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Enrichment API (Layer 3) ─────────────────────────────────

// GET /api/sessions/:id/meta — read session enrichment + agent type
router.get("/api/sessions/:id/meta", (req, res) => {
  try {
    const sessionId = req.params.id as string;
    const enrichments = getEnrichments();
    const meta = enrichments.sessions[sessionId];
    const agentType = getSessionAgentType(sessionId);
    res.json({ ...(meta ?? {}), ...(agentType ? { agentType } : {}) });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// PATCH /api/sessions/:id/meta — update session enrichment
router.patch("/api/sessions/:id/meta", (req, res) => {
  try {
    const patch = req.body as Partial<SessionEnrichment>;
    const result = updateSessionMeta(req.params.id as string, patch);
    res.json(result);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// PATCH /api/nodes/:id/meta — update node enrichment
router.patch("/api/nodes/:id/meta", (req, res) => {
  try {
    const patch = req.body as Partial<NodeEnrichment>;
    const result = updateNodeMeta(req.params.id as string, patch);
    res.json(result);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/tags — list all tags
router.get("/api/tags", (_req, res) => {
  try {
    const tags = getAllTags();
    res.json(tags);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── App State API (Layer 4) ──────────────────────────────────

// GET /api/state — get app state
router.get("/api/state", (_req, res) => {
  try {
    const state = getAppState();
    res.json(state);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// PUT /api/state — update app state
router.put("/api/state", (req, res) => {
  try {
    const patch = req.body as Record<string, unknown>;
    const state = updateAppState(patch);
    res.json(state);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Dev Tools ──────────────────────────────────────────────

// GET /api/dev/status — returns dev mode flag
router.get("/api/dev/status", (_req, res) => {
  res.json({ devMode: CLAWUI_DEV });
});

// POST /api/dev/redeploy — build and restart stable environment (dev mode only)
router.post("/api/dev/redeploy", (_req, res) => {
  if (!CLAWUI_DEV) {
    res.status(403).json({ error: "Dev mode not enabled" });
    return;
  }
  const projectRoot = join(process.cwd(), "..");
  const deployScript = join(projectRoot, "scripts", "deploy-stable.mjs");
  const startScript = join(projectRoot, "scripts", "start-stable.mjs");

  log.info("Dev redeploy: starting deploy-stable.mjs + start-stable.mjs");

  // Run deploy first (blocking — build must finish before restart)
  execFile("node", [deployScript], { cwd: projectRoot, timeout: 120_000 }, (deployErr, deployStdout, deployStderr) => {
    if (deployErr) {
      log.error(`Deploy failed: ${deployErr.message}`);
      res.status(500).json({ error: "Deploy failed", details: safeError(deployStderr || deployErr.message) });
      return;
    }
    log.info(`Deploy output: ${deployStdout.trim()}`);

    // Start stable in detached mode so it survives this process
    const child = spawn("node", [startScript], {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    res.json({ status: "redeployed" });
    log.info("Stable environment restart triggered");
  });
});

// GET /api/sessions/:id/health — analyze session context health
// Dispatches through the correct AgentRuntime based on the session's agent type
router.get("/api/sessions/:id/health", (req, res) => {
  try {
    const sessionId = req.params.id as string;
    const agentType: AgentType = getSessionAgentType(sessionId) ?? "claude";
    const runtime = getRuntimeByType(agentType);

    if (!runtime) {
      res.status(500).json({ error: `No agent runtime available for type "${agentType}"` });
      return;
    }

    const analysis = runtime.analyzeSessionHealth(sessionId);

    if (!analysis) {
      res.status(404).json({ error: "Session file not found" });
      return;
    }
    res.json(analysis);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Agent Discovery ────────────────────────────────────────────

// GET /api/agents — list available agent runtimes with session counts
router.get("/api/agents", (_req, res) => {
  try {
    const agents = getAvailableAgents();
    res.json(agents);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Role Discovery ──────────────────────────────────────────

// GET /api/roles — list all registered roles (prompts stripped)
router.get("/api/roles", (_req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const roles = getAllRoles().map(({ prompts, ...rest }) => rest);
    res.json(roles);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/roles/:id — get full role definition including prompts
router.get("/api/roles/:id", (req, res) => {
  try {
    const role = getRole(req.params.id);
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    res.json(role);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

export default router;

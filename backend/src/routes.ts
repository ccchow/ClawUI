import { Router } from "express";
import { getSessionCwd } from "./jsonl-parser.js";
import { runPrompt } from "./cli-runner.js";
import { getProjects, getSessions, getTimeline, syncAll, syncSession } from "./db.js";
import { getEnrichments, updateSessionMeta, updateNodeMeta, getAllTags } from "./enrichment.js";
import { getAppState, updateAppState, trackSessionView } from "./app-state.js";
import type { SessionEnrichment, NodeEnrichment } from "./enrichment.js";

const router = Router();

// GET /api/projects — list all Claude Code projects
router.get("/api/projects", (_req, res) => {
  try {
    const projects = getProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/projects/:id/sessions — list sessions with enrichment data merged in
router.get("/api/projects/:id/sessions", (req, res) => {
  try {
    const sessions = getSessions(req.params.id as string);
    const enrichments = getEnrichments();

    // Apply query filters
    const starredFilter = req.query.starred;
    const tagFilter = req.query.tag as string | undefined;
    const archivedParam = req.query.archived as string | undefined;
    // Default: hide archived unless explicitly requested
    const showArchived = archivedParam === "true";

    const enriched = sessions
      .map((s) => {
        const meta = enrichments.sessions[s.sessionId] as SessionEnrichment | undefined;
        return {
          ...s,
          starred: meta?.starred ?? false,
          tags: meta?.tags ?? [],
          alias: meta?.alias,
          notes: meta?.notes,
          archived: meta?.archived ?? false,
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
    res.status(500).json({ error: String(err) });
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
    res.json(nodes);
  } catch (err) {
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/sessions/:id/run — execute a prompt and get suggestions in one call
router.post("/api/sessions/:id/run", async (req, res) => {
  const sessionId = req.params.id as string;
  try {
    const { prompt } = req.body as { prompt?: string };
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'prompt' in request body" });
      return;
    }
    if (prompt.length > 10_000) {
      res.status(400).json({ error: "Prompt too long (max 10000 chars)" });
      return;
    }
    const cwd = getSessionCwd(sessionId);
    const { output, suggestions } = await runPrompt(sessionId, prompt.trim(), cwd);

    // Re-sync this session after running a prompt (new data in JSONL)
    syncSession(sessionId);

    res.json({ output, suggestions });
  } catch (err) {
    console.error("POST /api/sessions/:id/run failed:", String(err));
    res.status(500).json({ error: String(err) });
  }
});

// ─── Enrichment API (Layer 3) ─────────────────────────────────

// PATCH /api/sessions/:id/meta — update session enrichment
router.patch("/api/sessions/:id/meta", (req, res) => {
  try {
    const patch = req.body as Partial<SessionEnrichment>;
    const result = updateSessionMeta(req.params.id as string, patch);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH /api/nodes/:id/meta — update node enrichment
router.patch("/api/nodes/:id/meta", (req, res) => {
  try {
    const patch = req.body as Partial<NodeEnrichment>;
    const result = updateNodeMeta(req.params.id as string, patch);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/tags — list all tags
router.get("/api/tags", (_req, res) => {
  try {
    const tags = getAllTags();
    res.json(tags);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── App State API (Layer 4) ──────────────────────────────────

// GET /api/state — get app state
router.get("/api/state", (_req, res) => {
  try {
    const state = getAppState();
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/state — update app state
router.put("/api/state", (req, res) => {
  try {
    const patch = req.body as Record<string, unknown>;
    const state = updateAppState(patch);
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;

import { Router } from "express";
import { listProjects, listSessions, parseTimeline, getSessionCwd } from "./jsonl-parser.js";
import { runPrompt } from "./cli-runner.js";

const router = Router();

// GET /api/projects — list all Claude Code projects
router.get("/api/projects", (_req, res) => {
  try {
    const projects = listProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/projects/:id/sessions — list sessions for a project
router.get("/api/projects/:id/sessions", (req, res) => {
  try {
    const sessions = listSessions(req.params.id as string);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/sessions/:id/timeline — parse session into timeline nodes
router.get("/api/sessions/:id/timeline", (req, res) => {
  try {
    const nodes = parseTimeline(req.params.id as string);
    if (nodes.length === 0) {
      res.status(404).json({ error: "Session not found or empty" });
      return;
    }
    res.json(nodes);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/sessions/:id/run — execute a prompt and get suggestions in one call
router.post("/api/sessions/:id/run", async (req, res) => {
  const sessionId = req.params.id as string;
  const start = Date.now();
  console.log(`[RUN] ← POST /api/sessions/${sessionId.slice(0, 8)}/run`);
  try {
    const { prompt } = req.body as { prompt?: string };
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      console.log(`[RUN] ✗ Empty prompt`);
      res.status(400).json({ error: "Missing or empty 'prompt' in request body" });
      return;
    }
    if (prompt.length > 10_000) {
      console.log(`[RUN] ✗ Prompt too long: ${prompt.length}`);
      res.status(400).json({ error: "Prompt too long (max 10000 chars)" });
      return;
    }
    const cwd = getSessionCwd(sessionId);
    console.log(`[RUN] cwd=${cwd || "default"}, promptLen=${prompt.trim().length}, prompt="${prompt.trim().slice(0, 200)}"`);
    console.log(`[RUN] Executing claude --resume ${sessionId.slice(0, 8)}...`);
    
    const { output, suggestions } = await runPrompt(sessionId, prompt.trim(), cwd);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    
    console.log(`[RUN] ✓ Done in ${elapsed}s | output=${output.length} chars | suggestions=${suggestions.length}`);
    if (output.length > 0) console.log(`[RUN] Preview: ${output.slice(0, 100)}`);
    
    res.json({ output, suggestions });
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`[RUN] ✗ Failed in ${elapsed}s:`, String(err).slice(0, 200));
    res.status(500).json({ error: String(err) });
  }
});

export default router;

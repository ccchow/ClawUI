import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { CLAWUI_DB_DIR } from "./config.js";

const log = createLogger("enrichment");

const CLAWUI_DIR = CLAWUI_DB_DIR;
const ENRICHMENTS_PATH = join(CLAWUI_DIR, "enrichments.json");

export interface SessionEnrichment {
  starred?: boolean;
  tags?: string[];
  notes?: string;
  alias?: string;
  archived?: boolean;
}

export interface NodeEnrichment {
  bookmarked?: boolean;
  annotation?: string;
}

export interface EnrichmentsData {
  version: 1;
  sessions: Record<string, SessionEnrichment>;
  nodes: Record<string, NodeEnrichment>;
  tags: string[];
}

function defaultEnrichments(): EnrichmentsData {
  return { version: 1, sessions: {}, nodes: {}, tags: [] };
}

export function getEnrichments(): EnrichmentsData {
  if (!existsSync(ENRICHMENTS_PATH)) {
    log.debug("Enrichments file not found, using defaults");
    return defaultEnrichments();
  }
  try {
    log.debug(`Reading enrichments from ${ENRICHMENTS_PATH}`);
    return JSON.parse(readFileSync(ENRICHMENTS_PATH, "utf-8")) as EnrichmentsData;
  } catch {
    log.warn("Failed to parse enrichments file, using defaults");
    return defaultEnrichments();
  }
}

function saveEnrichments(data: EnrichmentsData): void {
  if (!existsSync(CLAWUI_DIR)) mkdirSync(CLAWUI_DIR, { recursive: true });
  log.debug(`Writing enrichments to ${ENRICHMENTS_PATH}`);
  writeFileSync(ENRICHMENTS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function updateSessionMeta(id: string, patch: Partial<SessionEnrichment>): SessionEnrichment {
  const data = getEnrichments();
  const existing = data.sessions[id] || {};
  const merged = { ...existing, ...patch };

  // Remove keys set to undefined/null
  for (const key of Object.keys(merged) as (keyof SessionEnrichment)[]) {
    if (merged[key] === undefined || merged[key] === null) {
      delete merged[key];
    }
  }

  data.sessions[id] = merged;

  // If tags were added, ensure they're in the global tags list
  if (patch.tags) {
    const tagSet = new Set(data.tags);
    for (const tag of patch.tags) tagSet.add(tag);
    data.tags = [...tagSet].sort();
  }

  saveEnrichments(data);
  return merged;
}

export function updateNodeMeta(id: string, patch: Partial<NodeEnrichment>): NodeEnrichment {
  const data = getEnrichments();
  const existing = data.nodes[id] || {};
  const merged = { ...existing, ...patch };

  for (const key of Object.keys(merged) as (keyof NodeEnrichment)[]) {
    if (merged[key] === undefined || merged[key] === null) {
      delete merged[key];
    }
  }

  data.nodes[id] = merged;
  saveEnrichments(data);
  return merged;
}

export function getAllTags(): string[] {
  return getEnrichments().tags;
}

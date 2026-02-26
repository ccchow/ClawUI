import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock fs so token file write doesn't hit disk
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

import { requireLocalAuth, LOCAL_AUTH_TOKEN } from "../auth.js";

describe("auth", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(requireLocalAuth);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));
  });

  it("generates a 32-char hex token", () => {
    expect(LOCAL_AUTH_TOKEN).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects requests without token with 403", async () => {
    const res = await request(app).get("/api/test");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
  });

  it("accepts requests with valid x-clawui-token header", async () => {
    const res = await request(app)
      .get("/api/test")
      .set("x-clawui-token", LOCAL_AUTH_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("accepts requests with valid ?auth= query param", async () => {
    const res = await request(app).get(`/api/test?auth=${LOCAL_AUTH_TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("rejects requests with invalid token", async () => {
    const res = await request(app)
      .get("/api/test")
      .set("x-clawui-token", "wrong-token");
    expect(res.status).toBe(403);
  });

  it("skips auth for non-/api/ paths", async () => {
    app = express();
    app.use(requireLocalAuth);
    app.get("/health", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});

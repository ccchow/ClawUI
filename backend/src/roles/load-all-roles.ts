/**
 * Dynamic role loader — auto-discovers and imports all role-*.ts modules
 * in this directory. Each role module self-registers via registerRole() as
 * a side-effect of being imported.
 *
 * Usage: `import "./roles/load-all-roles.js";` — replaces individual
 * side-effect imports of each role module. Adding a new role is just:
 * create `roles/role-<id>.ts`, done.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

const roleFiles = readdirSync(__dir)
  .filter(
    (f) =>
      f.startsWith("role-") &&
      !f.startsWith("role-registry") &&
      (f.endsWith(".ts") || f.endsWith(".js")) &&
      !f.endsWith(".d.ts") &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".map"),
  )
  .map((f) => `./${f.replace(/\.ts$/, ".js")}`);

await Promise.all(roleFiles.map((f) => import(f)));

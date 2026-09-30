import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

/** The client talks to the server only through `MagentaServer`. Live server
 * objects may be constructed/imported only by the composition root. */
const ALLOWED = new Set(["in-process-server.ts"]);
const FORBIDDEN_NAMES = new Set([
  "Session",
  "Thread",
  "ThreadCore",
  "ThreadCompactor",
  "ScriptManager",
  "FileSupervisor",
  "ToolInvocation",
]);
const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']*["']/g;
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}
function importsForbidden(source: string): boolean {
  for (const match of source.matchAll(IMPORT)) {
    for (const spec of match[1].split(",")) {
      const name = spec
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0];
      if (FORBIDDEN_NAMES.has(name)) return true;
    }
  }
  return false;
}
it("nvimclient imports live server objects only in the composition root", () => {
  const root = import.meta.dirname;
  const files = sources(root);
  expect(files.length).toBeGreaterThan(50);
  const importers = files
    .filter((path) => importsForbidden(readFileSync(path, "utf8")))
    .map((path) => relative(root, path));
  expect(importers.filter((path) => !ALLOWED.has(path))).toEqual([]);
  expect(importers.filter((path) => ALLOWED.has(path)).sort()).toEqual(
    [...ALLOWED].sort(),
  );
});

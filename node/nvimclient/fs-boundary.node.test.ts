import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

/** Filesystem and process execution are server-owned. The client may only
 * touch the fs to open files in the editor and read its bundled logo. */
const ALLOWED = new Set(["open-target-under-cursor.ts", "chat/thread-view.ts"]);
const FORBIDDEN =
  /(?:from\s+|import\s*\(\s*|require\(\s*)["'](?:node:)?(?:fs|fs\/promises|child_process)["']/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

it("nvimclient does not import fs or child_process outside the allowlist", () => {
  const root = import.meta.dirname;
  const files = sources(root);
  expect(files.length).toBeGreaterThan(50);
  const importers = files
    .filter((path) => FORBIDDEN.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path));
  expect(importers.filter((path) => !ALLOWED.has(path))).toEqual([]);
  // Stale allowlist entries must be removed.
  expect(importers.filter((path) => ALLOWED.has(path)).sort()).toEqual(
    [...ALLOWED].sort(),
  );
});

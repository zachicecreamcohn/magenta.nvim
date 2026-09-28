import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Cwd, HomeDir } from "../utils/files.ts";
import { OptionsStore } from "./options-store.ts";

const logger = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

let root: string;
let cwd: Cwd;
let home: HomeDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "magenta-options-"));
  cwd = path.join(root, "project") as Cwd;
  home = path.join(root, "home") as HomeDir;
  fs.mkdirSync(path.join(cwd, ".magenta"), { recursive: true });
  fs.mkdirSync(path.join(home, ".magenta"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(dir: string, value: unknown, mtimeSeconds?: number) {
  const file = path.join(dir, ".magenta", "options.json");
  fs.writeFileSync(file, JSON.stringify(value));
  if (mtimeSeconds !== undefined) {
    fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
  }
}

it("is fully configured by ~/.magenta/options.json alone", () => {
  write(home, {
    profiles: [{ name: "only", provider: "mock" }],
    sandbox: { filesystem: { denyRead: [".private"] } },
    autoContext: [],
  });
  const options = new OptionsStore(home, logger).getOptions(cwd);
  expect(options.profiles.map((p) => p.name)).toEqual(["only"]);
  expect(options.activeProfile).toBe("only");
  expect(options.sandbox.filesystem.denyRead).toContain(".private");
  expect(options.sandbox.filesystem.denyRead).toContain("~/.ssh");
  expect(options.autoContext).toEqual([]);
});

it("uses built-in defaults when no options files exist", () => {
  fs.rmSync(path.join(home, ".magenta"), { recursive: true });
  const options = new OptionsStore(home, logger).getOptions(cwd);
  expect(options.profiles.length).toBeGreaterThan(0);
});

it("picks up edits to the project options.json on the next call", () => {
  const store = new OptionsStore(home, logger);
  expect(store.getOptions(cwd).sandbox.filesystem.denyRead).not.toContain(
    ".secret",
  );
  write(cwd, { sandbox: { filesystem: { denyRead: [".secret"] } } }, 1000);
  expect(store.getOptions(cwd).sandbox.filesystem.denyRead).toContain(
    ".secret",
  );
  write(cwd, { sandbox: { filesystem: { denyRead: [".other"] } } }, 2000);
  const denyRead = store.getOptions(cwd).sandbox.filesystem.denyRead;
  expect(denyRead).toContain(".other");
  expect(denyRead).not.toContain(".secret");
});

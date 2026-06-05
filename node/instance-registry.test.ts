import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InstanceEntry, readLiveInstances } from "./instance-registry.ts";

function entry(over: Partial<InstanceEntry>): InstanceEntry {
  return {
    pid: process.pid,
    cwd: "/tmp/project",
    title: "project",
    host: "127.0.0.1",
    port: 8765,
    startedAt: 1,
    heartbeatAt: Date.now(),
    ...over,
  };
}

function write(dir: string, name: string, content: unknown): void {
  writeFileSync(
    join(dir, name),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

// A pid that's essentially never live. Use a large value; process.kill(pid, 0)
// throws ESRCH for it.
const DEAD_PID = 2 ** 30;

describe("readLiveInstances", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "magenta-registry-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns only live entries, sorted by startedAt", () => {
    write(
      dir,
      `${process.pid}.json`,
      entry({ pid: process.pid, startedAt: 5 }),
    );
    // A second live entry sharing our pid (so pidAlive passes) but earlier.
    write(dir, "alive2.json", entry({ pid: process.pid, startedAt: 2 }));

    const live = readLiveInstances(dir);
    expect(live.map((e) => e.startedAt)).toEqual([2, 5]);
  });

  it("prunes dead-pid entries and removes their files", () => {
    write(dir, `${DEAD_PID}.json`, entry({ pid: DEAD_PID }));
    write(dir, `${process.pid}.json`, entry({ pid: process.pid }));

    const live = readLiveInstances(dir);
    expect(live).toHaveLength(1);
    expect(live[0].pid).toBe(process.pid);

    // Dead file should have been unlinked; a second read still returns 1.
    expect(readLiveInstances(dir)).toHaveLength(1);
  });

  it("prunes stale-heartbeat entries even when pid is alive", () => {
    write(
      dir,
      `${process.pid}.json`,
      entry({ pid: process.pid, heartbeatAt: Date.now() - 60_000 }),
    );

    expect(readLiveInstances(dir)).toHaveLength(0);
  });

  it("tolerates malformed json and .json.tmp files", () => {
    write(dir, "broken.json", "{not json");
    write(dir, "partial.json.tmp", entry({ pid: process.pid }));
    write(dir, `${process.pid}.json`, entry({ pid: process.pid }));

    const live = readLiveInstances(dir);
    expect(live).toHaveLength(1);
  });

  it("returns empty array for a missing directory", () => {
    expect(readLiveInstances(join(dir, "does-not-exist"))).toEqual([]);
  });
});

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { detectReachableHost } from "./utils/network.ts";

export { detectReachableHost };

const HEARTBEAT_MS = 5000;
const STALE_MS = 15000;

// One file per instance, named `<pid>.json`, written only by that instance via
// an atomic temp-write + rename. Readers tolerate missing/half-written files.
export type InstanceEntry = {
  pid: number;
  cwd: string;
  title: string;
  host: string;
  port: number;
  startedAt: number;
  heartbeatAt: number;
};

// XDG_RUNTIME_DIR (Linux, user-private) when available, else os.tmpdir() (the
// per-user dir on macOS). Subdir is created 0o700 since entries reveal cwds.
export function registryDir(): string {
  const base = process.env.XDG_RUNTIME_DIR ?? tmpdir();
  return join(base, "magenta", "instances");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM => the pid exists but is owned by another user; treat as alive.
    // ESRCH => no such process.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLive(entry: InstanceEntry): boolean {
  return pidAlive(entry.pid) && Date.now() - entry.heartbeatAt <= STALE_MS;
}

function entryFileName(pid: number): string {
  return `${pid}.json`;
}

// List + parse-tolerantly + prune dead entries (best-effort unlink) + sort by
// startedAt ascending. Safe to call from any instance; it only reads + prunes.
export function readLiveInstances(dir: string): InstanceEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const live: InstanceEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;

    const path = join(dir, name);
    let entry: InstanceEntry;
    try {
      entry = JSON.parse(readFileSync(path, "utf8")) as InstanceEntry;
    } catch {
      continue;
    }

    if (
      typeof entry.pid !== "number" ||
      typeof entry.port !== "number" ||
      typeof entry.heartbeatAt !== "number"
    ) {
      continue;
    }

    if (isLive(entry)) {
      live.push(entry);
    } else {
      try {
        unlinkSync(path);
      } catch {
        // already gone; ignore
      }
    }
  }

  live.sort((a, b) => a.startedAt - b.startedAt);
  return live;
}

export class InstanceRegistry {
  private dir = registryDir();
  private path: string;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private exitHandler: (() => void) | undefined;
  private stopped = false;

  constructor(
    private nvim: Nvim,
    private entry: Omit<InstanceEntry, "heartbeatAt">,
  ) {
    this.path = join(this.dir, entryFileName(this.entry.pid));
  }

  start(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.nvim.logger.error(
        `InstanceRegistry: failed to create ${this.dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    this.write();

    this.heartbeat = setInterval(() => this.write(), HEARTBEAT_MS);
    this.heartbeat.unref();

    // Reliable cleanup on normal exit + the SIGTERM->process.exit(0) path nvim
    // uses. SIGKILL skips this; pruning covers that case.
    this.exitHandler = () => {
      try {
        unlinkSync(this.path);
      } catch {
        // ignore
      }
    };
    process.on("exit", this.exitHandler);
  }

  private write(): void {
    if (this.stopped) return;
    const full: InstanceEntry = { ...this.entry, heartbeatAt: Date.now() };
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(full), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      this.nvim.logger.warn(
        `InstanceRegistry: failed to write entry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (this.exitHandler) {
      process.off("exit", this.exitHandler);
      this.exitHandler = undefined;
    }
    try {
      unlinkSync(this.path);
    } catch {
      // already gone; ignore
    }
  }
}

# Objective and Context

This is **Part 2** of the remote-magenta feature (branch `zach/remote-magenta`). Part 1
(slices 1–6 in [2026-06-04-remote-magenta.md](./2026-06-04-remote-magenta.md)) gave each
magenta node process an in-process `WebServer` (`node/web-server.ts`) that mirrors the chat,
accepts send/abort/approve, and switches threads, served by a vamp client in
`node/web-client/`.

The user runs **tmux with several concurrent nvim sessions**, each with its own magenta
node process and its own `WebServer`. With Part 1's dynamic port (see below) there is no
fixed URL to remember, and no single place that lists the running instances.

**Goal:** one magenta instance also serves, on a CONFIGURABLE well-known port, an **index
page** listing ALL live magenta instances (cwd, title, and that instance's dynamic web-UI
URL) so the user can hop between them from any device. The instance hosting the index can
be shut down at any time; another instance must take over automatically (self-healing).

## Relationship to Part 1 (assume it has landed)

Part 1 removed the fixed `webServerPort` option. The `WebServer` now ALWAYS runs and binds
an OS-assigned free port via `listen(0)`; the resolved port is read back from
`server.address()` and exposed as `WebServer.getPort(): number | undefined`. `magenta.ts`
constructs + starts the server unconditionally and knows the resolved port.

This Part-2 plan therefore assumes:

- Every instance already has a running `WebServer` on a dynamic port.
- `magenta.ts` can obtain that port (`getPort()`), the instance `cwd` (`this.cwd`), and a
  title.

> **Part-1-adjacent tweak required (small):** `getPort()` returns `undefined` until the
> async `listen(0)` callback fires. Registry registration must happen *after* the port
> resolves. Add a `WebServer.whenListening(): Promise<number>` (resolves with the port) or
> change `start()` to `Promise<number>`. The registry manager awaits it before writing its
> entry. Do NOT busy-poll `getPort()`.

# Decisions

- **File-based registry is the source of truth.** Each instance writes a small JSON entry
  describing itself into a per-user runtime directory and heartbeats it. The index page is
  just a web view over that directory. (Decided with the user.)
- **Directory-of-files, not one shared file.** Each instance owns exactly ONE file,
  `\<pid\>.json`, that ONLY it writes (atomic temp-write + `rename`) and that everyone else
  only reads. This sidesteps multi-writer concurrency entirely — no locking, no lost
  updates, no partial-read races on a shared file.
- **Leadership = whoever holds the index port.** The OS TCP port IS the lock. Instances
  opportunistically try to `listen()` the configured index port on an interval; the one
  that succeeds is the leader and serves the index. When the leader dies (cleanly OR via
  `kill -9`), the OS releases the port and the next attempt by a survivor wins. No separate
  leader-lockfile, no consensus protocol.
- **Liveness is dual-signal.** Prune an entry if its pid is dead (`process.kill(pid, 0)`,
  reliable because all instances share one host) OR its heartbeat is stale. The combination
  also defends against pid reuse.
- **Clean removal is best-effort only.** Because nvim shutdown sends SIGTERM and
  `node/index.ts` responds with `process.exit(0)` (it does NOT call `magenta.destroy()`),
  the reliable cleanup hook is a SYNCHRONOUS `process.on("exit")` `unlinkSync`. Hard kills
  (SIGKILL) skip even that — pruning covers them.
- **Registry stores a reachable host, never `0.0.0.0`.** Links must work from a phone. We
  separate the *bind address* (dev: `0.0.0.0`) from the *advertised host* (dev: LAN IPv4;
  final: the Tailscale `100.x.y.z` address). Tailscale stays the last slice, mirroring
  Part 1's deferral.
- **No new dependencies.** `node:http`, `node:fs`, `node:net`, `node:os`, `node:path`,
  `node:url` only — same palette the existing `WebServer` uses. No `any`; `undefined` over
  `null`; static imports only.
- **Index UI reuses the web-client pipeline.** A second vamp entrypoint in
  `node/web-client/` (`index-page.ts` + `index-page.html`), built by a second esbuild
  invocation in `scripts/build.mjs`. Shares the vendored `vamp.ts`.

# Architecture

## Registry (source of truth)

**Location.** Prefer `process.env.XDG_RUNTIME_DIR` (Linux; user-private, mode 0700) and
fall back to `os.tmpdir()` (macOS has no XDG_RUNTIME_DIR; `os.tmpdir()` is the per-user
`/var/folders/...` dir, also private). Subdirectory:

```
<XDG_RUNTIME_DIR | os.tmpdir()>/magenta/instances/
```

Create it recursively at startup with mode `0o700` (the entries reveal cwds/ports but no
secrets; still keep it user-private).

**File format.** One file per instance, named `\<pid\>.json`:

```ts
type InstanceEntry = {
  pid: number;        // process.pid — also the filename stem and liveness key
  cwd: string;        // this.cwd (NvimCwd)
  title: string;      // display label (see below)
  host: string;       // ADVERTISED reachable host (never 0.0.0.0)
  port: number;       // dynamic per-instance WebServer port (getPort())
  startedAt: number;  // Date.now() at registration (pid-reuse tiebreaker, sort key)
  heartbeatAt: number;// Date.now(), refreshed every HEARTBEAT_MS
};
```

**Title.** Start simple: `basename(cwd)` (optionally suffixed with the active thread title
later). Keep derivation in one helper so it can grow without touching the registry.

**Concurrency model.**
- *Writers:* an instance writes only its own `\<pid\>.json`. Write to `\<pid\>.json.tmp`
  then `fs.rename()` it into place — `rename` is atomic on a single filesystem, so readers
  never observe a half-written file.
- *Readers:* list the dir, read every `*.json` (explicitly excluding `*.json.tmp`). Tolerate
  `ENOENT` (an instance exited between `readdir` and `readFile`) and `JSON.parse` errors
  (skip that file). No locks anywhere.

**Heartbeat.** `HEARTBEAT_MS = 5000`. A `setInterval` rewrites the entry with a fresh
`heartbeatAt` (full atomic rewrite — cheap, a few hundred bytes). `unref()` the timer so it
never keeps the process alive on its own.

## Liveness & pruning

`STALE_MS = 15000` (3× heartbeat). An entry `e` is considered LIVE iff:

```
pidAlive(e.pid) && (Date.now() - e.heartbeatAt) <= STALE_MS
```

where `pidAlive(pid)` is `try { process.kill(pid, 0); return true } catch (err) { return
err.code === "EPERM" }` (EPERM means the pid exists but is owned by another user → treat as
alive but it won't be one of ours anyway; ESRCH means dead).

- pid check is authoritative here because **every instance is on the same host** (tmux).
- The heartbeat-staleness arm catches a hung-but-alive process and defends against **pid
  reuse**: if a dead instance's pid is recycled by an unrelated process, that process is not
  refreshing our file, so `heartbeatAt` goes stale and the entry is pruned.

Pruning is **opportunistic and read-driven**: whoever reads the registry (the leader, when
serving `/instances`) deletes (best-effort `unlink`, ignore `ENOENT`) entries that fail the
liveness test, and omits them from the response. No dedicated reaper process.

Expose a single pure-ish helper so it is unit-testable on a temp dir without nvim:

```ts
function readLiveInstances(dir: string): InstanceEntry[]; // list + parse + prune + sort
```

## Leader election (opportunistic index-port binding)

Every instance runs an election loop (`ELECTION_INTERVAL_MS = 3000`, `unref()`'d):

```ts
// pseudo-shape, not final code
tryBecomeLeader() {
  if (this.isLeader) return;
  const server = createServer(handler);
  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") return;          // someone else leads; retry next tick
    this.nvim.logger.warn(`index server bind error: ${err.message}`);
  });
  server.listen(indexPort, this.bindHost, () => {   // bound -> we are the leader
    this.isLeader = true;
    this.server = server;
    this.nvim.logger.info(`Magenta index server listening on http://${this.bindHost}:${indexPort}`);
  });
}
```

- Use a FRESH `Server` object per attempt; on `EADDRINUSE` let it be GC'd (don't reuse a
  server that errored). Only the winner is retained.
- **Takeover timing:** when the leader's process exits (any signal, including SIGKILL), the
  OS closes its listening socket and frees the port. The next survivor's `tryBecomeLeader`
  tick binds it. Worst-case takeover latency ≈ `ELECTION_INTERVAL_MS` (~3s). This is the
  whole self-healing story and it requires no cooperation from the dying leader.
- The leader ALSO keeps running its normal per-instance `WebServer` on its own dynamic
  port; the index server is purely additive.

## Clean shutdown

- **Reliable path (sync):** register `process.on("exit", () => unlinkSync(entryFile))` once.
  This fires even on the SIGTERM→`process.exit(0)` path used by nvim shutdown (see
  `node/index.ts`). Synchronous fs only — async work does not run during `exit`.
- **Belt-and-suspenders:** `magenta.destroy()` also stops the heartbeat/election timers,
  closes the index server if leader, and unlinks the entry. (Note `destroy()` is not
  guaranteed to run on SIGTERM, so it cannot be the sole cleanup.)
- **SIGKILL:** neither hook runs; the leftover file is reaped by pruning, and the index port
  is freed by the OS. Fully covered.

## Advertised host vs bind address (Tailscale interplay)

A small helper, evaluated once at startup:

```ts
function detectReachableHost(): string;
// 1. first non-internal IPv4 in os.networkInterfaces() whose address starts with "100."
//    (Tailscale CGNAT range) -> final state
// 2. else first non-internal IPv4 (dev LAN)
// 3. else "localhost"
```

- `WebServer` and the index server **bind** `0.0.0.0` in dev (so LAN testing works) but the
  registry stores `host = detectReachableHost()` so links are navigable from another device.
- Final Tailscale slice flips the bind address to the detected `100.x` and stores that same
  host (bind == advertised). This is also where Part 1's slice 7 (Tailscale hardening for
  the per-instance server) lands — do them together.

## Index server endpoints

The leader's HTTP server serves:

- `GET /` → `index-page.html` (the vamp index UI).
- `GET /index-page.js` → bundled vamp client.
- `GET /instances` → `application/json`, body `{ instances: InstanceEntry[] }` from
  `readLiveInstances()` (this read is what triggers pruning). Includes a `self` marker (by
  pid) so the UI can highlight the current host instance if desired.
- 404 otherwise.

**Why polling `/instances`, not SSE:** the registry changes slowly and, more importantly,
polling makes takeover transparent — the client polls a fixed `host:indexPort`; if the
leader dies the next poll fails and then succeeds against the new leader on the SAME port,
with no EventSource reconnect lifecycle to reason about across a leadership change. (SSE is
a viable v2 if we want push; noted under alternatives.)

## Index page UI (vamp)

A new vamp entrypoint consistent with `node/web-client/index.ts`:

- Polls `GET /instances` every ~3s; renders a mobile-first list. Each row is a plain
  `<a href="http://${host}:${port}/">` (so middle/long-press opens a new tab) showing
  `title`, `cwd`, and `host:port`, sorted by `startedAt`.
- Connection state: show "reconnecting…" when a poll fails (covers the takeover window),
  recover automatically.
- Reuse the patterns already in the web client: `cls()`/`mountStyle()` for styles,
  `Binder` + `bindList`/`showKeyed` for the list, `bindText` (XSS-safe) for user-controlled
  `cwd`/`title`. Use `<a href>` rather than JS navigation so it behaves like real links.

**Build pipeline reuse.** `scripts/build.mjs` currently runs a second esbuild for
`node/web-client/index.ts` → `dist/web-client.js` and copies `index.html` → `dist/index.html`.
Add a THIRD esbuild for `node/web-client/index-page.ts` → `dist/index-page.js` and copy
`node/web-client/index-page.html` → `dist/index-page.html`. The index server resolves these
from `dist/` exactly like `WebServer` does (`dirname(fileURLToPath(import.meta.url))`).
Distinct filenames avoid colliding with the per-instance client's `/` and `/web-client.js`.

# Type/Signature sketches (illustrative only)

```ts
// node/instance-registry.ts
export type InstanceEntry = { pid; cwd; title; host; port; startedAt; heartbeatAt };

export class InstanceRegistry {
  constructor(private nvim: Nvim, private entry: Omit<InstanceEntry, "heartbeatAt">) {}
  start(): void;   // mkdir, write entry, start heartbeat, register process.on("exit")
  stop(): void;    // clear heartbeat, unlink own file (idempotent)
}
export function readLiveInstances(dir: string): InstanceEntry[];
export function registryDir(): string;
export function detectReachableHost(): string;

// node/index-server.ts
export class IndexServer {
  constructor(
    private nvim: Nvim,
    private indexPort: number,
    private bindHost: string,
    private readInstances: () => InstanceEntry[],
  ) {}
  start(): void;   // begin election loop
  close(): void;   // stop loop; close server if leader
}
```

# Implementation Plan (vertical slices)

Each slice is independently, manually testable, ideally with two real nvim sessions in
tmux. Front-load the registry + election infra; defer Tailscale (like Part 1).

## Slice 1 — Self-registration + options

- Add `webIndexPort?: number` to `MagentaOptions` (`node/options.ts`) — positive-integer
  validation with a warn, mirroring how the old `webServerPort` was parsed in both
  `parseOptions` and `parseProjectOptions`. Add a default (e.g. `webIndexPort = 8764`) to
  `lua/magenta/options.lua`. (Keep it camelCase per repo convention.)
- New `node/instance-registry.ts`: `registryDir()`, `detectReachableHost()`,
  `InstanceRegistry` (write own `\<pid\>.json` atomically, `HEARTBEAT_MS` rewrite, sync
  `process.on("exit")` unlink). `start()` is called from `magenta.ts` AFTER the web server
  port resolves (via the new `whenListening()`); `stop()` is called from `destroy()`.
- **Test:** open two nvim sessions in different cwds; inspect the registry dir — two
  `\<pid\>.json` files with correct `cwd`/`host`/`port`/`pid`. `:q` one → its file
  disappears (sync exit unlink). `kill -9` one → its file remains (to be pruned in slice 2).

## Slice 2 — Read + prune (liveness)

- Implement `readLiveInstances(dir)`: list `*.json`, parse-tolerantly, prune entries failing
  `pidAlive(pid) && fresh(heartbeatAt)`, best-effort `unlink` the dead ones, return sorted
  by `startedAt`.
- Unit test (core-style, no nvim): seed a temp dir with a live-looking entry, a dead-pid
  entry, and a stale-heartbeat entry; assert only the live one is returned and the dead
  files are removed. Also assert tolerance of a `*.json.tmp` and a malformed file.
- **Test (manual):** leave the `kill -9` leftover from slice 1; call the reader (temporary
  log line or debug command) and confirm the stale entry is pruned.

## Slice 3 — Index server + leader election

- New `node/index-server.ts`: `IndexServer` with the `ELECTION_INTERVAL_MS` opportunistic
  bind loop, `EADDRINUSE` handling, and a request handler serving `GET /instances` JSON
  (calling `readLiveInstances`). 404 elsewhere for now.
- Wire into `magenta.ts`: construct + `start()` after the registry; `close()` in
  `destroy()`. Bind `0.0.0.0`, advertise `detectReachableHost()`.
- **Test:** two sessions running; `curl http://localhost:\<webIndexPort\>/instances` returns
  both instances; exactly one process holds the port (`lsof -i`). `kill -9` the leader; within
  ~3s the other answers `/instances` on the same port (`curl` again). Start a third session;
  it appears in the JSON.

## Slice 4 — Vamp index page

- New `node/web-client/index-page.ts` + `node/web-client/index-page.html`; extend
  `scripts/build.mjs` (third esbuild + html copy). Serve `GET /` and `GET /index-page.js`
  from `IndexServer`.
- Page polls `/instances`, renders a mobile-first list of `<a>` links (title, cwd,
  host:port), with a reconnecting indicator during takeover.
- **Test:** open `http://\<host\>:\<webIndexPort\>/` in a laptop browser; see all sessions;
  click one → that instance's Part-1 chat UI loads. Kill the leader; the page shows
  reconnecting, then recovers and still lists the survivors.

## Slice 5 — Tailscale hardening (with Part 1 slice 7)

- `detectReachableHost()` returns the `100.x` Tailscale address; bind BOTH the per-instance
  `WebServer` and the `IndexServer` to it (replace the dev `0.0.0.0`), and store that host
  in the registry so links are reachable.
- Keep a dev fallback (env flag or auto: if no `100.x` interface, fall back to LAN/`0.0.0.0`)
  so local development doesn't require Tailscale.
- **Test:** from a phone over Tailscale, open `http://100.x.y.z:\<webIndexPort\>/`, see all
  sessions, and navigate into each instance's chat UI.

# Files that change

- `lua/magenta/options.lua` — add `webIndexPort` default.
- `node/options.ts` — `webIndexPort` field + parse in `parseOptions` (and project options).
- `node/web-server.ts` — add `whenListening(): Promise<number>` (or `start(): Promise<number>`);
  in slice 5, bind the detected host instead of `0.0.0.0`.
- `node/magenta.ts` — construct/start `InstanceRegistry` and `IndexServer` after the web
  server port resolves; stop/close both in `destroy()`. (`node:os` is already imported here.)
- `node/instance-registry.ts` — NEW (registry write/heartbeat/cleanup, read+prune, host
  detection).
- `node/index-server.ts` — NEW (election loop + index HTTP endpoints).
- `node/web-client/index-page.ts`, `node/web-client/index-page.html` — NEW (vamp index UI).
- `scripts/build.mjs` — third esbuild bundle + html copy.
- Tests: `node/instance-registry.test.ts` (or a `core`-style unit test) for prune logic.

# Open questions / risks

- **`webIndexPort` occupied by a non-magenta process:** every instance gets perpetual
  `EADDRINUSE` and no leader ever emerges (no index page). Mitigation: distinct log message
  when EADDRINUSE persists while no magenta entry claims leadership; document that the port
  must be free. Consider surfacing "index unavailable" somewhere.
- **`process.on("exit")` reliability:** fires for normal exit and `process.exit()` but NOT
  for SIGKILL or a hard crash — acceptable because pruning is the safety net. Confirm the
  existing SIGTERM handler (`process.exit(0)`) still lets `exit` listeners run (it does;
  `process.exit` emits `exit`).
- **pid reuse window:** between a hard kill and heartbeat-staleness expiry (≤ `STALE_MS`), a
  recycled pid could make a dead entry look alive. 15s window, low-stakes (a stale link).
  Tunable.
- **Filesystem assumptions:** atomic `rename` requires `.tmp` and final file on the same fs
  (they are — same dir). `XDG_RUNTIME_DIR` is tmpfs on most Linux; fine.
- **Host detection ambiguity:** multiple non-internal IPv4s (VPNs, docker bridges) in dev
  could pick a non-reachable one. The `100.x` rule is unambiguous for the final state;
  dev’s LAN heuristic is best-effort (could be made configurable later).
- **Title quality:** `basename(cwd)` collides across worktrees with the same leaf name.
  Could disambiguate with a parent segment or the active thread title later.
- **Clock skew:** all instances share one host, so `Date.now()` comparisons for heartbeat
  staleness are consistent. (Would matter only if the registry ever spanned hosts.)
- **Index server vs per-instance server bind host divergence (slice 5):** if Tailscale comes
  up after startup, the host detected at boot is stale. Out of scope for MVP; note that a
  restart picks up the new interface.

# Alternatives considered

- **Single shared registry JSON file with locking** — rejected: multi-writer concurrency,
  partial-read races, and lockfile/staleness complexity. The directory-of-files design makes
  each file single-writer and needs no locks.
- **A dedicated long-lived index daemon (separate process)** — rejected: violates the
  "companion only, in-process" decision from Part 1 and adds a process to supervise. The
  port-as-lock election keeps it in-process and self-healing.
- **Explicit leader-lockfile pointing at the current leader** — rejected: the lockfile and
  the actual bound port can disagree (crash between bind and write), and takeover needs extra
  liveness logic. Binding the port directly makes the OS the single source of truth.
- **mDNS / UDP broadcast discovery** — rejected: new dependency/complexity; the shared-host
  assumption makes a filesystem registry trivial and dependency-free.
- **SSE for `/instances`** — viable, and consistent with Part 1's `/events`, but polling has
  a strictly simpler takeover story (no reconnect across a leadership change). Keep SSE as a
  v2 option if push latency matters.

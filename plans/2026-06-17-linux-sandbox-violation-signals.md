# Objective and Context

User request, verbatim:

> let's make a plan for 1+2

Referring to the two recommendations from the preceding discussion:

> 1. **Now:** wire the `SandboxAskCallback` into `SandboxViolationHandler` — instant robust network prompts on Linux, and it removes a whole class of stderr-heuristic guessing.
> 2. **Near-term:** replace `detectLinuxSandboxViolations`' stderr parsing with strace-based EPERM capture for filesystem/exec denials.

## What we're building and why

The macOS sandbox gives us a live violation-log channel, so blocked operations
surface as clean approval prompts. On Linux (bubblewrap) there is no such
channel, so today we reverse-engineer failures from `stderr` text via
`detectLinuxSandboxViolations` + user-configurable regexes. That is brittle:
many denials never get recognized as permission violations and are handed back
to the agent as opaque failures.

Two independent improvements:

- **(1) Network:** `@anthropic-ai/sandbox-runtime` already exposes a
  cross-platform live signal — `SandboxAskCallback`. Its HTTP/SOCKS proxy calls
  it (on both macOS and Linux) whenever a sandboxed process connects to a host
  that is neither allow- nor deny-listed, and blocks or permits the connection
  based on the boolean we return. We currently pass `undefined`, so unknown-host
  requests are silently blocked and only surface (poorly) as downstream network
  errors. Wiring it gives a real, live, "may I connect to X?" prompt on both
  platforms, with no kernel work.

- **(2) Filesystem/exec:** replace the `stderr` regex heuristic with running the
  user command under `strace`, capturing syscalls that return `EPERM`/`EACCES`,
  and synthesizing structured violation events from those. Keep the regex
  heuristic as a fallback when `strace` is unavailable or cannot attach.

## Key entities

- `Sandbox` interface + `RealSandbox` (`node/sandbox-manager.ts`) — wraps the
  library's `SandboxManager`. `initializeSandbox(...)` currently receives
  `askCallback: SandboxAskCallback | undefined` and forwards it to
  `SandboxManager.initialize`. The call site in `node/magenta.ts` (~line 1025)
  passes `undefined`.
- `SandboxAskCallback = (params: { host: string; port: number | undefined }) => Promise<boolean>`
  (from the library). Single global callback, fired while a command runs; no
  pid/command context is provided.
- `SandboxViolationHandler` (`node/capabilities/sandbox-violation-handler.ts`) —
  owns the queue of pending UI prompts (`PendingPrompt` union: `approval-prompt`,
  `violation`, `write-approval`) and renders them via `view()`. Each prompt's
  `resolve` is typed `(result: ShellResult) => void`. One instance per
  environment (i.e. per thread), created in `createLocalEnvironment`
  (`node/environment.ts`).
- `SandboxShell` (`node/capabilities/sandbox-shell.ts`) — runs commands. Holds
  `runWrappedAndHandleViolations`, the Linux heuristic
  (`detectLinuxSandboxViolations`, `compileViolationPatterns`), and `spawnCommand`
  (the raw `bash -c` runner). Wraps the user command via
  `sandbox.wrapWithSandbox(command)` before spawning.
- `bwrapSandboxViolationPatterns` (`node/options.ts`) — user-configurable regexes
  for the current Linux heuristic.
- `MockSandboxManager` (`node/test/mock-sandbox-manager.ts`) — test double
  implementing `Sandbox`; `simulateViolation` feeds the violation store.

# Design

## Part 1 — wire the network ask callback

### The routing problem (the load-bearing part)

The sandbox is a single global object (one `initializeSandbox` in
`node/magenta.ts`), so there is exactly one `SandboxAskCallback`. But UI prompts
live in per-thread `SandboxViolationHandler`s, and the callback receives only
`{ host, port }` — no way to know which command/thread triggered it.

Design: the `Sandbox` holds a single mutable "active network-ask target". Each
`SandboxShell`, for the duration of a sandboxed `spawnCommand`, registers itself
as that target (push on start, pop on completion — a stack to tolerate nesting).
The global `askCallback` (created once in `magenta.ts`) consults the current top
of stack and forwards `{ host, port }` to that handler's new
`promptForNetworkAccess`. If the stack is empty (no sandboxed command in flight —
shouldn't happen, but possible on races), default to **deny** (fail closed).

Concurrency caveat to document: if two sandboxed commands run concurrently and
both hit unknown hosts, attribution goes to the most-recently-started command.
This is acceptable given near-universal single-command execution; we are not
solving perfect attribution.

### New prompt kind

Add a `network-access` prompt to `SandboxViolationHandler`. Unlike existing
prompts it resolves to a **boolean**, not a `ShellResult`, and does **not**
re-run anything — approve → resolve `true` (proxy allows the connection),
reject → resolve `false` (proxy blocks it). Because the existing `resolve` is
typed `(result: ShellResult) => void`, give the new pending entry its own
resolve type rather than widening the shared one (no `any`). `view()` renders a
`🌐 Allow network access to <host>:<port>?` prompt with APPROVE/REJECT bindings;
`approveAll`/`rejectAll` must handle it.

### Approve-for-session vs approve-once

A single `curl` triggers many proxy decisions (connect, redirects, keep-alive).
Prompting per-request would spam the user. Default to **approve-for-session**:
on approval, remember the host in an in-session allowlist held by the `Sandbox`
wrapper and merge it into the runtime config so subsequent requests to that host
pass without prompting. (Mechanically: the wrapper keeps a `Set<string>` of
approved hosts and includes them when it builds `allowedDomains`, or calls the
library's `updateConfig`.) Rejections are not remembered (user may change their
mind next command).

### Why this also helps macOS

Network is enforced by the userland proxy on **both** platforms — denied network
requests never appear in the macOS sandbox violation log store (that store is for
seatbelt syscall denials like file/sysctl). So today network denials are poorly
surfaced on macOS too, and wiring the callback fixes both platforms with no
double-prompt risk against the existing post-hoc `violation` flow.

Invariants (Part 1):
- Exactly one global `askCallback`; routing is via the active-target stack.
- The callback must always resolve (approve or reject) so the proxy is never
  wedged; on shutdown/abort it must resolve to `false`.
- Network asks never enter the violation store and never trip the grace-period
  termination monitor.
- Empty active-target stack ⇒ fail closed (deny).

## Part 2 — strace-based Linux violation capture

### Approach

When the platform is Linux and the sandbox is active, run the user command under
`strace` so that filesystem/exec denials are captured as structured syscall
records instead of being guessed from `stderr`.

`strace` must trace the **user command**, not bwrap's own setup (bwrap performs
many legitimate `EPERM` operations while constructing the namespace). Since
`SandboxShell` controls the raw `command` *before* calling
`sandbox.wrapWithSandbox`, wrap the user command with strace first, then pass the
straced command into `wrapWithSandbox`. Shape:

```
strace -f -qq -e trace=file,network,process -e signal=none \
  -o <traceFile> -- bash -c '<original command>'
```

- `<traceFile>` must be written to a sandbox-writable location (e.g. inside the
  existing per-command log dir, ensuring it is in `allowWrite`). Resolve/verify
  the path before use.
- After the command exits non-zero, parse `<traceFile>` for lines whose result
  is `EPERM`/`EACCES`, extract syscall + the relevant path/target argument, and
  build `SandboxViolationEvent`s (reusing the existing `{ line, command,
  timestamp }` shape, with `line` a human-readable rendering like
  `openat("/etc/shadow") -> EACCES`). Feed these into the violation store exactly
  where `detectLinuxSandboxViolations` does today, so the rest of the flow
  (annotate, `addViolation`, approval prompt, re-run-unsandboxed) is unchanged.

### Availability & fallback

`strace` is a new optional runtime dependency. Add a capability check
(presence of the `strace` binary; on first use, cache the result). If `strace`
is missing **or** the straced run shows signs that tracing did not attach (e.g.
empty/garbage trace file, or strace's own startup error), fall back to the
existing `detectLinuxSandboxViolations` regex path. The regex code stays as the
fallback; `bwrapSandboxViolationPatterns` remains supported.

### Risk: ptrace inside the sandbox (spike first)

The library applies a seccomp + nested PID-namespace isolation layer
(`apply-seccomp`) when Unix-socket restrictions are active; the inner init sets
`PR_SET_DUMPABLE=0`, and `kernel.yama.ptrace_scope` may restrict attach. `strace`
relies on `ptrace`, so it may fail to attach in some configurations. This must be
validated by a spike before building the parser, since if `strace` cannot run
inside the sandbox the whole approach is moot and we keep the heuristic. Outcome
of the spike decides whether Part 2 proceeds as designed, runs strace *outside*
bwrap around the wrapped command, or is dropped.

Invariants (Part 2):
- strace wraps the user command only; bwrap setup syscalls are never parsed.
- Trace file lives in a sandbox-writable path and is cleaned up with the command.
- Missing/failed strace degrades gracefully to the existing regex heuristic — no
  regression in current behavior.
- Only `EPERM`/`EACCES` results become violations; other syscalls are ignored.

# Stages

## Stage 1 — Network ask plumbing in the Sandbox + handler (no UI yet)

- Goal: `Sandbox` can register/clear an active network-ask target (stack), and
  `SandboxViolationHandler` has `promptForNetworkAccess({host, port}): Promise<boolean>`
  plus a `network-access` pending kind whose `resolve` is boolean-typed.
  `approve`/`reject`/`approveAll`/`rejectAll` handle it.
- Verification (unit):
  - Behavior: `promptForNetworkAccess` returns a pending promise that resolves
    `true` on `approve(id)` and `false` on `reject(id)`.
    - Setup: a fresh `SandboxViolationHandler` with a spy `onPendingChange`.
    - Actions: call `promptForNetworkAccess`, read the pending id, call
      approve/reject.
    - Expected: promise resolves to the matching boolean; pending map empties;
      `onPendingChange` fired.
  - Behavior: empty active-target stack ⇒ deny.
    - Setup: `Sandbox` wrapper with no registered target.
    - Actions: invoke the routed callback with a host.
    - Expected: resolves `false`.
- Before moving on: tests, `npx tsgo -b`, and `npx biome check .` all pass.

## Stage 2 — Build the global askCallback and wire it at initialize

- Goal: `node/magenta.ts` constructs a real `SandboxAskCallback` that routes to
  the Sandbox's active target, and passes it to `initializeSandbox` instead of
  `undefined`. `SandboxShell` registers/unregisters itself around each sandboxed
  `spawnCommand`. Approve-for-session allowlist merged into runtime config.
- Verification (integration, via `MockSandboxManager` extended to invoke an
  ask callback):
  - Behavior: a sandboxed command that "requests" an unknown host surfaces a
    `network-access` prompt; approving lets the request proceed and records the
    host for the session (no second prompt for the same host).
    - Setup: mock sandbox whose `wrapWithSandbox`/run path triggers the
      registered ask callback for a configured host; driver inspects the
      handler's `view()`/pending map.
    - Actions: run command, approve the prompt, run again.
    - Expected: first run prompts and resolves `true`; second run does not prompt.
  - Behavior: reject blocks and does not persist.
    - Expected: callback resolves `false`; a later request to the same host
      prompts again.
- Before moving on: tests, type checks, lint pass.

## Stage 3 — strace feasibility spike (Linux)

- Goal: decide whether `strace` can attach to and trace the user command inside
  the bubblewrap (and seccomp, when active) sandbox, and produce a parseable
  trace file in a writable location. Produce a short written finding appended to
  this plan; gate Stage 4 on it.
- Verification (manual/integration on a Linux host or test container):
  - Behavior: a command that reads a denied path under the sandbox yields an
    `EACCES`/`EPERM` line in the trace file; bwrap's own setup syscalls are not
    in the user trace.
    - Setup: real sandbox config denying a known path; run
      `cat <deniedPath>` straced.
    - Expected: trace file contains the denied syscall with the right path; the
      file is readable back by the harness.
  - Behavior: confirm behavior both with and without Unix-socket seccomp active.
- Before moving on: record the outcome; if attach fails everywhere, stop Part 2
  and keep the heuristic.

## Stage 4 — strace wrapping + parser + fallback

- Goal: `SandboxShell` wraps the user command with strace on Linux, parses the
  trace file into `SandboxViolationEvent`s at the point
  `detectLinuxSandboxViolations` is called today, and falls back to the regex
  heuristic when strace is absent/failed. Trace file cleaned up with the command.
- Verification:
  - Behavior (unit): the trace parser turns fixture strace output into the
    expected violation events.
    - Setup: representative strace lines (multi-process `-f`, `EACCES`/`EPERM`
      on `openat`/`connect`/`execve`, plus unrelated successful syscalls).
    - Actions: run the parser.
    - Expected: only denied syscalls become events, each with a readable `line`
      and the correct path/target; successes ignored; dedup preserved.
  - Behavior (unit): strace-unavailable ⇒ falls back to existing heuristic and
    current behavior is unchanged.
    - Setup: capability check stubbed to "absent".
    - Actions: run a failing command whose stderr matches a configured pattern.
    - Expected: a synthetic violation is produced via the regex path exactly as
      today.
- Before moving on: tests, type checks, lint pass.

# Notes / open questions for the implementer

- Confirm the exact in-session allowlist mechanism: extending the wrapper's
  `allowedDomains` vs calling the library's `updateConfig`. Either is fine; pick
  the one that survives `updateConfigIfChanged` reconciliation without being
  clobbered.
- Decide trace-file location precisely so it is guaranteed inside `allowWrite`
  (reuse the per-command log dir if it qualifies).
- Network asks are blocking on the proxy; ensure abort/shutdown paths resolve
  every outstanding `promptForNetworkAccess` to `false` so a wedged proxy can
  never hang a command teardown.

# Objective and Context

User request, verbatim:

> let's make a plan for 1+2

Referring to the two recommendations from the preceding discussion:

> 1. **Now:** wire the `SandboxAskCallback` into `SandboxViolationHandler` — instant robust network prompts on Linux, and it removes a whole class of stderr-heuristic guessing.
> 2. **Near-term:** replace `detectLinuxSandboxViolations`' stderr parsing with strace-based EPERM capture for filesystem/exec denials. (Now: drop the stderr heuristic entirely and make strace a hard requirement on Linux.)

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

- **(2) Filesystem/exec:** replace the `stderr` regex heuristic entirely with
  running the user command under `strace`, capturing syscalls that return
  `EPERM`/`EACCES`, and synthesizing structured violation events from those. The
  old `detectLinuxSandboxViolations` heuristic and `bwrapSandboxViolationPatterns`
  option are **removed**, not kept as a fallback. `strace` becomes a hard
  requirement on Linux: if it is missing (or cannot attach), magenta **refuses
  to start** with a clear error rather than silently degrading.

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
  (`detectLinuxSandboxViolations`, `compileViolationPatterns` — to be **removed**),
  and `spawnCommand` (the raw `bash -c` runner). Wraps the user command via
  `sandbox.wrapWithSandbox(command)` before spawning.
- `bwrapSandboxViolationPatterns` (`node/options.ts`) — user-configurable regexes
  for the current Linux heuristic. To be **removed** along with the heuristic.
- `SandboxConfig` (`node/options.ts`) — the `sandbox` options block, parsed by
  `parseSandboxConfig` and merged by `mergeSandboxConfigs`. Already supports
  layered configuration (defaults → user-level → project-level), so any new
  field automatically inherits project/user override + merge semantics.
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
  `openat("/etc/shadow") -> EACCES`). Feed these into the violation store at the
  point `detectLinuxSandboxViolations` is called today (that call is being
  deleted), so the rest of the flow (annotate, `addViolation`, approval prompt,
  re-run-unsandboxed) is unchanged.

### Process-group / termination interaction

Today `spawnCommand` spawns `bash -c <command>` with `detached: true`, making
bash a process-group leader (pgid == pid). Termination signals the whole group
via `process.kill(-pid, SIGTERM)` then escalates to SIGKILL
(`terminateProcess`/`escalateToSigkill` in `shell-utils.ts`), so any children
bash spawned are also killed.

With strace the spawned tree becomes `bwrap → strace -f → bash -c <command>`
(strace wraps the user command, then `wrapWithSandbox` wraps the straced
command, so **bwrap remains the outermost process and the group leader**, and
`childProcess.pid` is bwrap's host pid). This preserves the kill path: the
negative-pid group-kill still reaches strace, bash, and all descendants. Rules
to keep this invariant:

- Keep strace **inside** the bwrap wrap (strace nested under bwrap). Never make
  strace the outermost process, or it becomes the group leader and we'd be
  relying on strace's own teardown to bring down bwrap.
- `strace -f` follows forks/clones, so the traced set matches the process group
  we corral — they stay aligned.
- Signal delivery to a ptraced process is mediated by its tracer (strace).
  strace is in the same group, so a group SIGTERM hits strace too; its default
  behavior is to detach and die, after which the directly-signaled tracees
  terminate. There is a race window where strace dies before forwarding/detaching
  and a tracee is left in a ptrace-stop. We rely on the existing SIGTERM→SIGKILL
  escalation to defeat this, since SIGKILL cannot be blocked or held by a
  ptrace-stop.

When implementing Stage 4, copy the essence of this section into a comment at
the strace-wrapping call site in `SandboxShell`, so future readers understand
why strace must stay nested under bwrap and why the SIGKILL escalation is
load-bearing.

### Availability — hard requirement (no fallback)

`strace` is a new **required** runtime dependency on Linux. Add a startup
capability check (presence of the `strace` binary; verify it can actually attach
inside the sandbox, not just that the binary exists). If `strace` is missing or
cannot attach, magenta **refuses to start** on Linux with a clear, actionable
error (how to install strace / why it is required). There is no regex fallback:
`detectLinuxSandboxViolations`, `compileViolationPatterns`, and
`bwrapSandboxViolationPatterns` are deleted.

### Risk: ptrace inside the sandbox (spike first)

The library applies a seccomp + nested PID-namespace isolation layer
(`apply-seccomp`) when Unix-socket restrictions are active; the inner init sets
`PR_SET_DUMPABLE=0`, and `kernel.yama.ptrace_scope` may restrict attach. `strace`
relies on `ptrace`, so it may fail to attach in some configurations. This must be
validated by a spike before building the parser, since if `strace` cannot run
inside the sandbox the whole approach is moot. Because there is no fallback,
the spike is load-bearing: if attach fails everywhere, we must either run strace
*outside* bwrap around the wrapped command or rethink Part 2 — we cannot ship a
"refuse to start" requirement for a mechanism that can't work.

Invariants (Part 2):
- strace wraps the user command only; bwrap setup syscalls are never parsed.
- Trace file lives in a sandbox-writable path and is cleaned up with the command.
- Missing/failed strace ⇒ magenta refuses to start on Linux (no regex fallback).
- Only `EPERM`/`EACCES` results become violations; other syscalls are ignored.
- strace stays nested under bwrap so bwrap remains the process-group leader and
  the existing negative-pid group-kill + SIGKILL escalation still terminates the
  whole tree.

## Part 3 — configurable auto-allow behavior (options)

### Why

The default for both new signals is "prompt the user". But some users/projects
run trusted automation where prompting is undesirable, and others want to lock
things down. Expose configuration so both the network ask (Part 1) and the
strace capture (Part 2) can be tuned per-project or per-user. Because these go
in `SandboxConfig`, they automatically pick up the existing defaults → user →
project layering via `parseSandboxConfig` + `mergeSandboxConfigs`.

### New options

Add to `SandboxConfig` (`node/options.ts`), with defaults that preserve today's
"safe + prompt" behavior:

- `network.onUnknownHost: "prompt" | "allow" | "deny"` (default `"prompt"`).
  Controls what the global `askCallback` does for a host that is neither allow-
  nor deny-listed:
  - `"prompt"` — surface a `network-access` prompt (Part 1 default behavior).
  - `"allow"` — resolve `true` without prompting (auto-allow; still records the
    host in the in-session allowlist for symmetry).
  - `"deny"` — resolve `false` without prompting (fail closed, no UI).
  The empty-active-target-stack case still always denies, regardless of this
  setting.
- `strace.autoAllowViolations: boolean` (default `false`).
  When `true`, a captured filesystem/exec violation is auto-approved (re-run
  unsandboxed) without prompting, mirroring `network.onUnknownHost: "allow"`.
  When `false`, the existing approval prompt flow is used.

### Parsing & merging

- Extend `parseSandboxConfig` to read `network.onUnknownHost` (validate against
  the enum, warn + default on bad values) and a new `strace` object
  (`autoAllowViolations` boolean; strace itself is mandatory, so there is no
  enable/disable toggle).
- Extend `mergeSandboxConfigs` so project-level overrides user-level for the
  scalar fields (last-writer-wins; these are not arrays to concatenate).
- Extend `DEFAULT_SANDBOX_CONFIG` with the defaults above.

### Wiring

- Part 1 `askCallback` consults `sandbox` config's `network.onUnknownHost`
  before deciding whether to call `promptForNetworkAccess`.
- Part 2 `SandboxShell` always wraps with strace on Linux and consults
  `strace.autoAllowViolations` to decide prompt vs auto-approve.

Invariants (Part 3):
- Defaults reproduce current behavior exactly (`"prompt"`, `false`).
- Invalid enum values warn and fall back to the default, never throw.
- Project settings override user settings for these scalars via the existing
  merge path.

# Stages

## Stage 1 — Network ask plumbing in the Sandbox + handler (no UI yet)

**Code-review follow-up (write-approval resolve type):** Split the
`PendingViolation` union so each prompt kind encodes its own resolve signature:
shell prompts (`approval-prompt`/`violation`) resolve to `ShellResult`,
`write-approval` resolves to `() => void`, and `network-access` resolves to
`boolean`. This removes the `resolve as unknown as ShellResult` cast in
`promptForWriteApproval` and the `entry.resolve(undefined as unknown as
ShellResult)` cast in `approve`. Added an `isWritePending` type guard (mirroring
`isNetworkPending`) so `approve` narrows to the void-resolving variant cleanly.
No remaining double casts.

**Status: DONE.** Implemented `NetworkAskStack` (shared LIFO router) in
`node/sandbox-manager.ts`, exported `NetworkAskParams`/`NetworkAskTarget`, and
added `pushNetworkAskTarget`/`popNetworkAskTarget`/`routeNetworkAsk` to the
`Sandbox` interface (RealSandbox + MockSandboxManager + inline test/magenta
stubs). Empty stack fails closed (deny). Added `promptForNetworkAccess({host,
port}): Promise<boolean>` and a boolean-resolving `network-access` pending kind
to `SandboxViolationHandler`; the pending union carries its own boolean resolve
type (no widening, no `any`), with a `isNetworkPending` type guard so
`approve`/`reject` narrow cleanly. `approveAll`/`rejectAll` handle it via
`approve`/`reject`. `view()` renders a `🌐 Allow network access to host:port?`
prompt. Unit tests cover approve→true, reject→false, approveAll/rejectAll,
rendering, and empty-stack deny + stack routing/pop. All tests, `npx tsgo -b`,
and `npx biome check .` pass.

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

**Status: DONE.** `node/magenta.ts` now builds a single global
`SandboxAskCallback` that forwards `{host, port}` to `sandbox.routeNetworkAsk`
via a mutable `sandboxRef` (assigned right after construction, since the sandbox
is created by `initializeSandbox`); it is passed to `initializeSandbox` instead
of `undefined`, and the on-failure fallback stub gained
`recordSessionApprovedHost`. `SandboxShell` holds a stable `networkAskTarget`
that calls `violationHandler.promptForNetworkAccess` and, on approval, calls
`sandbox.recordSessionApprovedHost(host)`; it pushes/pops that target around the
wrapped `spawnCommand` (in `runWrappedAndHandleViolations`, via try/finally).
Approve-for-session is implemented in `NetworkAskStack` (shared by RealSandbox
and MockSandboxManager): an `approvedHosts` set short-circuits `route()` to
`true`, and `RealSandbox.updateConfigIfChanged` merges those hosts into
`allowedDomains` so the underlying proxy also stops asking. Added
`recordSessionApprovedHost` to the `Sandbox` interface, RealSandbox,
MockSandboxManager, and the inline test stubs (sandbox-shell/file-io tests).
Integration tests in `sandbox-shell.test.ts` ("network ask routing") cover
approve-once-then-no-reprompt, reject-without-persist (reprompts), and
empty-stack deny. `npx tsgo -b` and `npx biome check .` pass; all sandbox test
**Code-review follow-up (Stage 2):** Extracted the approved-host merge from
`RealSandbox.updateConfigIfChanged` into a pure exported `mergeApprovedDomains`
helper (`node/sandbox-manager.ts`) and added focused unit tests for it
(append, dedup, no-mutation) plus an instance-level test asserting a
session-approved host lands in `network.allowedDomains` via `updateConfig`.
This covers the previously-untested allowedDomains merge/dedup branch. The
`proc._emit("close", 0, null)` finding was left as-is: it intentionally mirrors
the Node child_process `close` event signal convention (external-library
boundary).

files pass. (The only full-suite failures are pre-existing flaky nvim
integration tests — spawn-subagents/script-manager stream+socket races and a
notification-bell rendering timing diff — which pass in isolation and are
unrelated to this stage.)

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

### Stage 3 finding (DONE — Stage 4 is GO)

Spike run on Linux (OrbStack/aarch64, `debian:bookworm-slim`, bubblewrap 0.8.0,
strace 6.1) confirms the strace-nested-under-bwrap approach works. **Stage 4 is
unblocked; no redesign needed.**

Setup mirrored the library's bwrap shape (`--new-session --die-with-parent
--ro-bind / / --bind <work> <work> --dev /dev --unshare-pid --proc /proc
--unshare-user --bind /proc /proc`), denied a path via `--ro-bind /dev/null
/secret.txt`, and wrapped the user command as
`strace -f -qq -e trace=file,network,process -e signal=none -o <traceFile> -- bash -c '<cmd>'`
*inside* the bwrap `-- bash -c` (i.e. strace nested under bwrap, exactly as the
plan's "wrap user command with strace, then wrapWithSandbox" prescribes).

Results:
- The denied `cat /secret.txt` produced a parseable trace line:
  `openat(AT_FDCWD, "/secret.txt", O_RDONLY) = -1 EACCES (Permission denied)`
  in the writable trace file (`/work/trace.out`, inside the writable bind).
- The user trace contains only the user command's syscalls (its `execve` +
  descendants). bwrap's own namespace-setup `EPERM`s are absent because strace
  starts at the user command, not at bwrap — so the "never parse bwrap setup"
  invariant holds for free.
- **ptrace_scope (yama):** works with `kernel.yama.ptrace_scope=2`
  (admin-only ATTACH). strace traces its **own forked child** via
  `PTRACE_TRACEME`, which is exempt from yama scope restrictions (yama only
  gates `PTRACE_ATTACH` to non-children). So restrictive ptrace_scope on the
  host does not break this.
- **PR_SET_DUMPABLE=0:** works. Even with the parent process set non-dumpable
  (as apply-seccomp's inner init does) and inside the bwrap pid/user namespace,
  the denied syscall was still captured. `dumpable` governs whether *others* can
  trace *you*; the child resets `dumpable` to 1 on `execve` of a non-setuid
  binary, and strace is tracing its own descendant — so attach succeeds.

Why this generalizes to the seccomp-active path: the library's seccomp filter is
the *unix-socket-block* BPF (`socket(AF_UNIX, ...)`); it does **not** block the
`ptrace` syscall, so strace's TRACEME/wait machinery is unaffected. When seccomp
is active the user command is wrapped as `apply-seccomp <filter> <straced-cmd>`;
apply-seccomp simply execs the straced command, and the dumpable/ptrace_scope
analysis above already covers that nesting.

Residual risks to watch in Stage 4 (not blockers):
- The SIGTERM→SIGKILL escalation remains load-bearing for the ptrace-stop race
  documented in "Process-group / termination interaction"; keep it.
- If a future seccomp profile starts blocking `ptrace`, attach would fail; the
  Stage 4 startup capability check (verify strace can actually attach, not just
  that the binary exists) is what catches that — keep it as a real attach probe.

Repro scripts used: `/tmp/strace-spike.sh` (basic bwrap nesting) and
`/tmp/strace-spike-b.sh` (ptrace_scope=2 + PR_SET_DUMPABLE=0), run via
`docker run --rm --privileged debian:bookworm-slim`.

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
- Before moving on: record the outcome. Since there is no regex fallback, if
  attach fails everywhere we must redesign (e.g. strace outside bwrap) rather
  than ship a hard requirement that cannot be satisfied.

## Stage 4 — strace wrapping + parser + remove heuristic + startup check

**Status: DONE.** New `node/capabilities/strace.ts` module provides
`buildStraceCommand` (wraps the user command as
`strace -f -qq -e trace=file,network,process -e signal=none -o <file> -- bash -c '<cmd>'`),
`parseStraceViolations` (parses trace lines, capturing only EPERM/EACCES
syscalls as `SandboxViolationEvent`s with a readable `line` like
`openat("/secret.txt") -> EACCES`, de-duplicated), and the startup capability
check `assertStraceAvailable(platform, probe)` + `StraceUnavailableError` +
`defaultStraceProbe` (runs `strace ... -- true` to verify it can actually
attach, not just that the binary exists). `SandboxShell.execute` now, on Linux,
computes a per-command trace path (`toolLogDir(...)/command.strace`, with
`MAGENTA_TEMP_DIR` added to `allowWrite` so strace can write there), wraps the
user command with `buildStraceCommand` *before* `wrapWithSandbox` (strace nested
under bwrap), parses the trace file at the old detection point, and cleans up
the trace file in the `finally` block. The process-group/termination rationale
(strace nested under bwrap; SIGKILL escalation load-bearing) is documented as a
comment at the strace-wrapping call site. `detectLinuxSandboxViolations`,
`compileViolationPatterns`, and the `bwrapSandboxViolationPatterns` option
(type/default/merge/parse + all test literals) are **deleted**. The startup
check is wired into `initializeSandbox` (after the dependency check) and
`magenta.ts` rethrows `StraceUnavailableError` (refusing to start) instead of
swallowing it into "continue without sandbox". New `strace.test.ts` covers the
parser (denied-only, dedup, path extraction, empty), `buildStraceCommand`
shape/quoting, and the startup check (no-op off-Linux, throws on Linux when
probe fails). The Linux describe block in `sandbox-shell.test.ts` was rewritten
to drive the strace path via a fixture trace file. Shared `toolLogDir` helper
extracted in `shell-utils.ts`. `npx tsgo -b`, `npx biome check .`, and all
sandbox/options/capabilities tests pass.

Decision: trace files live under `MAGENTA_TEMP_DIR` (`/tmp/magenta/...`), and the
Linux path appends `MAGENTA_TEMP_DIR` to `allowWrite` so the sandbox permits
strace to record there.

**Code-review follow-up (Stage 4/5):**
- `StraceProbe` now returns a discriminated union
  `StraceProbeResult = { ok: true } | { ok: false; error: string }`, so invalid
  states (`{ ok: true, error }`, `{ ok: false }`) are unrepresentable. This let
  `assertStraceAvailable` drop the `result.error ?? "unknown error"` fallback —
  the failure branch now statically guarantees `error`.
- Added a unit test in `sandbox-shell.test.ts` ("Linux strace violation
  detection") asserting that on Linux the config passed to
  `updateConfigIfChanged` contains `MAGENTA_TEMP_DIR` in `filesystem.allowWrite`
  (the load-bearing augmentation that lets strace write its trace inside the
  sandbox).
- The `magenta.ts` sandbox-init catch handler (rethrow `StraceUnavailableError`
  vs. warn-and-degrade) was left as inline thin glue: extracting it for a unit
  test would over-engineer the wiring, and the throw contract is already covered
  at the `assertStraceAvailable` site.

- Goal: `SandboxShell` wraps the user command with strace on Linux and parses the
  trace file into `SandboxViolationEvent`s at the point
  `detectLinuxSandboxViolations` is called today. **Delete**
  `detectLinuxSandboxViolations`, `compileViolationPatterns`, and the
  `bwrapSandboxViolationPatterns` option. Add a startup capability check that
  refuses to start magenta on Linux when strace is missing or cannot attach.
  Trace file cleaned up with the command.
- Add a comment at the strace-wrapping call site documenting the process-group /
  termination interaction (strace nested under bwrap; SIGKILL escalation is
  load-bearing for ptrace-stop races), per the "Process-group / termination
  interaction" section above.
- Verification:
  - Behavior (unit): the trace parser turns fixture strace output into the
    expected violation events.
    - Setup: representative strace lines (multi-process `-f`, `EACCES`/`EPERM`
      on `openat`/`connect`/`execve`, plus unrelated successful syscalls).
    - Actions: run the parser.
    - Expected: only denied syscalls become events, each with a readable `line`
      and the correct path/target; successes ignored; dedup preserved.
  - Behavior (unit): strace-unavailable ⇒ startup capability check fails.
    - Setup: capability check stubbed to "absent".
    - Actions: invoke the startup check on Linux.
    - Expected: magenta refuses to start with a clear error; no command runs.
- Before moving on: tests, type checks, lint pass.

## Stage 5 — configurable auto-allow options (Part 3)

**Status: DONE.** Added `OnUnknownHostBehavior = "prompt" | "allow" | "deny"`
and extended `SandboxConfig` (`node/options.ts`) with
`network.onUnknownHost` and a `strace: { autoAllowViolations: boolean }` block;
`DEFAULT_SANDBOX_CONFIG` defaults them to `"prompt"` / `false` (current
behavior). `parseSandboxConfig` parses both (enum-validates `onUnknownHost`,
warning + defaulting to `"prompt"` on bad values; warns on non-boolean
`autoAllowViolations` and on non-object `strace`). `mergeSandboxConfigs` takes
the overlay's scalar value for both fields (last-writer-wins, project overrides
user). Wiring: `SandboxShell.networkAskTarget` consults
`sandbox.network.onUnknownHost` — `"deny"` resolves `false` with no UI,
`"allow"` resolves `true` (recording the session host) with no UI, `"prompt"`
surfaces the prompt; the empty-stack deny in `routeNetworkAsk` is unaffected.
`runWrappedAndHandleViolations` consults `sandbox.strace.autoAllowViolations` —
when `true`, a captured violation re-runs the command unsandboxed directly
without an approval prompt.

Decision (merge semantics): because `parseSandboxConfig` always fills these
scalars with defaults, `mergeSandboxConfigs` is literal last-writer-wins
(overlay value taken), mirroring the existing scalar-merge style. When neither
layer sets a value both are the default, so defaults reproduce current behavior
exactly.

Tests: `options.test.ts` covers parse of valid values, invalid-enum
warn+default, omitted-field defaults, and project-over-user scalar override via
`mergeOptions`. `sandbox-shell.test.ts` covers `onUnknownHost: "allow"`
auto-approve-no-prompt, `"deny"` reject-no-prompt, and
`strace.autoAllowViolations: true` re-run-unsandboxed-without-prompt, plus the
session-symmetry invariant (a `recordSessionApprovedHost` spy fires for
`"allow"` but not for `"deny"`). Updated
existing `SandboxConfig` literals (sandbox-shell/options/sandbox-manager tests)
for the new required fields. `npx tsgo -b`, `npx biome check .`, and all
options/sandbox/core test suites pass.

- Goal: add `network.onUnknownHost` and `strace.autoAllowViolations` to
  `SandboxConfig`/`DEFAULT_SANDBOX_CONFIG`, parse them in `parseSandboxConfig`,
  merge them in `mergeSandboxConfigs`, and consult them in the Part 1
  `askCallback` and Part 2 `SandboxShell`.
- Verification:
  - Behavior (unit): `parseSandboxConfig` reads valid values; invalid enum
    values warn and fall back to defaults; omitted fields use defaults.
  - Behavior (unit): `mergeSandboxConfigs` lets a project-level scalar override a
    user-level scalar (last-writer-wins).
  - Behavior (integration): `network.onUnknownHost: "allow"` auto-resolves the
    ask callback `true` with no prompt; `"deny"` auto-resolves `false` with no
    prompt; `"prompt"` reproduces Stage 2 behavior.
  - Behavior (integration): `strace.autoAllowViolations: true` re-runs
    unsandboxed without a prompt; `false` surfaces the approval prompt.
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

# Objective and Context

User request (verbatim):

> I want to make some improvements to scripts:
>
> - bells from subthread yields in a script should not propagate up to the thread level, since the script will continue running. Only things that require user attention (waiting on approval, error, or whole script done) should bell
> - script bells should propagate to the neovim window
> - more obvious visual distinction in script summary of what's a log message and what's a subthread
> - multiple invocations of the script should show up separately on the thread overview. Most recent on top. Each individually collapsible

## What we're building

Four related improvements to the magenta "scripts" feature (programmatic
orchestration of magenta threads):

1. **Quiet script subthread yields.** A script spawns real magenta threads via
   `chat.spawnScriptThread`. Each is an in-process `Thread` whose `turnEnded`
   listener currently fires a chime + terminal bell on every `end_turn`/`error`.
   For a script, a subthread finishing (yielding) is routine — the script keeps
   running — so those bells are noise. We want script-owned threads to be silent
   on normal turn ends, and only bell for events that need the user:
   *waiting on approval*, *error*, or *the whole script finishing*.

2. **Make script bells reach the neovim editor.** Today `sendTerminalBell`
   writes BEL (`\x07`) to channel 2 (the host terminal). Script-level
   notifications should also ring the neovim instance itself.

3. **Distinguish logs vs. subthreads in the script summary.** In
   `ScriptManager.view()`, log entries render as `• message` and thread entries
   render as a thread subtree; the visual difference is weak. Make it obvious.

4. **List script invocations separately, newest first, each collapsible.**
   Invocations already render separately and are individually collapsible via
   `expandedInvocations`, but they render in insertion (oldest-first) order.
   Newest should be on top.

## Key entities and files

- `node/scripts/script-manager.ts` — `ScriptManager`: tracks `invocations`
  (`Map<ScriptInvocationId, ScriptInvocation>`), `expandedInvocations`, handles
  child-process IPC (`log`, `create-thread`, `done`, `error`), and renders the
  `# Scripts` section via `view()`.
- `node/chat/thread.ts` — `Thread`: wraps a `ThreadCore`. `coreListeners.turnEnded`
  calls `playChimeSound()` + `sendTerminalBell()`. These two private methods hold
  the notification logic.
- `node/chat/chat.ts` — `createThreadWithContext` (constructs `Thread`,
  threads through `scriptInvocationId` into the wrapper) and `spawnScriptThread`.
  Also owns sandbox `onPendingChange` wiring (dispatches `permission-pending-change`).
- `node/capabilities/sandbox-violation-handler.ts` — `SandboxViolationHandler`;
  `addViolation` / `promptForApproval` / `promptForWriteApproval` call
  `onPendingChange()` when a prompt becomes pending.

# Design

## Notification helper

Extract the chime + bell logic out of `Thread` into a small reusable notifier
(e.g. `node/chat/notify.ts`) that takes `{ nvim, options }` and exposes a single
`notifyUser()` that plays the chime (respecting `chimeVolume`) and rings the
bell (respecting `bellOnNotify`). `Thread.playChimeSound`/`sendTerminalBell`
become thin calls into it (or are replaced). `ScriptManager` uses the same
helper so script-level notifications are identical to thread-level ones.

For improvement 2, `notifyUser()` should ring the actual neovim editor in
addition to the channel-2 terminal bell. **Open implementation detail:** the
exact mechanism for ringing the editor needs to be confirmed during
implementation — options include sending BEL over the RPC channel, or
`nvim_command` to trigger neovim's own bell. Confirm which actually surfaces in
the user's editor before settling on it; keep it behind the same `bellOnNotify`
option.

## Silencing script subthreads (improvement 1)

No thread introspection is needed. The rule is general: **any thread that ends
with a yield does not bell.** A yield means control is handed back to a parent
(a script, or a spawning thread), so it never needs the user. In
`coreListeners.turnEnded`, skip chime/bell when the thread ended in the yielded
state (`core.state.mode.type === "yielded"`). This covers script subthreads
(which always yield) as well as ordinary subagents that yield, with no
`scriptInvocationId` plumbing. Threads that end normally (`end_turn` without a
yield) or with an `error` keep belling as before; script-level error/done bells
are owned by `ScriptManager`.

Waiting-on-approval: a pending prompt arises via the
`SandboxViolationHandler.onPendingChange` callback. Bell on the rising edge when
the pending-approval set transitions empty → non-empty (this is also general —
any thread blocked on a prompt needs the user). Guard against repeated bells
while prompts remain pending (only bell on the rising edge).

## Script-level bells (improvements 1 + 2)

We already detect script completion (the `done` IPC message / subprocess exit,
which flips the invocation to the `done` status shown in the summary) and
errors. Hook the bell into those existing transitions in
`ScriptManager.handleChildMessage` / `handleChildExit`:
- `case "done"` (and the `handleChildExit` fallback): fire `notifyUser()` once.
- `case "error"`: fire `notifyUser()` once.

`ScriptManager` already has `nvim` and `getOptions` in its context, so it can
construct/use the notifier directly.

## Logs vs. subthreads in the summary (improvement 3)

In `ScriptManager.view()`, when expanded, give log entries and thread entries a
clearly different visual treatment. Keep it within the existing `d` template /
`withExtmark` styling used elsewhere (e.g. an icon/label or highlight group for
logs vs. a distinct header for a spawned thread subtree). Avoid restructuring
the `entries` model — the ordered `ScriptInvocationEntry[]` already interleaves
`{type:"log"}` and `{type:"thread"}` correctly.

## Newest-first invocations (improvement 4)

`ScriptInvocationId` is a uuidv7 (time-ordered). In `view()`, iterate
invocations sorted by id descending instead of raw `Map` insertion order. Each
row remains independently collapsible via the existing `expandedInvocations`
set and `=` binding — no change needed there.

Invariants:
- Threads that end without yielding keep their current chime/bell behavior.
- A thread that ends in the yielded state must never bell; the script must still
  bell on approval-needed, error, and completion.
- Approval bells fire once per rising edge (no repeat spam while a prompt sits
  pending).
- Reordering invocations must not break the expand/collapse, open-file, or
  sandbox-toggle bindings (keyed by invocation id, so order-independent).

# Stages

## Stage 1: Extract the notification helper

- Goal: a single `notifyUser({nvim, options})` helper performs chime + bell;
  `Thread` uses it with identical observable behavior to today. Decide and
  implement the neovim-editor bell (improvement 2) here, behind `bellOnNotify`.
- Verification:
  - Behavior: a normal (non-script) thread turn end still chimes/bells.
  - Setup: existing thread tests / `withDriver`; spy on the nvim bell call and
    on the chime player.
  - Actions: drive a thread to `end_turn`.
  - Expected outcome: bell + chime invoked exactly as before, plus the new
    editor bell path is exercised.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 2: Silence yielding threads, bell on approval

- Goal: a thread that ends in the yielded state no longer chimes/bells; a thread
  that becomes blocked on a pending approval bells once on the rising edge.
- Verification:
  - Behavior: a thread reaching turn end via yield produces no bell; a thread
    ending normally (no yield) still bells.
  - Setup: `script-manager.test.ts` style harness (script + yielding subthread)
    plus a non-yielding thread; spy on `notifyUser`/bell.
  - Actions: let a subthread yield; separately, trigger a sandbox violation to
    create a pending prompt.
  - Expected outcome: no bell on yield; exactly one bell when the prompt becomes
    pending; non-yielding threads unaffected.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 3: Script-level bells on done/error

- Goal: `ScriptManager` bells when an invocation transitions to `done` or
  `error`.
- Verification:
  - Behavior: completing a script fires one notification; an erroring script
    fires one notification.
  - Setup: script test harness; spy on the notifier.
  - Actions: run a script to completion; run one that throws.
  - Expected outcome: exactly one bell per terminal transition.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 4: Summary visual distinction + newest-first ordering

- Goal: logs and subthreads are visually distinct in the expanded summary, and
  invocations render newest-first while remaining individually collapsible.
- Verification:
  - Behavior: with multiple invocations, the most recent renders first; expand
    state is per-invocation; logs and threads are visually different.
  - Setup: script test harness running the same script twice with interleaved
    log + thread entries.
  - Actions: render the overview; toggle expand on one invocation.
  - Expected outcome: ordering is newest-first; toggling one invocation does not
    affect others; rendered output distinguishes log vs. thread entries.
- Before moving on: confirm tests, type checks, and linting all pass.

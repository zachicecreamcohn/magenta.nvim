# Objective and Context

## User request (verbatim)

> let's make the spawn_subagents tool preview the command as it's streaming in. Let's partially parse the input, and try to extract the various fields (shared prompt, shared context files, and the agents array). Build up an abridged summary of the call as it's streaming:
>
> ```
> sharedPrompt: (+~Ntok)... the shared prompt up to a certain length, trimmed to the end, udpated as it's streaming.
> sharedContextFiles:
>   - list
>   - of
>   - files
>   - <CR> should go to the file
> agents:
>   - agent type, environment, dockerfile, directory, workspacePath if specified (all on one line)
>     prompt: (same as the shared prompt, trimmed tail of the prompt, updated as streaming)
>     contextFiles:
>       - list
>       - of
>       - files
>       - <CR> should go to the file
> ```
>
> also look at the current tool invocation / tool result / tool in progress display, which is a bit lacking compared to this. Let's try and unify these views a bit (by enhancing the existing views to be more in line with the streaming view we're creating).
>
> let's make a plan

## What we're building and why

The `spawn_subagents` tool currently shows nothing useful while its input streams in (it falls through to the generic `Invoking tool spawn_subagents` line in `renderStreamdedTool`). Once the call completes, the progress and result views show a compact one-line-per-agent summary but omit `sharedPrompt`, `sharedContextFiles`, per-agent `contextFiles`, and most per-agent metadata (environment, dockerfile, directory, workspacePath).

We want:

1. A **streaming preview** that incrementally parses the partial JSON input and renders an abridged, structured summary of the whole call (shared prompt tail, shared context files, and per-agent rows with their metadata, prompt tail, and context files).
2. To **unify** the streaming preview with the existing in-progress / result / invocation views so they share the same structured layout, with the non-streaming views additionally carrying per-agent status icons and `<CR>` navigation bindings (to child threads, and to files for context-file lists).

## Key entities

- `SpawnSubagents.Input` / `SubagentEntry` (`node/core/src/tools/spawn-subagents.ts`) — the validated tool input shape. The streaming preview needs a *partial* version of this where every field may be missing/incomplete.
- `extractPartialJsonStringValue` (`node/core/src/tools/helpers.ts`) — existing tolerant extractor, but only handles a single top-level string key. Insufficient for the nested `agents`/arrays structure.
- `renderStreamdedTool` (`node/render-tools/streaming.ts`) — renders the streaming `tool_use` block. Receives only the `AgentStreamingBlock` (with `.inputJson`); **no dispatch/context**, so streaming preview is static text only (no bindings).
- `SpawnSubagentsRender` (`node/render-tools/spawn-subagents.ts`) — `renderSummary`, `renderInput`, `renderProgress`, `renderResult`, `renderResultSummary`. The progress/result variants receive `context` (dispatch, threadDispatch, chat) and `toolViewState`, so they can attach bindings and expand/collapse.
- `AgentRowRenderInfo` + `renderAgentRowContent` (in the same file) — current one-line-per-agent renderer to be extended.
- `open-edit-file` threadDispatch message (`node/chat/thread.ts`) — used by the edl view to make `<CR>` open a file; reuse for context-file rows.

# Design

## Partial input parsing (core)

Add a tolerant parser in core that turns a partial `inputJson` string into a best-effort `PartialInput` view object:

```
type PartialSubagentEntry = {
  agentType?: string;
  environment?: string;
  directory?: string;
  dockerfile?: string;
  workspacePath?: string;
  prompt?: string;
  contextFiles?: string[];   // may be incomplete; last element may be a partial filename
};

type PartialSpawnSubagentsInput = {
  sharedPrompt?: string;
  sharedContextFiles?: string[];
  agents: PartialSubagentEntry[];
};
```

### Algorithm

A **recursive-descent parser** (LL(1)/predictive): one function per grammar production (object, string-array, string), each consuming from a single shared cursor `pos`. Descending into a subtree is just calling the sub-production's function — the call stack *is* the context, so nesting is tracked by recursion rather than manually.

Two additions make it tolerant of truncated input ("best-effort parsing with error recovery"):

1. **Attach-then-fill** — wire each container into the result tree before populating it (push `entry = {}` onto `agents` first, then fill its fields). Nothing parsed so far is lost when we stop.
2. **EOF sentinel** — running past end-of-string throws a private `EOF`; the top-level catches it and returns the result-so-far.

`parseString` reuses the escape-decoding rules from `extractPartialJsonStringValue` and returns its partial value at EOF (the trailing token we want to show). The grammar only covers the known string keys plus the `agents`/`contextFiles`/`sharedContextFiles` arrays; unknown keys are skipped. Since the schema has no numbers/bools/null, the parser stays small.

This lives in core (e.g. `node/core/src/tools/spawn-subagents.ts` or a sibling helper) and is exported through `node/core/src/index.ts`, so both the streaming renderer and the validated-input renderers can use the same shape. The fully-validated `Input` is structurally a superset of `PartialSpawnSubagentsInput`, so non-streaming views can adapt their already-parsed `request.input` to the same rendering helper without re-parsing.

Rationale for a dedicated parser over "auto-close the JSON then JSON.parse": auto-closing is fragile around escape sequences and partial unicode escapes, and silently drops the in-progress trailing token (exactly the tail we most want to show). A purpose-built tolerant parser gives us the trailing partial values for free.

## Shared rendering helper (root)

Introduce one rendering function in `node/render-tools/spawn-subagents.ts` that takes:

- a `PartialSpawnSubagentsInput`-shaped value (works for both partial-stream and fully-validated input),
- an optional per-agent "status" resolver (icons/details/threadId/bindings) — absent during streaming, present for progress/result,
- optional view state (expanded flags) + a binding factory.

It produces the unified layout:

```
sharedPrompt: (+~Ntok) …<trimmed tail>
sharedContextFiles:
  - path/a
  - path/b
agents:
  - <icon?> <agentType> [docker|docker_unsupervised] dockerfile=… dir=… ws=…   <status?>
    prompt: (+~Ntok) …<trimmed tail>
    contextFiles:
      - path/x
```

Details:

- **Prompt tail**: show a token estimate (`formatTokens`) plus the trailing N chars of the prompt (trim to the *end* so the most recently streamed text is visible), single-lined or with a small fixed number of tail lines. Pick one consistent trimming rule and reuse for both `sharedPrompt` and per-agent `prompt`.
- **Agent metadata line**: only include fields that are present (`agentType`, `environment` when not `host`, `dockerfile`, `directory`, `workspacePath`), space-joined on one line. Keep the docker 🐳 marker.
- **Context file rows**: one `- path` per line. In non-streaming views each row gets `<CR>` → `open-edit-file`. During streaming they are plain text (no context available).
- **Status icon/detail and `<CR>`→child-thread** continue to come from the existing `resolveAgentRowFrom*` helpers for progress/result; during streaming there is no status segment.

Then:

- `renderStreamdedTool`'s `spawn_subagents` case parses `block.inputJson` via the core parser and calls the shared helper (status resolver absent) → returns static `VDOMNode`.
- `renderProgress` and `renderResult` call the shared helper with the status resolver + bindings, replacing the current bespoke row construction while preserving existing expand/collapse (`=`) and child-thread navigation behavior.
- `renderInput` can render the shared helper (static, from validated input) instead of returning `undefined`, so the awaiting-approval invocation view matches.
- `renderSummary` / `renderResultSummary` (the collapsed one-liners) stay as-is.

Invariants:
- The parser must never throw on any prefix of a valid `spawn_subagents` input JSON; it returns whatever is known so far.
- Streaming preview is render-only with no bindings (no dispatch in `renderStreamdedTool`); file/thread navigation only appears in progress/result/input views.
- Non-streaming views must preserve current behavior: per-agent status icons, `<CR>`→child thread, `=` expand/collapse, pending-approval rendering.
- `host` environment is the default and must not be shown in the metadata line; `agentType` of `default`/absent is suppressed as today.
- Rendering must tolerate `agents` being empty or absent (show header with no rows, or nothing, matching current empty-state behavior).

# Stages

## Stage 1 — Tolerant partial parser in core

- Goal: `parsePartialSpawnSubagentsInput(inputJson)` returns a correct best-effort `PartialSpawnSubagentsInput` for any prefix of a valid input, exported from `@magenta/core`.
- Verification (unit, sibling to `helpers.test.ts`):
  - Behavior: empty/`{`/`{"shared` prefixes yield empty-ish results without throwing.
    - Setup: array of progressively longer prefixes of a known full input JSON.
    - Actions: parse each prefix.
    - Expected: monotonic — each field, once it appears, matches the final value (modulo trailing partial token); never throws.
  - Behavior: nested agents with `contextFiles` partially streamed return parsed-so-far arrays and a trailing partial string element.
  - Behavior: escapes (`\n`, `\"`, `\\`, `\u####`) inside prompts decode correctly, including a truncated escape at end-of-input.
- Before moving on: confirm `npx vitest run node/core/`, `npx tsgo -b`, and `npx biome check .` pass.

## Stage 2 — Shared rendering helper + streaming preview

- Goal: `spawn_subagents` shows the structured abridged preview while streaming.
- Build the shared layout helper and wire the `spawn_subagents` case in `renderStreamdedTool`.
- Verification (integration, following `node/render-tools/spawn-subagents.test.ts` and the doc-testing skill):
  - Behavior: as input streams, the display buffer shows `sharedPrompt:`, `sharedContextFiles:` with file rows, and per-agent rows with metadata + prompt tail.
    - Setup: mock provider emitting a `spawn_subagents` tool_use block in chunks (partial `inputJson`).
    - Actions: advance streaming; read display buffer.
    - Expected: structured preview appears and updates; no crash on partial chunks.
- Before moving on: confirm full test suite, type checks, and linting pass.

## Stage 3 — Unify progress / result / invocation views

- Goal: progress, result, and invocation (`renderInput`) views render via the same shared helper, now showing sharedPrompt, sharedContextFiles, per-agent metadata and contextFiles, while preserving status icons, `=` expand/collapse, `<CR>`→child thread, and adding `<CR>`→file on context-file rows.
- Verification (integration):
  - Behavior: existing navigation tests (click row → select child thread) still pass.
  - Behavior: clicking a context-file row dispatches `open-edit-file` for that path.
    - Setup: completed spawn with an agent that has `contextFiles`.
    - Actions: trigger `<CR>` on a context-file row.
    - Expected: file opens (assert via the same mechanism edl file-open tests use).
  - Behavior: `=` still toggles per-item expansion for progress and result.
- Before moving on: confirm full test suite, type checks, and linting pass.

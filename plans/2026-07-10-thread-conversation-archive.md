# Objective and Context

## User request (verbatim)

I'd like to persist thread text in an archive. This should be just the text of the conversation - so the user messages, assistant responses, tool calls and tool results - persisted for recovery of conversations. I don't think it's important for these to be resumable.

In that way it's kind of like the text representation that we feed into compact... except:

- I want full text, including full tool request and results. Compact abridges/skips these because that's not essential for figuring out the context of the conversation
- I want this to be an append-only log, and commit to the file on every message. So if the thread crashes, we can still see the old conversations
- let's store this in /tmp/magenta/threads/ ... use a json format. I think we can use the generalized ProviderMessages. Every time a message is finalized, we can append it to the log.
- log compact tool requests and thread restarts
- make sure you cover thread forking.

I think one model could be that we just keep a logger attached to the thread. The logger is notified of thread changes and maintains a "last persisted message" to the file. The logger is async relative to the thread and is best-effort (so it doesn't block thread UI or execution on fs writes). The logger maintains the last message it logged. The thread notifies the logger of compaction events and such (or rather, can push events into the log, and can tell the logger to reset the message counter).

Is a counter / message idx the best way? Do we already have message ids that we can use?

## Restatement

We want an append-only, best-effort archive of every thread's full conversation, written to disk as it happens, so that if the process crashes the conversation transcript survives. Unlike compaction (which abridges tool calls/results and skips thinking), this archive keeps the **full** `ProviderMessage` content. It is a recovery/audit artifact, not a resumable session format.

Storage: one JSONL file per thread at `/tmp/magenta/threads/{threadId}/conversation.jsonl`. This directory already exists as the home for per-thread tool logs (`/tmp/magenta/threads/{threadId}/tools/...`, see `node/capabilities/shell-utils.ts`), so we are extending an established convention.

## The "message id vs counter" question

There is a `NativeMessageIdx` (`node/core/src/providers/anthropic-agent.ts`) — a branded integer that indexes a content block's position in the current agent's `messages` array. It is **not** a stable global id: it resets whenever the agent instance is replaced (compaction, and, at the point of a fork, the child agent shares indices with the parent up to the fork point). There is no durable per-message id.

Therefore the logger should **not** rely on `NativeMessageIdx` as a global key. Instead it tracks a simple in-memory cursor: the number of `ProviderMessage`s in the **current agent generation** it has already appended. When the agent instance is replaced (compaction / restart), the cursor resets to 0 and the file keeps growing (a marker event separates generations). This is the "counter" the user hypothesized, scoped per-agent-generation rather than per-thread.

## Key types and entities

- `ProviderMessage` (`node/core/src/providers/provider-types.ts:42`) — `{ role, content: ProviderMessageContent[], stopReason?, usage? }`. `ProviderMessageContent` (line 187) is the discriminated union covering text, tool_use, tool_result, thinking, context_update, fork_notification, etc. This is what we serialize verbatim.
- `ThreadCore` (`node/core/src/thread-core.ts`) — owns the `Agent`, exposes `getProviderMessages(): ReadonlyArray<ProviderMessage>`, emits `update` and `turnEnded` events, and is the site where the agent is replaced on compaction (`createFreshAgent()`, ~line 519/1520) and cloned on fork (`static clone`, ~line 271).
- `ThreadId` (`node/core/src/chat-types.ts:5`) — nominal string, the file key.
- Node `fs` (`node:fs`/`node:fs/promises`) — used directly. This archive is magenta-internal plumbing (like diagnostic logging), not agent-visible file I/O, so it deliberately does **not** go through the `FileIO` abstraction. This mirrors `node/capabilities/shell-utils.ts` and `node/nvim/nvim-node/logger.ts`, which touch the real filesystem directly.

## Relevant files

- `node/core/src/thread-core.ts` — owns the logger, feeds it events, notifies it of agent replacement and fork.
- `node/core/src/capabilities/file-io.ts` — add `appendFile`; `FsFileIO` real impl; in-memory impl for tests.
- `node/core/src/utils/files.ts` — `MAGENTA_TEMP_DIR = /tmp/magenta`; add a helper for the conversation log path.
- New: `node/core/src/thread-logger.ts` — the `ThreadLogger` class.
- `node/core/src/providers/provider-types.ts` — source of the `ProviderMessage` shape (no change expected).
- `node/capabilities/shell-utils.ts` / `node/nvim/nvim-node/logger.ts` — reference patterns for best-effort direct-fs writes.

# Design

## Component: `ThreadLogger`

A small class living in core (no nvim dependency; it uses node `fs/promises` directly plus a `Logger` and the `ThreadId`). It owns:

- `filePath: string` — `/tmp/magenta/threads/{threadId}/conversation.jsonl`.
- `persistedCount: number` — how many messages of the **current** agent generation have been written.
- `queue: Promise<void>` — a serialized async chain so writes never interleave and never race.
- `ready: Promise<void>` — resolves once the directory has been ensured (`mkdir -p`).

### Log format (JSONL)

Each line is one JSON object with a `type` discriminant:

- `{ type: "thread_start", threadId, timestamp, threadType }` — first line written when the logger is created.
- `{ type: "fork", timestamp, fromThreadId, nativeMessageIdx }` — written on a forked thread's logger before its messages, recording provenance.
- `{ type: "message", timestamp, message: ProviderMessage }` — one per finalized conversation message, full content.
- `{ type: "compaction", timestamp, summary?, chunkCount }` — written when compaction replaces the agent, before the new generation's messages begin.
- `{ type: "restart", timestamp }` — written when the agent is otherwise replaced/reset.

JSONL is chosen because it is inherently append-only and crash-tolerant: a torn final line on crash still leaves all prior lines intact and parseable.

### Persisting messages

The logger exposes `flushMessages(messages: ReadonlyArray<ProviderMessage>)`. It appends every message at index `>= persistedCount`, then sets `persistedCount = messages.length`. All appends are enqueued on `queue`; the method returns immediately (fire-and-forget from the caller's perspective).

The subtlety is **when a message is "finalized."** A turn produces several `ProviderMessage`s in sequence (user, assistant-with-tool_use, tool_result user message, assistant continuation...). The last element of the array can still be mutating while the assistant streams. So:

- On `turnEnded` (`end_turn` | `aborted` | `error`) the whole turn is stable → flush all messages. This is the primary, safe finalization signal.
- To reduce loss of an in-progress turn on crash, also flush on `update`, but only messages strictly before the last one (`messages.slice(0, length-1)` are stable; the final one may be streaming). This gives near-per-message durability without ever writing a half-streamed block. Implement by having `flushMessages` take a `stableCount` = either `messages.length` (turnEnded) or `messages.length - 1` (update).

Because appends are idempotent-by-cursor (`persistedCount`), flushing on both `update` and `turnEnded` never double-writes.

### Agent replacement (compaction & restart)

ThreadCore replaces `this.agent` in two places: post-compaction (`createFreshAgent()` around line 1520) and any restart path. The new agent's `getProviderMessages()` starts fresh (idx 0, seeded with the compaction summary as context). So ThreadCore must, at each replacement:

1. Call `logger.recordCompaction({ summary, chunkCount })` (or `recordRestart()`), which enqueues the marker line.
2. Call `logger.resetCursor()` which sets `persistedCount = 0` so the new generation's messages are appended fresh.

Ordering matters: the marker must be enqueued before the reset so the file reads marker-then-new-messages. Both operations go through the same serialized `queue`, preserving order.

### Forking

`ThreadCore.clone` builds a new ThreadCore whose agent already holds the parent's messages truncated to `nativeMessageIdx`. The child gets its **own** logger (new threadId → new file). On construction the child logger writes `thread_start` then a `fork` marker (with `fromThreadId` and `nativeMessageIdx`), and its `persistedCount` starts at 0 — so the first `update`/`turnEnded` flush writes the entire inherited history into the child's file. This makes each child file self-contained. The parent's log is untouched and continues independently.

To pass fork provenance, `ThreadLogger`'s constructor takes an optional `forkedFrom: { fromThreadId, nativeMessageIdx }`.

### Best-effort / non-blocking

- Every fs interaction is wrapped so a rejection is caught and sent to `logger.error(...)` (the diagnostic Logger) and then swallowed — never rethrown, never awaited by thread execution or UI. This mirrors the existing best-effort pattern in `shell-utils.ts` (`.on("error", () => {})`).
- ThreadCore's event handlers call the logger synchronously but do not `await` it.

### Filesystem access

The logger uses `node:fs/promises` directly: `fs.mkdir(dir, { recursive: true })` once via the `ready` promise, then `fs.appendFile(filePath, line)` per event, all serialized through `queue`. No `FileIO` abstraction is involved — this is internal plumbing, consistent with `shell-utils.ts` and `logger.ts`. Tests exercise it against a real temp directory under `MAGENTA_TEMP_DIR` (created and cleaned up per test), reading the file back to assert on the JSONL.

## Invariants

- The archive is append-only: existing bytes are never rewritten or truncated. A crash at any point leaves a valid prefix of JSONL lines.
- No message is written before it is stable: the currently-streaming last message is only flushed once `turnEnded` fires.
- `persistedCount` monotonically increases within an agent generation and is reset to 0 exactly when (and only when) `this.agent` is replaced, and only after the corresponding marker line is enqueued.
- Logging failures never propagate to thread execution or UI (best-effort).
- Each thread (including each fork) has exactly one log file; forks never share a file with their parent.
- Serialized write queue guarantees markers and messages land in causal order.

## Alternatives considered

- **Using `NativeMessageIdx` as the durable key** — rejected: it is per-agent-generation and resets on compaction/fork, so it cannot serve as a global cursor. The per-generation `persistedCount` is simpler and correct.
- **Reusing the compaction renderer (`renderThreadToMarkdown`)** — rejected: it deliberately abridges tool results and drops thinking/reminders; the user explicitly wants full fidelity. Serializing raw `ProviderMessage` is the faithful representation.
- **Routing through the `FileIO` abstraction** — rejected: `FileIO` is the agent-visible file I/O seam; the archive is magenta-internal (like diagnostic logging) and should not be coupled to it. Direct `fs` calls match existing internal-plumbing patterns.
- **A single long-lived `fs.createWriteStream`** — viable and slightly cheaper per write, but per-event `fs.appendFile` through the serialized queue is simpler, and the volume is low. Chosen for simplicity.

# Stages

## Stage 1: `ThreadLogger` in isolation ✅ COMPLETE

Implemented `node/core/src/thread-logger.ts` (`ThreadLogger`) plus `threadConversationLogPath` helper in `node/core/src/utils/files.ts`, and unit tests in `node/core/src/thread-logger.test.ts` (5 tests, all passing). Decisions/deviations:
- `flushMessages(messages, stableCount = messages.length)` — the `stableCount` param handles both `update` (N-1) and `turnEnded` (N) cases as planned.
- Exposed `flushed(): Promise<void>` (awaits the internal queue) so tests can deterministically wait for writes.
- `recordCompaction` omits `summary` from the entry when undefined (exactOptionalPropertyTypes).
- Test `msg()` stamps a dummy `nativeMessageIdx` to satisfy `ProviderTextContent`.
- Full core suite (597 tests), `tsgo -b`, and biome all green.

- Goal: a standalone `ThreadLogger` that, given a `ThreadId` and a base dir, writes `thread_start`, appends messages by cursor, records compaction/restart markers, resets its cursor, and records fork provenance — all through a serialized best-effort queue, using node `fs` directly.
- Verification (unit, against a real temp dir under `MAGENTA_TEMP_DIR`, cleaned up per test):
  - Behavior: flushing a growing message array only appends the new tail.
    - Setup: logger with empty file; call `flushMessages` with 1 message, then with 3 messages.
    - Actions: read the file, parse JSONL.
    - Expected outcome: one `thread_start` line, then exactly 3 `message` lines (no duplicate of the first).
  - Behavior: `update`-style flush withholds the streaming last message; `turnEnded`-style flush includes it.
    - Setup: array of N messages.
    - Actions: flush with `stableCount = N-1`, then `stableCount = N`.
    - Expected outcome: N-1 lines after first flush, N after second.
  - Behavior: compaction marker then cursor reset lets the next flush re-append from 0.
    - Setup: flush 3 messages; call `recordCompaction` + `resetCursor`; flush a fresh 2-message array.
    - Actions: parse JSONL.
    - Expected outcome: 3 messages, a `compaction` line, then 2 messages, in that order.
  - Behavior: fork provenance is written before inherited history.
    - Setup: construct logger with `forkedFrom`; flush inherited messages.
    - Expected outcome: `thread_start`, `fork` (with fromThreadId + idx), then the messages.
  - Behavior: a failing fs write does not throw.
    - Setup: point the logger at an unwritable path (e.g. a dir that cannot be created).
    - Actions: call `flushMessages`.
    - Expected outcome: no rejection surfaces; error routed to the diagnostic logger.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 2: Wire `ThreadLogger` into `ThreadCore`

- Goal: ThreadCore constructs a logger, flushes on `update` (stable-minus-one) and `turnEnded` (all), records+resets on agent replacement (compaction and restart), and passes fork provenance through `clone`.
- Verification (integration, using the ThreadCore test harness; archive written under a temp dir):
  - Behavior: a normal turn writes its full messages to the archive.
    - Setup: ThreadCore pointed at a temp archive dir; run a mock turn with a tool call + tool result.
    - Actions: after `turnEnded`, read the JSONL.
    - Expected outcome: message lines include the user message, assistant tool_use with full request, and the full tool_result content.
  - Behavior: compaction inserts a `compaction` marker and continues appending.
    - Setup: drive a compaction so the agent is replaced.
    - Expected outcome: pre-compaction messages, a `compaction` line, then post-compaction messages, all in one file.
  - Behavior: a forked thread's file is self-contained and marked.
    - Setup: `ThreadCore.clone` at a fork idx, then run a turn on the child.
    - Expected outcome: child file has `thread_start`, `fork` (correct fromThreadId + nativeMessageIdx), the inherited history, then the new turn's messages; parent file unaffected.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 3: Path + directory-creation sanity

- Goal: confirm the path helper produces `/tmp/magenta/threads/{threadId}/conversation.jsonl` and that the directory is created once (mkdir -p) on first write.
- Verification:
  - Behavior: end-to-end write to a real temp path.
    - Setup: a temp threadId under `MAGENTA_TEMP_DIR`.
    - Actions: construct logger, flush a message, await the queue, read back.
    - Expected outcome: file exists with valid JSONL; directory auto-created.
- Before moving on: confirm the full test suite, type checks, and linting all pass.

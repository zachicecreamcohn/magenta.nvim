# Objective and Context

## User request (verbatim)

> I want to make some improvements to the fork thread behavior. When we fork, let's add a user message informing the agent "the user forked this thread at this point". This will help the agent switch gears and answer any followup questions the user may have.
>
> This notification should have a special display in the thread, that says "forked from <id>", so that the thread id navigates to the parent thread via <CR>
>
> On the origin thread, we should have a message too, saying "forked to thread <id>". This should not be reflected in the actual agent/messages, but just be display state visually indicating the fork. Pressing <CR> on this message should take you to the forked thread.

## What we're building

Two visual fork markers tied to a single fork action:

1. **On the forked (child) thread** — a real user message is appended to the agent's
   conversation telling the model the user forked the thread here. It is rendered
   specially as `forked from <parentId>`, and `<CR>` navigates to the parent thread.
   Because it is a real agent message, the model sees it and can switch gears.

2. **On the origin (parent) thread** — a display-only marker `forked to thread <childId>`
   that is NOT part of the agent message list (the model never sees it). It lives in the
   parent Thread's view state. `<CR>` navigates to the child thread. A parent may be forked
   multiple times, so this is a list.

## Key entities

- `ThreadCore.clone` (`node/core/src/thread-core.ts:229`) and `Thread.cloneFromNativeMessageIdx`
  (`node/chat/thread.ts:370`) — build the forked thread.
- `Chat.handleForkThread` (`node/chat/chat.ts:888`) — orchestrates the fork, knows both
  `sourceThreadId` and `newThreadId`.
- `AnthropicAgent.appendUserMessage` (`.../anthropic-agent.ts:332`) — appends a real user
  message to the agent.
- `convertBlockToProvider` (`.../anthropic-agent.ts:1213`) — converts native text blocks to
  display `ProviderMessageContent`. Detects marker tags (`<system-reminder>`,
  `<context_update>`) and emits special content types. We add a `fork_notification` case here.
- `ProviderMessageContent` union (`.../provider-types.ts:81`) — add a text-only
  `ProviderForkNotificationContent` type (mirrors `ProviderContextUpdateContent`).
- `MessageViewState` (`node/chat/thread.ts:140`) — add `forkedFrom?: ThreadId` (the rich id, kept
  out of the agent text), set the same way `contextUpdates` is.
- `renderMessageContent` (`node/chat/thread-view.ts:~477`, `system_reminder` case at :559) —
  add a `fork_notification` render case.
- `Thread.state` (`node/chat/thread.ts:158`) — add `forkedTo` display state for the parent.
- Thread navigation dispatch: `{ type: "select-thread-effect", id }` (RootMsg, see
  `node/chat/chat.ts:756`). `thread.context.dispatch` is a `Dispatch<RootMsg>`.

# Design

## Child marker (real agent message, special display)

This follows the **exact** duality used for context updates: the agent sees plain text; the rich
id lives in view state keyed by message index, never embedded in the text.

How context updates do it (the pattern we mirror):
- Agent text is plain `<context_update>...</context_update>`; `convertBlockToProvider`
  (`anthropic-agent.ts:1229`) detects the tag and emits `{ type: "context_update", text,
  nativeMessageIdx }` — text only, no structured payload.
- The rich `FileUpdates` metadata is stored separately in
  `Thread.state.messageViewState[messageIdx].contextUpdates`, populated by the Thread's
  `contextUpdatesSent` core-event listener (`thread.ts:307`), and read back by `messageIdx` at
  render time (`thread-view.ts:831`).

Applying the same shape to fork notifications:

- **Agent text (no id):** during the fork, append a plain user message wrapped in a sentinel
  tag with NO thread id, e.g.
  `<fork-notification>The user forked this thread at this point. ...</fork-notification>`.
  The model only learns that a fork happened — the parent id is not detail it needs.

- **Display content type:** add `ProviderForkNotificationContent =
  { type: "fork_notification"; text: string; nativeMessageIdx }` (text only, matching
  `context_update`), and a `fork_notification` branch in `convertBlockToProvider` keyed off
  `block.text.includes("<fork-notification>")`.

- **Rich metadata in view state:** add a `forkedFrom?: ThreadId` field to `MessageViewState`.
  After appending the marker message in `handleForkThread`, set
  `childThread.state.messageViewState[idx].forkedFrom = sourceThreadId`, where `idx` is the
  native message index of the appended marker. This mirrors how `contextUpdatesSent` writes
  `contextUpdates` keyed by message index.

- **Render + navigate:** the `fork_notification` case in `renderMessageContent` reads
  `thread.state.messageViewState[messageIdx].forkedFrom` to get the parent id, renders
  `↰ forked from <shortId>`, and binds `<CR>` to
  `thread.context.dispatch({ type: "select-thread-effect", id: parentThreadId })`. Mirror the
  header-suppression logic (`thread-view.ts:355-385`) so a user message containing only a
  `fork_notification` gets no `# user:` header.

Where to append: inside `Chat.handleForkThread`, after the child thread is built and before the
`thread-initialized` dispatch, since `Chat` knows both ids and can write the child's view state.
Both the full-thread fork and the at-message fork go through `handleForkThread`, so one insertion
covers both. Appending here keeps `ThreadCore.clone` generic.

## Parent marker (display-only)

- Add `forkedTo: { childThreadId: ThreadId; atMessageIdx: NativeMessageIdx }[]` to `Thread.state`
  (initialized to `[]` in the constructor).
- In `handleForkThread`, after creating the child, push an entry onto the **source** thread's
  `state.forkedTo`. The source Thread is reachable via `sourceThreadWrapper.thread`.
- Render the markers at the end of the parent thread view (after the message list, before/with
  the pending-messages view) as lines like `↳ forked to thread <shortId>`, each with `<CR>`
  bound to `select-thread-effect` for that child id. Anchoring at message index is optional for
  v1; a simple list at the bottom is acceptable and simpler. (If we want it inline at the fork
  point, render it within the message map when `messageIdx === atMessageIdx`; call this out as a
  possible refinement, not required for v1.)

Because this is pure view state it is not persisted in the agent and never sent to the model.

Invariants:
- The child's `fork_notification` is a genuine agent message and must round-trip through
  native↔provider conversion without being misclassified (the sentinel tag must be unique and
  unlikely to appear in normal text).
- The parent's `forkedTo` entries must never leak into `getProviderMessages()` / agent input.
- Both markers' `<CR>` must navigate via `select-thread-effect` using `thread.context.dispatch`
  (RootMsg), not the thread-local `Msg` dispatch.
- Parent id must survive in the child even though `parentThreadId` on the wrapper is currently
  `undefined` (the marker is self-contained, independent of wrapper linkage).
- Docker-source forks are already rejected by `cloneFromNativeMessageIdx`; no new cases needed.

# Stages

## Stage 1 — child fork-notification content type + conversion + view-state id

- Goal: A forked thread's agent message list contains a plain (id-free) fork-notification user
  message; `getProviderMessages()` surfaces it as a `fork_notification` content node (text only);
  and the child's `messageViewState[idx].forkedFrom` holds the parent id.
- Work: add `ProviderForkNotificationContent` (text only) to the union; add the
  `fork_notification` branch in `convertBlockToProvider`; add `forkedFrom?: ThreadId` to
  `MessageViewState`; in `handleForkThread` append the id-free marker message and write
  `forkedFrom` keyed by the marker's message index.
- Verification:
  - Behavior: forking produces a provider message with a `fork_notification` node (text only, no
    id), and the child thread's `messageViewState` records `forkedFrom === sourceThreadId`.
  - Setup: core/unit test for the converter (text → `fork_notification`); chat-level test for the
    fork writing `forkedFrom`.
  - Actions: perform a fork; read `getProviderMessages()` and the child's `messageViewState`.
  - Expected outcome: id-free `fork_notification` content; `forkedFrom` equals the source id;
    the agent text contains no thread id.
- Before moving on: `npx tsgo -b`, `npx vitest run node/core/`, `npx biome check .` pass.

## Stage 2 — child marker rendering + navigation

- Goal: The forked thread view shows `forked from <id>` (no spurious `# user:` header), and
  `<CR>` navigates to the parent thread.
- Work: add the `fork_notification` case to `renderMessageContent`; extend header-suppression
  helpers; bind `<CR>` to `select-thread-effect`.
- Verification:
  - Behavior: integration test via `withDriver()` — fork a thread, assert the child view shows
    the "forked from" line, press `<CR>`, assert active thread switches to the parent.
  - Setup: `withDriver()` with a thread that has at least one message.
  - Actions: trigger fork, locate the marker line, send `<CR>`.
  - Expected outcome: rendered marker present; active thread becomes the parent.
- Before moving on: full `npx vitest run`, `npx tsgo -b`, `npx biome check .` pass.

## Stage 3 — parent display-only marker + navigation

- Goal: The origin thread shows `forked to thread <id>` (not in agent messages); `<CR>`
  navigates to the child.
- Work: add `forkedTo` to `Thread.state`; populate it in `handleForkThread`; render markers at
  the bottom of the parent thread view with `select-thread-effect` bindings.
- Verification:
  - Behavior 1: integration — fork, switch back to parent, assert "forked to" line present and
    `<CR>` switches to the child.
  - Behavior 2: unit/assertion — parent `getProviderMessages()` contains no fork marker (the
    parent marker never enters the agent message list).
  - Setup: `withDriver()` parent thread with a message.
  - Actions: fork; inspect parent view and agent messages; press `<CR>` on the marker.
  - Expected outcome: marker visible, navigation works, agent messages unchanged.
- Before moving on: full `npx vitest run`, `npx tsgo -b`, `npx biome check .` pass.

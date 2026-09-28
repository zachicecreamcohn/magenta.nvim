# Objective and Context

Feedback on `plans/2026-09-27-server-owned-execution.md`, verbatim:

> - **Editor commands:** `@buf`, `@qf` and `@diag` are captured when you submit, not when the message is delivered, because the server can't reach the editor. Their text is appended to your message rather than sent as separate blocks.
>
> I think we should set up a back-and-forth, where the server talks back to the client for these expansions... or the client notifies the server of a queued message, and the server consults it at the right moment so the resolution can happen at send time.
>
> - **`@diff`:** it now runs `git diff` directly, because `zx` isn't a server dependency.
>
> Let's add zx as a server dep
>
> - **Active profile:** your profile choice is now client state that overrides the server's default. Options are recomputed from the files each time.
>
> let's make this server state instead.
>
> - **No editor attached:** OAuth prompts throw an error. The system info reports the Neovim version as "none (no editor attached)".
>
> let's have this remain in pending state until a client attaches.

Key entities:

- `EditorCapabilities` (`node/server/src/capabilities/editor.ts`, renamed to `ClientCapabilities` in `client.ts` by this plan) is what an attached client lends the session: `neovimVersion`, `createLspClient`, `luaExecutor`, `onFileWritten?`, `authUI?`. Today it is attached with `Session.attachEditor`/`detachEditor` and read with `Session.getEditor()`.
- `resolveSubmission` (`node/server/src/submission/resolve.ts`) expands a raw `PendingMessage` at delivery time through a `CommandRegistry` (`submission/commands/`). `Thread` runs it via `ActiveSubmission.step`, so it is abandonable on abort (resolution effects are applied by the caller).
- `expandEditorCommands` / `absolutizeFileRefs` (`node/nvimclient/chat/commands/editor-commands.ts`) run in `Magenta.preprocessAndSend` at submit time today.
- `ServerSessionHost` (`node/server/src/server-session-host.ts`) owns providers and a stable `authUI` wrapper whose `showOAuthFlow` throws via `requireAuthUI()` when no client is attached. It also implements `getActiveProfile()`.
- `AuthUI` (`node/server/src/auth-ui.ts`): `showOAuthFlow(url): Promise<string>`, `showError`, `showLoginProgress`. It is called from `AnthropicProvider.triggerOAuthFlow` (no abort signal) and the OpenAI `codex login` flow (cancelled via the request's `abortSignal`).
- `Magenta.activeProfileName` / `Magenta.options` (`node/nvimclient/magenta.ts`) hold the client-side profile override. The `profile` command sets it, and `syncServerOptionsToLua` mirrors profiles into lua.

Relevant files:

- `node/server/src/submission/commands/diff.ts`: `@diff:`/`@staged:`, currently `execFile`.
- `node/server/package.json`: server deps (no `zx`; root `package.json` has `zx ^8.8.5`).
- `node/nvimclient/chat/nvim-editor.ts`: `createNvimEditor`, builds `EditorCapabilities` (renamed to `nvim-client.ts` / `createNvimClient`).
- `node/nvimclient/nvim/nvim.ts`, `utils/buffers.ts`, `utils/diagnostics.ts`: the buffer, quickfix and diagnostics readers used by the client expansions.

# Design

## Client command expansion at delivery time

Use the second option from the feedback: the client submits the raw message (it still absolutizes `@file:` paths against `NvimCwd`, a submit-time concern). The server consults the client when the message is delivered. `ClientCapabilities` gains one request/response method, `expandClientCommand(command, match)`, returning `AgentInput[]`. The server keeps the client commands registered in its `CommandRegistry` (`@buf`, `@buffers`, `@qf`, `@quickfix`, `@diag`, `@diagnostics`). Their `execute` asks the session's *current* client (`session.getClient()` at delivery, not the one at thread creation), so a message queued while one client was attached resolves against whichever client is attached when it goes out. The expansions come back as separate content blocks again, as before stage 5.

This is a server→client call. In-process it is a method call; in stage 4 of the protocol plan it becomes a request over the WS connection with a response. Keep the shape serializable: string command name plus the matched text in, `AgentInput[]` out.

With no client attached, expansion waits until one attaches (the same pending mechanism as OAuth below). It is safe because resolution runs in `ActiveSubmission.step`: aborting the submission abandons the wait. If the client detaches mid-call, the call rejects and the command yields the existing `Error fetching ...` text block.

## Waiting for a client

`Session` gets `awaitClient(): Task<ClientCapabilities>`. It resolves immediately when one is attached, otherwise on the next `attachClient`. The session tracks outstanding waiters so a view can show "waiting for a client" state, and `dispose` rejects them. `abort()` removes the waiter (a leaf; no signals leak into our layers beyond the existing SDK boundary).

## OAuth pending until a client attaches

`ServerSessionHost.authUI.showOAuthFlow` awaits `session.awaitClient()` for a client with `authUI` and then delegates, instead of throwing. `AuthUI.showOAuthFlow` takes an optional `abortSignal` so the anthropic request that triggered it can cancel the wait (`triggerOAuthFlow` passes the request's signal, matching the OpenAI login path). `showLoginProgress` chunks and `showError` messages produced with no client are still logged, and are also buffered and replayed to the next attached client's `authUI`. The buffer is cleared once replayed or when the login settles. While waiting, the thread stays `running` with activity `preparing`; nothing new is needed in `ThreadState`. The system info's `neovimVersion` placeholder stays as is.

## Active profile as server state

`Session` owns `activeProfileName: string | undefined`, with `setActiveProfile(name)` (throws if the name is not in the current options' profiles) and `getActiveProfileName()`. `ServerSessionHost.getActiveProfile()` returns the named profile if it still exists in `getOptions(cwd).profiles`, otherwise the options default. Setting it emits a session `settings-changed` event. `Magenta.activeProfileName` is removed. The `profile` command calls `session.setActiveProfile`, and `Magenta.options` reads the active profile back from the session. `syncServerOptionsToLua` includes the session's active profile name so the lua picker shows it. The setting is per session and in memory (not persisted to `options.json`).

## zx

Add `zx` to `node/server/package.json` at the root's version (`^8.8.5`, check `npm show zx version`). Restore the `$` template in `submission/commands/diff.ts`, running in the thread cwd (`$({ cwd })`).

## Interfaces

```ts
// capabilities/client.ts
export interface ClientCapabilities {
  // ...existing
  /** Expand a client-state command (`@buf`, `@qf`, `@diag`, ...) against the
   * client's current state. */
  expandClientCommand(command: ClientCommandName, match: string): Promise<AgentInput[]>;
}
export type ClientCommandName = "buf" | "buffers" | "qf" | "quickfix" | "diag" | "diagnostics";

// auth-ui.ts
export interface AuthUI {
  showOAuthFlow(authUrl: string, abortSignal?: AbortSignal): Promise<string>;
  showError(message: string): void;
  showLoginProgress(chunk: string): void;
}

// session.ts
class Session {
  awaitClient(): Task<ClientCapabilities>;
  readonly awaitingClient: number; // count of outstanding waiters, for views
  setActiveProfile(name: string): void;
  getActiveProfileName(): string | undefined;
}
type SessionEvents = { ...; "settings-changed": [] };

// submission/resolve.ts
export type ResolveSubmissionContext = {
  // ...existing
  awaitClient: () => Task<ClientCapabilities>;
};
```

## Invariants

- Client commands resolve against the client attached at delivery time. A message queued with `next`/`async` delivery reads client state at the moment it rides a request.
- The server never reads buffer contents on its own. It only asks the attached client for expansions the user wrote.
- Waiting for a client never blocks anything but the submission or request that needs it, and is always cancellable by aborting that submission or request.
- `detachClient` never aborts threads; in-flight client calls reject and surface as the command's error text.
- The active profile applies to threads created after it is set; existing threads keep their profile.
- If the active profile's name disappears from the reloaded options, the default is used without clearing the stored name.
- The client does not import `zx`, `fs` or `child_process` (the boundary test stays green).

# Stages

## Rename editor to client

- Goal: `EditorCapabilities` → `ClientCapabilities` (`capabilities/editor.ts` → `capabilities/client.ts`); `Session.attachEditor`/`detachEditor`/`getEditor` → `attachClient`/`detachClient`/`getClient`; `ServerSessionHostContext.getAuthUI` reads `getClient()`; `nvim-editor.ts`/`createNvimEditor` → `nvim-client.ts`/`createNvimClient`; `editor-commands.ts` → `client-commands.ts`; the "no editor attached" placeholders and `context.md` wording follow. No behavior change.
- Tests:
  - `npx tsc -b` and the existing suite stay green; `rg -i "editor" node/server/src` finds no leftover identifiers.

## zx on the server

- Goal: `zx` is a server dependency; `@diff:`/`@staged:` use `$` in the thread cwd.
- Tests:
  - The existing tier-B `@diff:` test in `server-session-host.test.ts` passes. Add `@staged:` against a staged change in the same tmp repo.

## Active profile on the session

- Goal: Profile selection lives on `Session`; `Magenta.activeProfileName` is gone.
- Tests:
  - Tier A: `setActiveProfile("b")` makes the next `createRootThread` use profile `b`; a thread created earlier keeps `a`.
  - Tier A: after removing `b` from the options file (tier B, tmp home), new threads use the default, and restoring `b` brings it back.
  - Tier A: an unknown name throws and leaves the selection unchanged.
  - Tier C: `:Magenta profile b` updates the session, and the lua picker shows `b` as active.

## Awaiting a client

- Goal: `Session.awaitClient` resolves on attach, supports abort, and is rejected on dispose.
- Tests:
  - Tier A: a waiter created before attach resolves with the attached client; an aborted waiter never resolves, and a later attach does not deliver to it; dispose rejects pending waiters.

## OAuth pending until attach

- Goal: `showOAuthFlow` waits for a client with `authUI` instead of throwing. Progress and errors are buffered and replayed on attach. Anthropic passes its request signal.
- Tests:
  - Tier A (`server-session-host.test.ts`, fake auth): a request that needs OAuth with no client stays running; attaching a client with a fake `authUI` receives the URL, and the request completes after the code is returned.
  - Tier A: aborting the thread while waiting settles it `aborted` with no dangling waiter (`awaitingClient === 0`).
  - Tier A: login progress emitted before attach is replayed to the attached `authUI` in order.

## Client commands at delivery time

- Goal: The server's registry includes the client commands, which call `expandClientCommand` on the client attached at delivery. The client keeps only `absolutizeFileRefs` at submit time, and `expandEditorCommands` is removed. `createNvimClient` implements `expandClientCommand` with the existing buffer/quickfix/diagnostics readers. Expansions are separate content blocks again.
- Tests:
  - Tier A: with a fake client, a message containing `@qf` queued with `next` delivery resolves using the client state at delivery time. Change the fake's quickfix between submit and delivery and assert the later state was sent.
  - Tier A: with no client attached, the submission waits; attaching resolves it. Aborting while waiting settles `aborted`.
  - Tier A: a client whose `expandClientCommand` rejects yields the `Error fetching` block, and the submission proceeds.
  - Tier C: `@buf` and `@diag` in the input buffer produce separate content blocks in the submitted provider message (restore the pre-stage-5 assertions in `chat/thread.test.ts`).

# Out of scope

- Multiple simultaneously attached clients (which client answers an expansion or OAuth prompt); this plan assumes at most one attached client.
- Persisting the active profile across server restarts.

# Progress

- [x] Stage 1: Rename editor to client. Files/identifiers renamed; prose referring to "editor" as a UI concept (LSP/lua tools, `Editor-backed` comments) left as is where it describes neovim itself.
- [x] Stage 2: zx on the server. `zx ^8.8.5` added to `node/server/package.json`; `diff.ts` uses `$({ cwd, quiet: true })`. Added tier-B `@staged:` test (staged vs unstaged content) in `server-session-host.test.ts`. Review follow-up: the `@staged:` test also covers a path with shell metacharacters (`$`, quotes; spaces are impossible since the pattern is `\S+`) and the empty-output placeholders for both commands.
- [x] Stage 3: Active profile on the session. `Session.setActiveProfile`/`getActiveProfileName`/`getActiveProfile` + `settings-changed` event; `SessionHost` gained `getProfiles()` and `getActiveProfile(name?)` (falls back to the options default). `Magenta.activeProfileName` removed; `Magenta.options` reads the session's name directly (not via the host, which reads `Magenta.options` — avoids recursion and works before the session exists). Lua sync sends `activeProfile`; the picker marks it with `*`. Tests: tier A in `server-session-host.test.ts` ("active profile", mutable in-memory options instead of a tmp home file); tier C in `magenta.test.ts` "can switch profiles". Note: the tier-B `@staged` test flaked once under full-suite load, passes in isolation.
  - Review follow-up: `SessionHost` exposes `getProfile(name): ProviderProfile | undefined` and `getDefaultProfile()` instead of the overloaded `getActiveProfile(name?)`/`getProfiles()`. Session resolves the selection itself: `getProfileSelection(): ProfileSelection` (`default` | `selected` | `missing` with the stale name), and `getActiveProfile()` returns its profile. `getActiveProfileName` was removed so no view can show a stale name as active. In the client, the host reads `Magenta.baseOptions` (files plus client options, no selection), and `Magenta.options.activeProfile` comes from `session.getActiveProfile().name`, which avoids the recursion. Added a tier-A test that script threads without an explicit profile use the selection. No tier-C test for the `profile` error notification, because no pattern exists for it. The `@staged` flake is fixed with a 10s wait (`awaitNextStream` timeout param), since it spawns four git processes.
- [x] Stage 4: Awaiting a client. `Session.awaitClient(): Task<ClientCapabilities | Aborted>` and `awaitingClient` getter. Deviation: per the cancellation invariants (abort is a value), `abort()` drops the waiter and resolves `ABORTED` instead of never resolving; a later attach does not reach it. Dispose rejects pending waiters with "Session disposed"; calling after dispose rejects too. No event is emitted on waiter count changes yet (stage 5/6 can add one if a view needs it). Tier-A test in `session.test.ts`. Two nvim tests (fork-thread, reflect-anchor) flaked under full-suite load and pass in isolation.
  - Review follow-up: the test also covers `awaitClient` after dispose (rejects) and `abort()` after resolution (no-op, count unchanged). The fake client is a typed `ClientCapabilities` literal (`NoopLspClient`, no-op lua executor) instead of a cast; `neovimVersion`/`createLspClient`/`luaExecutor` are required, so `{}` doesn't compile.
- [x] Stage 5: OAuth pending until attach. `AuthUI.showOAuthFlow(url, abortSignal?)`; `ServerSessionHostContext` gained `awaitClient` (magenta wires `session.awaitClient()`), and the host's `showOAuthFlow` awaits a client, then delegates (throws if that client has no `authUI`; abort rejects and drops the waiter). Signals are bridged via the leaf helper `abortTaskOnSignal` in `utils/async.ts` (abort-listeners test allowlist unchanged). Anthropic passes the OAuth fetch's `init.signal` through `ensureValidToken`/`triggerOAuthFlow`; since flows are shared per auth, the request that started the flow owns its cancellation. Progress/errors with no client are logged and buffered; one background `awaitClient` replays them in order on attach (cleared on replay or dispose, not on login settle). Deviation: tests are at the host `authUI` level with a real `Session` (wait, abort with `awaitingClient === 0`, ordered replay), not a full anthropic request with fake auth. `spawn-subagents.test.ts` flaked once under full-suite load, passes in isolation.
  - Review follow-up: `BufferedAuthOutput` named type. New `providers/anthropic-oauth-abort.test.ts`: two concurrent OAuth-fetch requests share one flow; aborting the first request (the flow owner) rejects both, clears `pendingOAuthFlows`, and a later request starts a fresh flow. Host tests added for a second `awaitClient` wait after a replay and for dropping buffered output when the next client lacks `authUI`. The live `showLoginProgress` passthrough to the current client is still asserted in the replay test ("progress:live").
- [x] Stage 6: Client commands at delivery time. `ClientCapabilities.expandClientCommand(name, match)` (`ClientCommandName` exported); server commands in `submission/commands/client.ts` registered by `resolveSubmission`, which gained `awaitClient` in its context (the host wires `ServerSessionHostContext.awaitClient`). The client keeps only `absolutizeFileRefs`; `createNvimClient` answers via `expandClientCommand` in `client-commands.ts` (rejects on failure; the server turns that into the `Error fetching <label>` block). Decision: to release a client waiter when the submission is aborted (so `awaitingClient` returns to 0) without signals, `ActiveSubmission.step` passes its `abandoned` promise to the work, and `ResolveSubmission` takes it as an optional second argument; the client command aborts its `awaitClient` task when it settles. Tests: tier A `submission/client-commands.test.ts` (delivery-time state with `next`, wait-then-attach, abort releases the waiter, error block); tier C `chat/thread.test.ts` restored to separate blocks. `spawn-subagents.test.ts` flaked once under full-suite load, passes in isolation.
  - Review follow-up: `CLIENT_COMMANDS` is a `Record<ClientCommandName, { label }>` (exhaustive, like the client's). `abandoned` is required on `ResolveSubmission`/`resolveSubmission` and the host resolver (programmatic resolvers just omit the parameter). Added a tier-A case for `@buf @qf @buf`: one expansion (and one `awaitClient`) per match, no leftover waiters; blocks are grouped by command in registry order, not message position, matching how the resolver runs all commands. `reflect-anchor.test.ts` flaked once under full-suite load, passes in isolation.

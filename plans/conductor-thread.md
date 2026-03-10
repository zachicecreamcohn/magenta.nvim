# Context

The goal is to add a new thread type `"conductor"` that lives at the same level as `"root"`. A conductor thread is the main interactive thread, but with a system prompt that emphasizes orchestration — specifically, using `docker_unsupervised` subagents for implementation work and following a plan → review → execute workflow.

The conductor system prompt should be **dynamic**: when docker subagents are available (i.e., `container` config is set), the prompt should guide the agent to use `docker_unsupervised` subagents. When docker is not available, it should still instruct a plan → review → execute workflow, but without the docker-specific parts.

## Key types and interfaces

- **`ThreadType`** (`node/core/src/chat-types.ts:7-12`): discriminated union of all thread types. Needs `"conductor"` added.
- **`getBaseSystemPrompt(type: ThreadType)`** (`node/core/src/providers/system-prompt.ts:59-83`): maps thread type → base system prompt string. Needs a `"conductor"` case.
- **`createSystemPrompt(type, context)`** (`node/core/src/providers/system-prompt.ts:85-109`): assembles final system prompt with system info + skills. Currently the context doesn't include container availability — we need to add that.
- **`ProviderOptions`** (`node/core/src/provider-options.ts`): currently just `{ skillsPaths: string[] }`. Needs a field to signal docker availability.
- **`getSubsequentReminder(threadType)`** (`node/core/src/providers/system-reminders.ts:46-51`): maps thread type → reminder string. Needs a `"conductor"` case.
- **`getToolSpecs(threadType, ...)`** (`node/core/src/tools/toolManager.ts:84-125`): maps thread type → tool set. Conductor should get `CHAT_STATIC_TOOL_NAMES` (same as root).
- **`CHAT_STATIC_TOOL_NAMES`** (`node/core/src/tools/tool-registry.ts:17-27`): the tool set for root-level threads (includes spawn/foreach/wait but not yield_to_parent).
- **Root-layer `createSystemPrompt`** (`node/providers/system-prompt.ts`): wraps core version, fetches nvim version. Needs to pass container availability through.
- **`Chat.createThreadWithContext`** (`node/chat/chat.ts:366-489`): creates threads, calls `createSystemPrompt`. Needs to pass container info.
- **`Chat.createNewThread`** (`node/chat/chat.ts:522-534`): creates root threads. Could be updated to create conductor threads instead (or alongside).

## Relevant files

- `node/core/src/chat-types.ts` — ThreadType union
- `node/core/src/providers/system-prompt.ts` — system prompt construction
- `node/core/src/providers/system-reminders.ts` — subsequent reminders
- `node/core/src/providers/prompts/` — prompt markdown files
- `node/core/src/tools/toolManager.ts` — tool set selection per thread type
- `node/core/src/tools/tool-registry.ts` — static tool name lists
- `node/core/src/provider-options.ts` — ProviderOptions type
- `node/providers/system-prompt.ts` — root-layer system prompt wrapper
- `node/chat/chat.ts` — Chat class, thread creation
- `node/core/src/tools/spawn-subagent.ts` — spawn_subagent tool (already in context)

# Implementation

- [ ] **Step 1: Add `"conductor"` to `ThreadType`**
  - [ ] In `node/core/src/chat-types.ts`, add `"conductor"` to the `ThreadType` union.
  - [ ] Run `npx tsgo -b` — this will produce exhaustiveness errors everywhere `ThreadType` is switched on. This is expected and will guide the remaining steps.

- [ ] **Step 2: Add `containerAvailable` to `ProviderOptions`**
  - [ ] In `node/core/src/provider-options.ts`, add `containerAvailable?: boolean` to `ProviderOptions`.

- [ ] **Step 3: Create the conductor prompt files**
  - [ ] Create `node/core/src/providers/prompts/conductor-system-prompt.md` — the base conductor prompt covering:
    - Role: you are an orchestrating agent that coordinates implementation work
    - Workflow: plan → user review → execute plan
  - [ ] Create `node/core/src/providers/prompts/conductor-docker-addendum.md` — addendum when docker is available:
    - Explains that `docker_unsupervised` subagents are available
    - How code flows: host repo → cloned into container → agent works in container → patches extracted back
    - Encourages using docker subagents for implementation steps in the plan
    - Explains the branch-based workflow (create branch, pass to docker agent, patches applied back)

- [ ] **Step 4: Wire conductor into system prompt construction**
  - [ ] In `node/core/src/providers/system-prompt.ts`:
    - Load the new prompt files at module init
    - Add `"conductor"` case to `getBaseSystemPrompt()`. This needs to accept `containerAvailable` — either change the signature to accept context, or change it to accept a second parameter.
    - Approach: change `getBaseSystemPrompt` to accept `(type, opts?: { containerAvailable?: boolean })`. For `"conductor"`, return base prompt + docker addendum if `containerAvailable` is true.
    - Update `createSystemPrompt` to pass `context.options.containerAvailable` through.
  - [ ] Check for type errors and iterate until they pass.

- [ ] **Step 5: Wire conductor into system reminders**
  - [ ] In `node/core/src/providers/system-reminders.ts`, add a `"conductor"` case to `getSubsequentReminder()`.
  - [ ] The reminder should include skills, bash, EDL, explore reminders (same as root), plus a reminder about the plan → review → execute workflow.

- [ ] **Step 6: Wire conductor into tool selection**
  - [ ] In `node/core/src/tools/toolManager.ts`, add `"conductor"` case to the switch in `getToolSpecs()`. It should use `CHAT_STATIC_TOOL_NAMES` (same tools as root — it needs spawn/foreach/wait for orchestration).

- [ ] **Step 7: Handle remaining exhaustiveness errors**
  - [ ] Run `npx tsgo -b` and fix any remaining `assertUnreachable` / switch exhaustiveness errors. The conductor should generally be treated like `"root"` in most places (e.g., thread-core.ts compaction eligibility, etc.).
  - [ ] Iterate until no type errors remain.

- [ ] **Step 8: Pass container availability through the root layer**
  - [ ] In `node/providers/system-prompt.ts` (root wrapper), pass `containerAvailable` from `context.options.container !== undefined` into the core `createSystemPrompt` via `ProviderOptions`.
  - [ ] In `node/chat/chat.ts`, ensure the options object passed to `createSystemPrompt` includes `containerAvailable` when creating conductor threads.

- [ ] **Step 9: Add `new-conductor-thread` command and `<leader>mc` keymap**
  - [ ] In `node/chat/chat.ts`:
    - Add `{ type: "new-conductor-thread" }` to `Chat.Msg` union.
    - Handle it in `myUpdate()` — call a new `createNewConductorThread()` method (or pass `threadType: "conductor"` to `createThreadWithContext`).
  - [ ] In `node/magenta.ts`:
    - Add `"new-conductor-thread"` case to `Magenta.command()`, dispatching `{ type: "chat-msg", msg: { type: "new-conductor-thread" } }`.
  - [ ] In `lua/magenta/init.lua`:
    - Add `"new-conductor-thread"` to the `normal_commands` table.
  - [ ] In `lua/magenta/keymaps.lua`:
    - Add `<leader>mc` keymap mapped to `:Magenta new-conductor-thread<CR>`.
  - [ ] Check for type errors and iterate until they pass.

- [ ] **Step 10: Write tests**
  - [ ] Add unit tests for `getBaseSystemPrompt("conductor")` with and without `containerAvailable`.
  - [ ] Add unit tests for `getSubsequentReminder("conductor")`.
  - [ ] Add unit tests for `getToolSpecs("conductor", ...)`.
  - [ ] Iterate until tests pass.

# Context

The goal is to add a new thread type `"conductor"` that lives at the same level as `"root"`. A conductor thread is the main interactive thread, but with a system prompt that emphasizes orchestration — specifically, using `docker_unsupervised` subagents for implementation work and following a plan → review → execute workflow.

The conductor system prompt should be **dynamic**: when docker subagents are available (i.e., `dockerContext` is passed), the prompt should guide the agent to use `docker_unsupervised` subagents. When docker is not available, it should still instruct a plan → review → execute workflow, but without the docker-specific parts.

## Conductor workflow

The conductor follows this lifecycle for a task:

1. **Plan** — break down the task into subtasks, document them as task files in `~/.magenta/tasks/`
2. **Review** — present the plan to the user for verification (can skip this for trivial tasks at the conductor's judgement)
3. **Execute** — work through the tasks, updating task status as it goes
4. **PR** — when done, put up the change for code review using `gh pr create`

## Task tracking

The conductor uses `~/.magenta/tasks/` as its task directory. Each file is a markdown file with YAML frontmatter:

```markdown
---
branchId: my-feature
status: ready
---

Brief description of the task to be done.
```

### Status values

- `ready` — task is ready to be picked up
- `blocked: task-a.md, task-b.md` — blocked on other tasks (comma-separated list of task filenames)
- `active: branchName` — being worked on by a docker subagent on that branch, or `active: host` if the host is working on it
- `completed: branchName` — completed by the agent on that branch
- `abandoned` — task was abandoned

### Task management responsibilities

- Document tasks as files in the tasks directory
- Track progress by updating task status
- Track dependencies between tasks using the `blocked` status
- Break down tasks into subtasks when appropriate
- When any task is completed, mark it as `completed` and add notes about the outcome to the task file body

## Key types and interfaces (current state)

- **`ThreadType`** (`node/core/src/chat-types.ts`): union of `"subagent_default" | "subagent_fast" | "subagent_explore" | "compact" | "root" | "docker_root"`. Needs `"conductor"` added.
- **`getBaseSystemPrompt(type: ThreadType, dockerContext?: DockerContext)`** (`node/core/src/providers/system-prompt.ts:55-93`): maps thread type → base system prompt string. Already accepts `dockerContext` — the `"docker_root"` case uses it to append docker instructions. Needs a `"conductor"` case.
- **`DockerContext`** (`node/core/src/providers/system-prompt.ts:95-98`): `{ branch: string; containerWorkdir: string }`. Already exists — no need to add `containerAvailable` to `ProviderOptions`.
- **`createSystemPrompt(type, context)`** (`node/core/src/providers/system-prompt.ts:100-126`): assembles final system prompt with system info + skills. Already accepts `dockerContext?` in context.
- **`ProviderOptions`** (`node/core/src/provider-options.ts`): just `{ skillsPaths: string[] }`. No changes needed — docker availability is signaled via `DockerContext`.
- **`getSubsequentReminder(threadType)`** (`node/core/src/providers/system-reminders.ts:43-74`): maps thread type → reminder string. Needs a `"conductor"` case.
- **`getToolSpecs(threadType, ...)`** (`node/core/src/tools/toolManager.ts:82-122`): maps thread type → tool set. Conductor should get `CHAT_STATIC_TOOL_NAMES` (same as root — includes spawn/foreach/wait but not yield_to_parent).
- **`CHAT_STATIC_TOOL_NAMES`** (`node/core/src/tools/tool-registry.ts:17-27`): 9 tools for root-level threads.
- **`DOCKER_ROOT_STATIC_TOOL_NAMES`** (`node/core/src/tools/tool-registry.ts:29-32`): spreads `CHAT_STATIC_TOOL_NAMES` + `yield_to_parent`. Exists as precedent.
- **Root-layer `createSystemPrompt`** (`node/providers/system-prompt.ts:28-56`): wraps core version, fetches nvim version. Already passes `dockerContext?` through.
- **`Chat.createThreadWithContext`** (`node/chat/chat.ts:363-529`): creates threads. Already passes `dockerContext` when in docker environment. No changes needed for passing docker info.
- **`Chat.createNewThread`** (`node/chat/chat.ts:531-543`): creates root threads with `threadType: "root"`.

## Relevant files

- `node/core/src/chat-types.ts` — ThreadType union
- `node/core/src/providers/system-prompt.ts` — system prompt construction (has `DockerContext`, `getBaseSystemPrompt`)
- `node/core/src/providers/system-reminders.ts` — subsequent reminders
- `node/core/src/providers/prompts/` — prompt markdown files (e.g. `docker-system-addendum.md` as precedent)
- `node/core/src/tools/toolManager.ts` — tool set selection per thread type
- `node/core/src/tools/tool-registry.ts` — static tool name lists
- `node/providers/system-prompt.ts` — root-layer system prompt wrapper
- `node/chat/chat.ts` — Chat class, thread creation
- `node/magenta.ts` — command dispatch (currently handles `"new-thread"`)
- `lua/magenta/init.lua` — `normal_commands` table
- `lua/magenta/keymaps.lua` — keymaps (`<leader>mc` is already `:Magenta clear`)

# Implementation

- [ ] **Step 1: Add `"conductor"` to `ThreadType`**
  - [ ] In `node/core/src/chat-types.ts`, add `"conductor"` to the `ThreadType` union.
  - [ ] Run `npx tsgo -b` — this will produce exhaustiveness errors everywhere `ThreadType` is switched on. This is expected and will guide the remaining steps.

- [ ] **Step 2: Create the conductor prompt files**
  - [ ] Create `node/core/src/providers/prompts/conductor-system-prompt.md` — the base conductor prompt covering:
    - Role: you are an orchestrating agent that coordinates implementation work
    - Workflow: plan → user review → execute → PR (see "Conductor workflow" section above)
    - Can skip planning for trivial tasks at its own judgement
    - Task tracking: use `~/.magenta/tasks/` directory with markdown files containing YAML frontmatter (see "Task tracking" section above for format and status values)
    - Task management: document tasks, track progress/dependencies via status updates, break down into subtasks when appropriate, annotate completed tasks with outcomes
    - PR creation: use `gh pr create` when work is done
  - [ ] Create `node/core/src/providers/prompts/conductor-docker-addendum.md` — addendum when docker is available:
    - Explains that `docker_unsupervised` subagents are available
    - How code flows: host repo → cloned into container → agent works in container → patches extracted back
    - Encourages using docker subagents for implementation steps in the plan
    - Explains the branch-based workflow (create branch, pass to docker agent, patches applied back)
  - [ ] Use `docker-system-addendum.md` as reference for the docker addendum format.

- [ ] **Step 3: Wire conductor into system prompt construction**
  - [ ] In `node/core/src/providers/system-prompt.ts`:
    - Load the new prompt files at module init (follow the pattern of existing `readFileSync` calls)
    - Add `"conductor"` case to `getBaseSystemPrompt()`. For `"conductor"`, return conductor base prompt + docker addendum if `dockerContext` is provided (follows the same pattern as `"docker_root"`).
  - [ ] Check for type errors and iterate until they pass.

- [ ] **Step 4: Wire conductor into system reminders**
  - [ ] In `node/core/src/providers/system-reminders.ts`, add a `"conductor"` case to `getSubsequentReminder()`.
  - [ ] The reminder should include skills, bash, EDL, explore reminders (same as root), plus a reminder about the plan → review → execute workflow.

- [ ] **Step 5: Wire conductor into tool selection**
  - [ ] In `node/core/src/tools/toolManager.ts`, add `"conductor"` case to the switch in `getToolSpecs()`. It should use `CHAT_STATIC_TOOL_NAMES` (same tools as root).

- [ ] **Step 6: Handle remaining exhaustiveness errors**
  - [ ] Run `npx tsgo -b` and fix any remaining `assertUnreachable` / switch exhaustiveness errors. The conductor should generally be treated like `"root"` in most places (e.g., thread-core.ts compaction eligibility, etc.).
  - [ ] Iterate until no type errors remain.

- [ ] **Step 7: Add `new-conductor-thread` command and keymap**
  - [ ] In `node/chat/chat.ts`:
    - Add `{ type: "new-conductor-thread" }` to `Chat.Msg` union.
    - Handle it in `myUpdate()` — call `createThreadWithContext` with `threadType: "conductor"`.
  - [ ] In `node/magenta.ts`:
    - Add `"new-conductor-thread"` case to `Magenta.command()`, dispatching `{ type: "chat-msg", msg: { type: "new-conductor-thread" } }`.
  - [ ] In `lua/magenta/init.lua`:
    - Add `"new-conductor-thread"` to the `normal_commands` table.
  - [ ] In `lua/magenta/keymaps.lua`:
    - Add `<leader>mo` keymap mapped to `:Magenta new-conductor-thread<CR>` (o for "orchestrate"; `<leader>mc` is already taken by `:Magenta clear`).
  - [ ] Check for type errors and iterate until they pass.

- [ ] **Step 8: Write tests**
  - [ ] Add unit tests for `getBaseSystemPrompt("conductor")` with and without `dockerContext`.
  - [ ] Add unit tests for `getSubsequentReminder("conductor")`.
  - [ ] Add unit tests for `getToolSpecs("conductor", ...)`.
  - [ ] Add to `node/providers/system-prompt.test.ts` — follow the existing pattern for `docker_root` tests.
  - [ ] Iterate until tests pass.


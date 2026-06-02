# Objective and Context

> when the agent reads a skill.md file for a skill, if that markdown file contains a `<system_reminder>` block, I want to include that block in the system reminder from then on. See how we do this for agent prompts currently, and do something similar. Let's write a plan for how to do this. Make sure the plan also includes updating the documentation

## What we're building

Today, an **agent** definition file can contain a `<system_reminder>...</system_reminder>`
block. When a subagent is spawned from that definition, the block is extracted and
folded into the per-turn `<system-reminder>` text that ThreadCore re-injects during
the conversation. This keeps the guidance "alive" across turns rather than burying it
once in the system prompt.

We want the analogous behavior for **skills**: when the model reads a `skill.md` via
the `get_file` tool, and that file contains a `<system_reminder>` block, the contents
of that block should be appended to the recurring system reminder from that point on,
for the remainder of the thread.

The trigger differs from agents in an important way: agent reminders are known at
thread-construction time (the subagent type is fixed), whereas these reminders are
activated dynamically — only once the model actually reads a file containing a block.
So the thread must accumulate "active" reminders as a side effect of `get_file` calls.

Scope decision: rather than restricting this to known `skill.md` files, we extract a
`<system_reminder>` block from **any markdown file** read via `get_file`. This is
simpler (no path→skill matching) and more general — any markdown doc, including but not
limited to skills, can contribute a live reminder. `skill.md` files are the primary
intended use, but the mechanism is not special-cased to them.

## Key entities

- `extractSystemReminder` (`node/core/src/agents/agents.ts`) — parses a body string
  and returns `{ systemPrompt, systemReminder }`. The block-extraction logic here is
  what we want to reuse for skills (we only need the reminder half).
- `ContextManager` (`node/core/src/context/context-manager.ts`) — owns `files`
  (keyed by `AbsFilePath`), the durable set of files we re-scan after compaction.
- `StructuredResult` for `get_file` (`node/core/src/tools/getFile.ts`) — currently
  `{ toolName: "get_file"; lineCount }`. Carries no file path back to the caller.
- `buildSystemReminder` (`node/core/src/providers/system-reminders.ts`) — assembles the
  `<system-reminder>` block from `ReminderKind[]`, threadType, and `subagentConfig`.
- `ThreadCore` (`node/core/src/thread-core.ts`) — owns thread state, inspects tool
  results in `sendToolResultsAndContinue`, and decides when/what reminders fire.

# Design

The feature has three pieces: (1) extract a `<system_reminder>` block from a markdown
file's content, (2) detect when such a file is read via `get_file` and mark its reminder
"active" on the thread, and (3) include all active reminders in subsequently-built
reminder blocks — while resetting/re-deriving them across compaction.

## 1. Shared reminder-block extraction

Factor the block-extraction core out of `agents.ts`'s `extractSystemReminder` into a
shared helper (e.g. `extractSystemReminderBlock(body): string | undefined`). `agents.ts`
keeps its `{ systemPrompt, systemReminder }` shape but delegates parsing to the helper.
The helper preserves the existing rules: missing tags → undefined; multiple/malformed
tags → undefined.

## 2. Detect a markdown read and activate its reminder

When `get_file` reads a markdown file, run the helper on the returned content. Surface
the result on the `get_file` `StructuredResult` by adding two fields: the resolved
`filePath` (an `AbsFilePath`) and `systemReminder: string | undefined`. Extracting
inside `get_file` (rather than re-reading in the thread) reuses the content already in
hand and keeps the thread free of file IO.

"Markdown file" = path ending in `.md` (case-insensitive). Note a caveat: `get_file`
pages/summarizes large files, so a block could be truncated for very large docs; this is
acceptable since reminder-bearing docs (skills) are small, but it should be called out.

In `ThreadCore.sendToolResultsAndContinue`, alongside the existing bash-abbreviation
check, when a `get_file` result carries a non-empty `systemReminder`, dispatch a new
internal update (e.g. `activate-reminder`) carrying the reminder `text`. Thread state
gains an ordered, **text-keyed** collection of active reminders (e.g. an insertion-ordered
`Set<string>`), so identical reminder text — whether from a repeated read or from two
different files — is included only once. `filePath` is still surfaced on the result for
the compaction re-derivation step, but is not used as the dedup key.

## 3. Sources of active reminders, and reset on compaction

There are two runtime sources for the new mechanism (the agent-prompt block is a separate,
pre-existing static path and is unaffected):

1. **Markdown context files** — whenever a markdown file is in `contextManager.files`, its
   `<system_reminder>` block (if any) is active. This set is *derived* from current context:
   re-scan on context change (file added/updated/removed) and after compaction. A block
   stops being active when its source file leaves context.
2. **Transient get_file reads** — reading a markdown file via `get_file` that is not (or not
   yet) in context activates its block for the current epoch. These are dropped on compaction.

The thread's effective active set is the union of (1) and (2), deduped on **text**. Concretely,
state holds the transient-read set; the context-derived reminders are computed from
`contextManager.files`. `buildSystemReminder` receives the union as `extraReminders: string[]`.

Extend `buildSystemReminder`'s params with `extraReminders: string[]` and append them to the
"subsequent" reminder body (where `SUBAGENT_REMINDER` / custom subagent reminders go). Both
thread call sites (the "subsequent" path and `prepareUserContent`) pass the union. They appear
only in the "subsequent" kind, never "compact".

Compaction handling: the `reset-after-compaction` update (in `thread-core.ts`) clears the
transient-read set. The context-derived reminders need no special handling — they are recomputed
from `contextManager.files`, which survives compaction — but the net effect is that only
context-file reminders persist across compaction, exactly as intended.

Invariants:
- Activation is idempotent and **text-keyed** — identical reminder text is added once,
  whether from a repeated read or from two different files.
- Files with no block contribute nothing.
- "compact" threads never receive these reminders.
- A context-file reminder is active iff its source file is currently in context.
- Across compaction, transient-read reminders are dropped; context-file reminders persist.
- The shared extraction helper must preserve existing agent behavior exactly.
- The agent-prompt `<system_reminder>` path is unchanged by this work.

# Stages

## Stage 1 — Shared reminder-block extraction helper

- Goal: a single shared `extractSystemReminderBlock` helper, used by `agents.ts`. No
  agent behavior change.
- Verification:
  - Behavior: helper returns inner text for one well-formed block; `undefined` for
    none / multiple / malformed tags.
    - Setup: unit test the helper with several body strings.
    - Actions: call the helper.
    - Expected outcome: correct text or `undefined`.
  - Behavior: existing agent reminder extraction unchanged.
    - Setup/Actions/Expected: existing agent tests still pass.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 2 — Surface filePath + systemReminder from get_file

- Goal: `get_file`'s `StructuredResult` includes the resolved `filePath` and, for `.md`
  files, the extracted `systemReminder` (or `undefined`).
- Verification:
  - Behavior: reading a markdown file containing a block yields a structured result with
    `filePath` set and `systemReminder` equal to the block text; a markdown file without
    a block yields `systemReminder: undefined`; a non-markdown file is never scanned.
    - Setup: fixture files via test fileIO.
    - Actions: invoke the tool.
    - Expected outcome: structured fields as described.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 3 — Active reminders from transient reads + context files

- Goal: reading a markdown file with a block (via get_file or having it in context) causes
  that block to appear in every subsequent `<system-reminder>`; deduped on text.
- Verification:
  - Behavior: after a get_file on a reminder-bearing markdown file, the next recurring
    reminder contains the block text; a file without a block adds nothing; identical text
    from a repeat read or a second file is not duplicated.
    - Setup: a thread (integration test via the mock provider) + fixture markdown files.
    - Actions: simulate the get_file result, then a follow-up turn firing the "subsequent"
      reminder.
    - Expected outcome: block text present once in the injected reminder.
  - Behavior: a markdown context file's block is active while in context and gone after it
    is removed from context.
    - Setup: add/remove a reminder-bearing markdown context file.
    - Actions: fire a subsequent reminder before and after removal.
    - Expected outcome: present while in context, absent after removal.
  - Behavior: "compact" threads never include these reminders.
    - Setup/Actions/Expected: build a compact reminder with active reminders present →
      no extra text.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 4 — Compaction reset

- Goal: compaction drops transient-read reminders while context-file reminders persist
  (recomputed from `contextManager.files`).
- Verification:
  - Behavior: a reminder activated via a transient (non-context) read disappears after
    compaction; a reminder whose source markdown file is in context remains active.
    - Setup: a thread with one reminder-bearing markdown file in context and one read only
      transiently; trigger compaction.
    - Actions: run compaction, then fire a subsequent reminder.
    - Expected outcome: only the context-file reminder remains.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 5 — Documentation

- Update the following to describe the new behavior:
  - `doc/magenta-skills.txt` — document that a `skill.md` (and more generally any markdown
    file) may include a `<system_reminder>` block, that it activates when read via
    `get_file` or while held as a markdown context file, and that it is folded into the
    recurring system reminder. Note the compaction rule (only context-file reminders survive
    compaction) and that it parallels the agent-file mechanism.
  - `notes/system-reminders-architecture.md` — document the two runtime sources (context
    files + transient get_file reads), the agent-prompt static path, text-based dedup,
    inclusion in the "subsequent" body, and the compaction reset behavior.
  - `context.md` — add a sentence that any markdown file (notably skills) may contribute a
    live system reminder block when read or held in context.
- Verification: docs match implemented behavior (manual review).
- Before moving on: confirm tests, type checks, and linting all pass.

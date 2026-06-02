# Objective and Context

User request (verbatim):

> I want my custom commands to be able to populate system reminders. I want to create built-in @implementplan command, that instructs the agent to "implement" a plan. It should add a system reminder that reminds the agent to update the plan with progress and notes about implementation choices or decisions.

We want two related capabilities:

1. **Commands can activate persistent system reminders.** Today a command's `execute()` only returns `ProviderMessageContent[]` that gets folded into the outgoing user message. We want a command (built-in or user-defined) to optionally activate a *persistent* reminder — one that gets re-injected into the recurring `<system-reminder>` block for the rest of the thread (the existing `activeReminders` mechanism), not just a one-shot message.

2. **A built-in `@implementplan` command** that injects instruction text telling the agent to implement the current plan, and activates a persistent reminder to keep the plan file updated with progress and notes about implementation decisions.

## Key entities

- `Command` (`node/chat/commands/types.ts`) — interface for a command: `name`, `pattern`, optional `description`, and `execute()` returning `ProviderMessageContent[]`.
- `CommandRegistry` (`node/chat/commands/registry.ts`) — registers built-in + custom commands; `processMessage()` runs all matching commands over input text and collects their content.
- `CustomCommand` (`node/options.ts`) — config shape for user-defined commands (`name`, `text`, `description?`); validated by `parseCustomCommands()`.
- `Magenta.processCommands()` / `preprocessAndSend()` (`node/magenta.ts`) — run the registry on user input and dispatch a `send-message` thread message with the resulting `InputMessage[]`.
- `Thread` (`node/chat/thread.ts`) — root controller; its `send-message` handler calls `core.handleSendMessageRequest()`.
- `ThreadCore` (`node/core/src/thread-core.ts`) — owns `state.activeReminders: Set<string>`; the `activate-reminder` action (handled in `update()`) adds to it; `getActiveReminders()` feeds `buildSystemReminder({ extraReminders })`. `update()` is public.

# Design

A reminder activated by a command is **static text per command** (the `@implementplan` reminder is a fixed string; a custom command's reminder is configured text). So we model it as an optional `systemReminder?: string` field rather than threading dynamic reminder output through `execute()`.

Data flow:

1. Add optional `systemReminder?: string` to the `Command` interface.
2. `CommandRegistry.processMessage()` gains a third output: `reminders: string[]`. For every command whose pattern matches the input, if it has a `systemReminder`, add it to a de-duplicated reminder set. Return the collected reminders alongside `processedText` / `additionalContent`.
3. Built-in `@implementplan` command (`node/chat/commands/implementplan.ts`): `execute()` returns a text content block instructing the agent to implement the plan; the command carries a `systemReminder` reminding it to keep the plan updated. Register it in `registerBuiltinCommands()`.
4. Custom commands: extend `CustomCommand` config with optional `systemReminder?: string`, parse/validate it in `parseCustomCommands()`, and have `registerCustomCommand()` copy it onto the generated `Command`.
5. Plumb reminders to the core: `Magenta.processCommands()` returns the reminders along with the messages; `preprocessAndSend()` includes them on the `send-message` thread msg (new optional `reminders?: string[]` field on `Thread`'s `Msg`). The `send-message` handler in `Thread.myUpdate()` calls `this.core.update({ type: "activate-reminder", text })` for each reminder before `handleSendMessageRequest()`.

Reuse the existing `activate-reminder` action — no new core state. Reminders persist until compaction (which already clears `activeReminders`), matching the documented behavior of context-file reminders.

Invariants:
- A reminder is activated **once per matched command**, even if the command pattern matches multiple times in the input (de-dupe by reminder text).
- Activation must happen *before* the message is sent so the first agent turn sees it; activation order relative to send must be deterministic.
- `@implementplan` must follow the existing word-boundary matching convention so `@implementplanned` doesn't trigger it.
- The `@compact` special-case path also runs commands (for its next-prompt) — reminders collected there should be handled consistently (either applied to the post-compaction thread or intentionally ignored); pick one and make it explicit, since compaction clears reminders.

# Status

All stages implemented and verified (tests, `tsgo -b`, `biome` all pass).

- Stage 1: `Command.systemReminder?: string`; `processMessage()` returns de-duped `reminders: string[]`. Tests in `registry.test.ts`.
- Stage 2: `node/chat/commands/implementplan.ts` (`@implementplan`) registered in `registry.ts`. Returns instruction text + plan-maintenance reminder; `@implementplanned` does not match.
- Stage 3: `CustomCommand.systemReminder?` parsed/validated in `parseCustomCommands()` (non-string warns + drops) and copied in `registerCustomCommand()`. Tests in `options.test.ts` and `registry.test.ts`.
- Stage 4: reminders plumbed `Magenta.processCommands` → `send-message` (`reminders?`) → `Thread` handler calls `core.update({type:"activate-reminder"})` before send. `@compact` next-prompt reminders intentionally dropped (compaction clears `activeReminders`). Integration test in `system-reminders.test.ts`.

# Stages

## Stage 1: Command-level reminders in the registry

- Goal: `Command` supports `systemReminder?: string`; `processMessage()` returns a de-duplicated `reminders: string[]` collected from matched commands.
- Verification (unit, `registry.test.ts`):
  - Behavior: a built-in or test command with `systemReminder` that matches input yields that reminder once.
  - Setup: register a command with a `systemReminder`.
  - Actions: call `processMessage()` with text containing the command (including a case where it appears twice).
  - Expected outcome: `reminders` contains the reminder exactly once; commands without `systemReminder` contribute nothing.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 2: Built-in @implementplan command

- Goal: `@implementplan` is registered; expands to instruction text and activates its plan-maintenance reminder.
- Verification (unit, `registry.test.ts`):
  - Behavior: `processMessage("@implementplan")` returns the instruction text as `additionalContent` and the plan reminder in `reminders`; `@implementplanned` does not match.
  - Setup: default `CommandRegistry`.
  - Actions: call `processMessage()`.
  - Expected outcome: content + reminder present; boundary case does not trigger.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 3: Custom command reminders

- Goal: `CustomCommand` config accepts `systemReminder`; it is validated and surfaced on the registered command.
- Verification (unit):
  - Behavior: a custom command configured with `systemReminder` activates it on match; invalid (non-string) values are warned and dropped.
  - Setup: `registerCustomCommand()` / `parseCustomCommands()` with and without the field.
  - Actions: parse config, process matching input.
  - Expected outcome: reminder present when configured; absent/ignored otherwise.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 4: Plumb reminders into ThreadCore

- Goal: reminders collected during input processing reach `ThreadCore.state.activeReminders` and appear in the recurring system reminder.
- Verification (integration, withDriver):
  - Behavior: sending `@implementplan` causes subsequent system reminders to include the plan-maintenance text.
  - Setup: driver with mock provider; send a message containing `@implementplan`, then continue the thread far enough to trigger a subsequent reminder.
  - Actions: inspect the request sent to the mock provider.
  - Expected outcome: the plan reminder text is present in the `<system-reminder>` block.
- Before moving on: confirm tests, type checks, and linting all pass.

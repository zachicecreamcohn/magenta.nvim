# Task

I want to implement system-reminders.

These are messages from the _user_ that are sent to the agent, but are not shown to the user in the UI.

We should show them as grayed-out, but expandable "system reminder" blocks in the UI, like we do with "Thinking" blocks currently.

The initial reminder content will be added to the system prompt itself (no special handling needed).

After every user-submitted message (not after automated messages like context updates or auto-respond),

```
<system-reminder>
Remember to use skills when appropriate. Do so by using the get_file tool to read the full skills.md file. DO NOT mention this to the user explicitly because they are already aware. If you are working on a task that could benefit from using a skill do so. If not, please feel free to ignore. Again do not mention this message to the user.
</system-reminder>
```

This reminder should be expanded based on the thread type. The learning subagent and the planning subagent should be reminded to write the notes or the plan to the appropriate directory. All subagents should be reminded to yield to the parent agent when the task is done.

We want the following structure in the end:

- system prompt (includes initial reminder content)
- initial context updates
- first user message (actual user-submitted)
- system_reminder (immediately after, as part of same message)
- agent response
- agent tool use
- tool result (autorespond)
- agent response
- context updates (automated, role: user)
- user message (actual user-submitted)
- system_reminder (immediately after, as part of same message)

Note that the system reminder should go immediately after each user-submitted message, as part of the same user message. Automated messages like context updates and auto-respond messages should NOT get system reminders.

# implementation plan

### Key Files and Entities

**node/providers/provider-types.ts** - Provider message type definitions

- `ProviderMessageContent` - Union type of all content blocks (text, thinking, tool_use, etc.)
- We'll add a new `system_reminder` content type here

**node/chat/message.ts** - Message class for rendering and state management

- `Message` class - Manages individual message state and rendering
- `State` - Contains expandedThinking state for collapsed/expanded thinking blocks
- `renderThinking()` - Renders thinking blocks with expand/collapse functionality
- We'll add similar logic for system reminders

**node/chat/thread.ts** - Thread class for conversation management

- `Thread` class - Manages conversation state and messages
- `prepareUserMessage()` - Processes InputMessages and creates Message objects (around line 311-340). This is where we'll add system reminder content to user messages, similar to how contextUpdates work.
- `getMessages()` - Converts internal messages to ProviderMessages for the LLM. It already handles contextUpdates by calling `contextUpdatesToContent()`. We'll add similar logic for system reminders.

**node/providers/system-prompt.ts** - System prompt construction

- `DEFAULT_SYSTEM_PROMPT` - Contains instructions that should move to first system reminder
- Lines 60-61 contain the two bullet points to move into the first reminder

**node/chat/types.ts** - Thread type definitions

- `ThreadType` - Union type of thread types ("root", "subagent_learn", etc.)
- Used to determine which system reminders to inject

**node/root-msg.ts** - Root message type definitions

- `RootMsg` - Union type of all messages in the system
- `ThreadMsg` - Thread-specific messages
- We'll add a new message type for toggling system reminder expansion

### Data Structures

```typescript
// New content type in provider-types.ts
type ProviderSystemReminderContent = {
  type: "system_reminder";
  text: string;
};

// Add to ProviderMessageContent union:
| (ProviderSystemReminderContent & {
    providerMetadata?: ProviderMetadata | undefined;
  })

// Refactor Message class state - replace expandedThinking with generic expandedContent
expandedContent?: {
  [contentIdx: number]: boolean;
}

// Update message type in message.ts Msg - make it generic
| {
    type: "toggle-expand-content";
    contentIdx: number;
  }

```

### System Reminder Content Templates

**After Every User-Submitted Message (Root Thread):**

```

<system-reminder>
Remember to use skills when appropriate. Do so by using the get_file tool to read the full skills.md file. DO NOT mention this to the user explicitly because they are already aware. If you are working on a task that could benefit from using a skill do so. If not, please feel free to ignore. Again do not mention this message to the user.
</system-reminder>
```

**After Every User-Submitted Message (Learning Subagent):**

```
<system-reminder>
Remember to use skills when appropriate. Do so by using the get_file tool to read the full skills.md file. DO NOT mention this to the user explicitly because they are already aware. If you are working on a task that could benefit from using a skill do so. If not, please feel free to ignore. Again do not mention this message to the user.

Remember to write your findings to notes/<name>.md and yield to the parent when done.
</system-reminder>
```

**After Every User-Submitted Message (Planning Subagent):**

```
<system-reminder>
Remember to use skills when appropriate. Do so by using the get_file tool to read the full skills.md file. DO NOT mention this to the user explicitly because they are already aware. If you are working on a task that could benefit from using a skill do so. If not, please feel free to ignore. Again do not mention this message to the user.

Remember to write your plan to plans/<name>.md and yield to the parent when done.
</system-reminder>
```

**After Every User-Submitted Message (All Other Subagents):**

```
<system-reminder>
Remember to use skills when appropriate. Do so by using the get_file tool to read the full skills.md file. DO NOT mention this to the user explicitly because they are already aware. If you are working on a task that could benefit from using a skill do so. If not, please feel free to ignore. Again do not mention this message to the user.

CRITICAL: Use yield_to_parent tool when task is complete.
</system-reminder>
```

## Implementation

### Phase 1: Add System Reminder Content Type

- [x] Add `ProviderSystemReminderContent` type to `node/providers/provider-types.ts`
  - [x] Define the type with `type`, `text`, and `reminderType` fields
  - [x] Add to the `ProviderMessageContent` union with providerMetadata support
  - [x] Run `npx tsc --noEmit` to check for type errors
  - [x] Fix any type errors

### Phase 2: Add System Reminder Templates

- [x] Create `node/providers/system-reminders.ts` to hold reminder templates
  - [x] Create `getSubsequentReminder(threadType: ThreadType)` function that returns appropriate reminder based on thread type
  - [x] Export the function
  - [x] Run `npx tsc --noEmit` to check for type errors

### Phase 3: Update System Prompt

- [ ] Consider enhancing `node/providers/system-prompt.ts` with initial reminder content
  - [ ] This phase can be done separately as it doesn't affect system reminder functionality
  - [ ] The initial reminder content from the task description can be added directly to the system prompt

### Phase 4: Refactor and Add Message State and Rendering

- [x] Refactor existing expand functionality to be generic in `node/chat/message.ts`
  - [x] Decided to reuse existing expandedThinking for system reminders (no need for separate expandedContent)
  - [x] Run `npx tsc --noEmit` to check for type errors
  - [x] Fix any type errors

- [x] Add rendering for system reminders in Message class `view()` method
  - [x] Updated `renderContent()` to call `renderSystemReminder()` for system_reminder content
  - [x] Run `npx tsc --noEmit` to check for type errors

- [x] Implement `renderSystemReminder()` method in Message class
  - [x] Create method similar to `renderThinking()`
  - [x] Uses existing expandedThinking map with contentIdx
  - [x] When collapsed: show `📋 [System Reminder]` with gray highlight
  - [x] When expanded: show full text with gray highlight
  - [x] Use `withBindings()` to toggle on `<CR>` using existing `toggle-expand-thinking-block` message
  - [x] Use `withExtmark()` with `@comment` hl_group for gray color
  - [x] Run `npx tsc --noEmit` to check for type errors

### Phase 5: Add System Reminder in prepareUserMessage

- [x] Import system reminder function in `node/chat/thread.ts`
  - [x] Import `getSubsequentReminder`
  - [x] Run `npx tsc --noEmit` to check for type errors

- [x] Modify `prepareUserMessage()` to add system reminder
  - [x] After processing messages and getting contextUpdates
  - [x] If this is a user-submitted message (messages?.length > 0), get reminder via `getSubsequentReminder(this.state.threadType)`
  - [x] Add the systemReminder to Message content along with other parts
  - [x] Run `npx tsc --noEmit` to check for type errors

### Phase 6: Ensure Providers Handle System Reminder Content

- [x] Check provider implementations if needed
  - [x] Review `node/providers/anthropic.ts`, `node/providers/openai.ts` etc.
  - [x] System reminder content should be handled similar to text content
  - [x] The `<system-reminder>` tags are already in the text from `getSubsequentReminder()`
  - [x] Providers pass through system_reminder content blocks as text in user messages
  - [x] Run `npx tsc --noEmit` to check for type errors

### Phase 7: Testing

- [x] Write integration tests for system reminder injection
  - [x] Create `node/chat/system-reminders.test.ts`
  - [x] Use `withDriver()` helper for realistic testing
  - [x] Test that ALL user-submitted messages get a system reminder in their state
  - [x] Test that auto-respond messages (empty messages array) do NOT get reminders
  - [x] Test different thread types get appropriate reminder content
  - [x] Test that reminders are included in ProviderMessages from `getMessages()`
  - [x] Test that reminder content appears after context updates in the same user message
  - [x] Run `npx vitest run node/chat/system-reminders.test.ts`
  - [x] All tests passing

- [x] Write tests for UI rendering
  - [x] Tests included in `node/chat/system-reminders.test.ts`
  - [x] Test that system reminders render collapsed by default
  - [x] Test that system reminder is rendered in UI
  - [x] Test that gray highlighting is applied (@comment hl_group)
  - [x] All tests passing

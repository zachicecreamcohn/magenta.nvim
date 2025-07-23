# Overview

this is a neovim plugin for agentic tool use
the entrypoint is in `lua/magenta/init.lua`. When the plugin starts up, it will kick off the `node/magenta.ts` node process. That will reach back out and establish the bridge, which will grab the options from lua and establish bidirectional communication between the two halves of the plugin.

options are configured in `lua/magenta/options.lua`
neovim keymaps are configured in `lua/magenta/keymaps.lua`
`node/sidebar.ts` manages the sidebar. This is where we create the chat and input buffers, and initialize keymaps on them.

# Architecture

The core architectural components include:

- `Controllers` - Classes that manage specific parts of the application. Each controller maintains its own state and handles messages that are relevant to it.
- `Msg/RootMsg` - Messages that trigger state changes. There's a root message type that is then directed to specific controllers.
- `dispatch/myDispatch` - Functions passed to controllers that allows them to send messages through the system. Each controller receives a root dispatcher that it can use to communicate with other parts of the system.
- `view` - A function that renders the current controller state in TUI. This is done in a declarative way using the `d` template literal. You can attach bindings to different parts of the text via `withBindings`.

The general flow is:

- Controllers initialize with their own state and receive a root dispatcher.
- When a user action occurs, it triggers a command or binding that dispatches a message.
- The message flows to the appropriate controller via the root dispatcher.
- The controller updates its internal state and may dispatch additional messages to other controllers.
- The view is rendered based on the updated state.

One key principle: **If you create a class, you're responsible for passing actions or messages to that class.**

The main architectural files are:

- [root-msg.ts](https://github.com/dlants/magenta.nvim/blob/main/node/root-msg.ts) - Defines the root message type that flows through the system
- [magenta.ts](https://github.com/dlants/magenta.nvim/blob/main/node/magenta.ts#L21) - Contains the central dispatching loop in the `dispatch` method of the Magenta class
- [tea/tea.ts](https://github.com/dlants/magenta.nvim/blob/main/node/tea/tea.ts) - Manages the rendering cycle
- [view.ts](https://github.com/dlants/magenta.nvim/blob/main/node/tea/view.ts) - Implements the VDOM-like declarative rendering template

# View code

**THIS IS NOT REACT**. **DO NOT USE REACT VIEWS OR DOM** This uses a templating library for a TUI running inside a neovim buffer.

Views in magenta.nvim are built using a declarative templating approach:

## Template Literal and Composition

The `d` tag function is used for templates, similar to JSX but with template literals:

```typescript
// Basic text rendering
d`This is some text`;

// Dynamic content interpolation
d`User: ${username}`;

// Conditional rendering
d`${isLoading ? d`Loading...` : d`Content loaded!`}`;

// Rendering lists
d`${items.map((item) => d`- ${item.name}\n`)}`;

// Component composition
d`Header: ${headerView({ title })}\nBody: ${bodyView({ content })}`;
```

## Adding Interactivity

You can attach keybindings to sections of text with `withBindings`:

```typescript
withBindings(d`Press Enter to continue`, {
  "<CR>": () => dispatch({ type: "continue" }),
  q: () => dispatch({ type: "quit" }),
});
```

Views render to a neovim buffer and update on every dispatch.

# Putting it all together

Here's a minimal example of a controller with just one message type and two states:

```typescript
// make sure to grab appropriate imports relative to the file path

// Define a simple message type for toggling
export type Msg = { type: "toggle" } | { type: "request-finished" };

// this should be imported from node/root-msg.ts
export type ToggleRootMsg = {
  type: "toggle-msg";
  id: ToggleId;
  msg: Msg;
};

export type ToggleId = number & { __toggleId: true };

export class Toggle {
  public state: {
    isOn: boolean;
  };

  private myDispatch: Dispatch<Msg>;

  constructor(
    public id: ToggleId,
    private context: { dispatch: Dispatch<RootMsg>; nvim: Nvim },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "toggle-msg",
        id: this.id,
        msg,
      });

    this.state = {
      isOn: false,
    };
  }

  update(msg: RootMsg): void {
    if (msg.type === "toggle-msg" && msg.id === this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "toggle":
        this.state.isOn = !this.state.isOn;

        if (this.state.isOn) {
          this.notifyServer().catch((error) => {
            this.context.nvim.logger.error("Failed to notify server:", error);
          });
        }
        return;
      case "request-finished":
        this.context.nvim.logger.info("Server notification completed");
        return;
      default:
        assertUnreachable(msg);
    }
  }

  private async notifyServer(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500);
    });
    // Dispatch the request-finished message when done
    this.myDispatch({ type: "request-finished" });
  }

  view() {
    return d`
Current state: ${this.state.isOn ? "ON" : "OFF"}

${withBindings(d`[Toggle]`, {
  "<CR>": () => this.myDispatch({ type: "toggle" }),
})}`;
  }
}
```

# Testing

to run the full test suite, use `npx vitest run` from the project root. You do not need to cd.
to run a specific test file, use `npx vitest run <file>`. **Important** You do not need to cd.
tests should make use of the `node/test/preamble.ts` helpers.
when doing integration-level testing, like user flows, use the `withDriver` helper and the interactions in `node/test/driver.ts`. When performing generic user actions that may be reusable between tests, put them into the NvimDriver class as helpers.

As of July 2025, tests are now run in parallel for improved performance. The test infrastructure has been updated to support concurrent test execution.

## Test Environment Setup

**Fixture Files & Directory Structure:**

- Each test gets a fresh temporary directory in `/tmp/magenta-test/{testId}/`
- Files from `node/test/fixtures/` are copied into this temp directory for each test
- Available fixture files include `poem.txt` and others
- Nvim runs in this temporary directory, so files can be safely mutated during tests
- The temp directory is automatically cleaned up after each test

**Test Pattern:**

```typescript
import { withDriver } from "../test/preamble";

test("my test", async () => {
  await withDriver({}, async (driver) => {
    // Test code here - nvim runs in temp dir with fixture files
  });
});
```

## Available Mocks & Test Interactions

**Mock Provider:**

- `driver.mockAnthropic` - Pre-configured mock provider that captures all requests
- `await driver.mockAnthropic.awaitPendingForceToolUseRequest()` - Wait for and capture forced tool use requests
- `await driver.mockAnthropic.awaitPendingRequest()` - Wait for regular message requests
- `await driver.mockAnthropic.respondToForceToolUse({...})` - Send mock responses
- No need to manually mock providers - they're already set up in the test infrastructure

**Driver Interactions (prefer these over internal API access):**

- `await driver.editFile("poem.txt")` - Open fixture files
- `await driver.command("normal! gg")` - Execute vim commands
- `await driver.magenta.command("predict-edit")` - Execute magenta commands
- Use real nvim interactions to trigger change tracking naturally

**Testing Best Practices:**

- **DO**: Use realistic nvim interactions (`driver.editFile()`, `driver.command()`)
- **DON'T**: Reach into internal APIs (`driver.magenta.changeTracker.onTextDocumentDidChange()`)
- **DO**: Let the system work naturally - make real edits and let change tracking happen
- **DO**: Write integration tests that exercise the full user flow
- **DON'T**: Mock internal components - use the provided driver and mock provider

**Change Tracker Testing:**

- **DO**: Use `driver.assertChangeTrackerHasEdits(count)` and `driver.assertChangeTrackerContains(changes)` instead of arbitrary timeouts
- **DO**: Be aware that rapid edits may be batched into single changes by the tracker
- **DO**: Use explicit assertions about what changes should be tracked rather than waiting fixed amounts of time
- **DON'T**: Use `setTimeout()` or fixed delays when waiting for change tracking - use the assertion methods instead

**Mock Provider Request Objects:**
Force tool use requests captured by `awaitPendingForceToolUseRequest()` contain:

- `request.spec` - The tool specification used
- `request.model` - Which model was requested
- `request.messages` - The messages array containing user/assistant conversation
- `request.systemPrompt` - The system prompt used (if any)
- `request.defer` - Promise resolution control

**System Prompt vs User Messages:**
When implementing AI features, maintain proper separation:

- **System prompt**: General instructions about the agent's role and behavior ("You have to do your best to predict...")
- **User messages**: Specific contextual data (buffer content, cursor position, recent changes)
  This separation keeps the system prompt focused on behavior while allowing dynamic context in messages.

# Type checks

use `npx tsc --noEmit` to run type checking, from the project root. Once again, I remind you, you do not need to cd into any subdirectory.

# Notes

To avoid complexity, keep variable names on the lua side camelCase, to match the variables defined in typescript.

We only want to use a single bottom value, so use undefined whenever you can and avoid null. When external libraries use null, only use null at the boundary, and convert to undefined as early as possible, so the internals of the plugin only use undefined.

You must **NEVER** introduce new `any` types. Always check with the user if you're thinking about doing so.

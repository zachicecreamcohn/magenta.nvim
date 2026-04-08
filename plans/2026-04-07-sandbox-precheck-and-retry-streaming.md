# context

## Objective

Two issues with sandbox command execution:

1. **Pre-check commands against regex patterns**: Commands like `git commit && git push` always fail sandbox containment, but the first part (`git commit`) runs before the violation is detected. When the user approves, the entire compound command runs again, so `git commit` executes twice. Add a configurable list of regex patterns that trigger an immediate approval prompt _before_ running the command.

2. **Live streaming on approved retry**: When a command is approved after sandbox violation (or pre-approval), the user doesn't see live output during the second execution. Need to investigate whether this is a rendering issue (violation view obscuring progress) or an execution issue (callbacks not firing on retry).

## Relevant files

- `node/options.ts`: `SandboxConfig` type and `DEFAULT_SANDBOX_CONFIG` — add `requireApprovalPatterns: string[]`
- `node/capabilities/sandbox-shell.ts`: `SandboxShell.execute()` — add pre-check logic; retry callbacks pass `opts` with `onOutput`/`onStart`
- `node/capabilities/sandbox-violation-handler.ts`: `SandboxViolationHandler.approve()` — calls the retry callback
- `node/core/src/tools/bashCommand.ts`: `execute()` — sets up `progress` object and streaming callbacks
- `node/render-tools/bashCommand.ts`: `renderProgress()` — displays live output during execution

## Key types

```typescript
// node/options.ts
type SandboxConfig = {
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
    allowRead: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowUnixSockets: string[];
    allowAllUnixSockets: boolean;
  };
};

// New field to add:
// requireApprovalPatterns: string[]  — regex patterns; if a command matches any, prompt for approval before running
```

# implementation

## Issue 1: Pre-check commands against regex patterns

- [ ] Add `requireApprovalPatterns: string[]` to `SandboxConfig` in `node/options.ts`
  - Add the field to the type definition
  - Add default value `[]` in `DEFAULT_SANDBOX_CONFIG`
  - Update `parseSandboxConfig()` to parse the new field
  - Update `mergeSandboxConfigs()` to concatenate the arrays

- [ ] Add pre-check logic in `SandboxShell.execute()` in `node/capabilities/sandbox-shell.ts`
  - Before running the sandboxed command, check if the command matches any pattern in `requireApprovalPatterns`
  - If it matches, call `violationHandler.promptForApproval(command, () => this.spawnCommand(command, opts))` directly — skip sandboxed execution entirely
  - The patterns should be compiled to `RegExp` objects (cache them if the config hasn't changed)
  - Place this check early in `execute()`, after the sandbox-not-ready check but before wrapping with sandbox

- [ ] Write unit tests for the pre-check behavior
  - **Test: command matching a requireApprovalPatterns regex triggers immediate approval prompt**
    - Setup: Create a `SandboxShell` with `requireApprovalPatterns: ["git\\s+push"]` in options, a mock `SandboxViolationHandler`, and a mock `Sandbox` with status "ready"
    - Actions: Call `execute("git commit && git push", ...)`
    - Expected: `violationHandler.promptForApproval` is called immediately, `spawnCommand` is NOT called first
    - Assertions: Verify `promptForApproval` was called with the command, verify no sandboxed execution happened

  - **Test: command NOT matching any pattern proceeds normally through sandbox**
    - Setup: Same as above but command is `ls -la`
    - Actions: Call `execute("ls -la", ...)`
    - Expected: Normal sandbox flow runs (wrap + spawn)
    - Assertions: `promptForApproval` is not called, `sandbox.wrapWithSandbox` is called

## Issue 2: Live streaming on approved retry

- [ ] Investigate and reproduce the streaming issue
  - Add a test that simulates a violation → approval → retry flow and verifies that `onOutput` is called during the retry
  - Check whether the issue is in the rendering layer (progress view not updating) or the execution layer (callbacks not firing)

- [ ] If the issue is that `progress.liveOutput` retains first-run output on retry:
  - Clear `progress.liveOutput` when the retry starts (in the `onStart` callback or by adding a reset hook)
  - Or: add a visual separator in the progress view to distinguish first-run vs retry output

- [ ] If the issue is in rendering (violation view obscuring progress):
  - Ensure that after approval, a `requestRender()` is triggered to show the progress view
  - The `onPendingChange` callback in `SandboxViolationHandler` should trigger a render when the violation is cleared

- [ ] Write integration test for the full flow
  - **Test: approved command shows streaming output**
    - Setup: Configure sandbox with a command that will violate, have a test driver
    - Actions: Run the violating command, approve it via the violation handler
    - Expected: `onOutput` callback fires during the retry execution
    - Assertions: `progress.liveOutput` contains output from the retried command, `requestRender` was called

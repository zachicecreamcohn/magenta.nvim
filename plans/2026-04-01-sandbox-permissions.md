# Sandbox Permissions Plan

## Context

### Objective

Replace the application-level permission system (bash command parsing + interactive approval prompts) with OS-level sandboxing using `@anthropic-ai/sandbox-runtime` (srt). Shell commands run freely inside the sandbox but cannot escape it. File IO uses application-level checks against srt's config (single source of truth).

### Why

The current system creates approval fatigue without meaningful security — a prompt-injected agent can write malicious code to a test file and run the (auto-approved) test command. OS-level sandboxing prevents this because even code the agent writes and executes is still constrained.

### Key srt API types

```typescript
// Main config passed to SandboxManager.initialize()
type SandboxRuntimeConfig = {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    // also: allowUnixSockets?, allowLocalBinding?, httpProxyPort?, socksProxyPort?, etc.
  };
  filesystem: {
    denyRead: string[];
    allowRead?: string[];
    allowWrite: string[];
    denyWrite: string[];
    allowGitConfig?: boolean;
  };
  ignoreViolations?: Record<string, string[]>;
  // also: enableWeakerNestedSandbox?, ripgrep?, mandatoryDenySearchDepth?, allowPty?, seccomp?
};

// SandboxManager is a singleton with static methods
interface ISandboxManager {
  initialize(config: SandboxRuntimeConfig, askCallback?: SandboxAskCallback, enableLogMonitor?: boolean): Promise<void>;
  isSupportedPlatform(): boolean;
  checkDependencies(...): SandboxDependencyCheck;  // { warnings: string[], errors: string[] }
  wrapWithSandbox(command: string, binShell?: string, customConfig?: Partial<SandboxRuntimeConfig>, abortSignal?: AbortSignal): Promise<string>;
  getSandboxViolationStore(): SandboxViolationStore;
  annotateStderrWithSandboxFailures(command: string, stderr: string): string;
  getFsReadConfig(): FsReadRestrictionConfig;   // { denyOnly: string[], allowWithinDeny?: string[] }
  getFsWriteConfig(): FsWriteRestrictionConfig; // { allowOnly: string[], denyWithinAllow: string[] }
  getConfig(): SandboxRuntimeConfig | undefined;
  updateConfig(newConfig: SandboxRuntimeConfig): void;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

// Violation events from macOS log monitor
interface SandboxViolationEvent {
  line: string;         // raw kernel log line
  command?: string;
  encodedCommand?: string;
  timestamp: Date;
}

// Network permission callback - called by proxy when unknown host encountered
type SandboxAskCallback = (params: { host: string; port: number | undefined }) => Promise<boolean>;
```

### Relevant files

| File                                      | Role                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `node/environment.ts`                     | `Environment` interface + `createLocalEnvironment()` wiring              |
| `node/capabilities/permission-shell.ts`   | Current `PermissionCheckingShell` — to be replaced                       |
| `node/capabilities/permission-file-io.ts` | Current `PermissionCheckingFileIO` — to be replaced                      |
| `node/capabilities/buffer-file-io.ts`     | `BufferAwareFileIO` — calls `fs` directly, does NOT wrap an inner FileIO |
| `node/capabilities/bash-parser/`          | Bash lexer/parser/permission rules — to be deleted                       |
| `node/capabilities/permissions.ts`        | `canReadFile`/`canWriteFile` helpers — to be deleted                     |
| `node/options.ts`                         | `MagentaOptions`, `parseOptions()`, `mergeOptions()`                     |
| `node/options-loader.ts`                  | `DynamicOptionsLoader` — monitors options.json files for changes         |
| `node/chat/thread.ts`                     | `Thread` class — references `permissionFileIO`/`permissionShell`         |
| `node/chat/thread-view.ts`                | Renders permission approval UI (lines 290-300)                           |
| `node/chat/chat.ts`                       | Creates threads, wires `onPendingChange`, holds `rememberedCommands`     |
| `node/core/src/capabilities/shell.ts`     | `Shell` interface (core)                                                 |
| `node/core/src/capabilities/file-io.ts`   | `FileIO` interface (core)                                                |

### Current wiring (to be replaced)

```
createLocalEnvironment():
  BufferAwareFileIO (calls fs directly)
    → wrapped by PermissionCheckingFileIO (checks rules, prompts user)
  BaseShell
    → wrapped by PermissionCheckingShell (parses bash, checks rules, prompts user)

Environment.fileIO = permissionFileIO    (agent uses this)
Environment.permissionFileIO = same ref  (thread-view reads pending approvals)
Environment.shell = permissionShell
Environment.permissionShell = same ref
```

### New wiring

```
createLocalEnvironment():
  BufferAwareFileIO (calls fs directly)
    → wrapped by SandboxFileIO (checks srt read/write config, prompts for writes)
  SandboxShell (replaces BaseShell — spawns processes directly, wraps via srt)

Environment.fileIO = sandboxFileIO
Environment.shell = sandboxShell
Environment.sandboxViolationHandler = handler  (for rendering violation UI)
```

SandboxShell absorbs BaseShell's process-spawning logic. There are now two Shell implementations: `SandboxShell` (local) and `DockerShell` (docker). `BaseShell` is deleted.

### Design decisions

1. **Shell commands**: OS-level sandboxed via `SandboxManager.wrapWithSandbox()`. This is the main security boundary.

2. **File IO**: Application-level checks using srt's config as single source of truth (`getFsReadConfig()`, `getFsWriteConfig()`). NOT subprocess-based. Rationale: the Node process is unsandboxed, so we can't truly OS-sandbox file operations without subprocess overhead. Shell commands (the main attack vector) ARE OS-sandboxed.

3. **SandboxFileIO sits above BufferAwareFileIO** (same position as PermissionCheckingFileIO). No refactoring of BufferAwareFileIO needed.

4. **Network prompts**: Use srt's `SandboxAskCallback` for interactive network permission prompts during command execution. When the proxy encounters an unknown host, it calls our callback, which shows a prompt in the sidebar.

5. **Docker environments**: Skip sandboxing entirely. The container is the sandbox. No changes to `createDockerEnvironment()`.

6. **No migration period**: Replace the old permission system entirely. Delete old files, remove old config types, and default `sandbox.enabled = true`. When sandbox is disabled or unsupported (missing deps), fall back to prompting the user for approval on every shell command and file write (no auto-allow rules, just a simple "may I run X?" prompt).

---

## Implementation

### Step 1: Add srt dependency and SandboxConfig type

- [ ] `npm install @anthropic-ai/sandbox-runtime@0.0.46` (root package.json, not core)
- [ ] Add types to `node/options.ts`:

```typescript
export type SandboxConfig = {
  enabled: boolean;
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
};

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  filesystem: {
    allowWrite: ["./"],
    denyWrite: [".env", ".git/hooks/"],
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
  },
  network: {
    allowedDomains: [
      "registry.npmjs.org",
      "github.com",
      "*.github.com",
      "pypi.org",
      "files.pythonhosted.org",
      "rubygems.org",
      "crates.io",
    ],
    deniedDomains: [],
  },
};
```

- [ ] Add `sandbox: SandboxConfig` field to `MagentaOptions`
- [ ] Remove old permission types from options: `CommandPermissionsConfig`, `commandConfig`, `FilePermission`, `filePermissions`, `getFileAutoAllowGlobs`
- [ ] Remove `parseCommandRulesConfig()`, `parseFilePermissions()` and related helpers
- [ ] Add `parseSandboxConfig()` helper, call from `parseOptions()`
- [ ] Update `mergeOptions()`: remove old permission merging, add sandbox merging (arrays concatenate, `enabled` overwrites)
- [ ] Type check: `npx tsgo -b` (will have errors until later steps wire things up)

#### Tests: options parsing

- **parseSandboxConfig valid input** → returns parsed config with all fields
  - Setup: call with `{ enabled: true, filesystem: {...}, network: {...} }`
  - Assert: deep equals expected SandboxConfig
- **parseSandboxConfig missing fields** → fills defaults
  - Setup: call with `{}`
  - Assert: returns DEFAULT_SANDBOX_CONFIG
- **mergeOptions concatenates arrays** → combined arrays
  - Setup: base `allowWrite: ["./"]`, project `allowWrite: ["/tmp"]`
  - Assert: merged `allowWrite: ["./", "/tmp"]`
- **mergeOptions enabled overwritten** → project wins
  - Setup: base `enabled: true`, project `enabled: false`
  - Assert: merged `enabled: false`

---

### Step 2: SandboxManager lifecycle wrapper

- [ ] Create `node/sandbox-manager.ts`:

```typescript
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export type SandboxState =
  | { status: "uninitialized" }
  | { status: "initializing" }
  | { status: "ready" }
  | { status: "unsupported"; reason: string }
  | { status: "disabled" };

// Module-level state
let state: SandboxState = { status: "uninitialized" };
let lastConfigJson: string | undefined;

export function getSandboxState(): SandboxState;
export async function initializeSandbox(
  config: SandboxConfig,
  cwd: NvimCwd,
  homeDir: HomeDir,
  askCallback: SandboxAskCallback | undefined,
  logger: { warn(msg: string): void },
): Promise<SandboxState>;
export function updateSandboxConfigIfChanged(
  config: SandboxConfig,
  cwd: NvimCwd,
  homeDir: HomeDir,
): void;
export async function resetSandbox(): Promise<void>;
// Resolves ~, ./, relative paths in config
function resolveConfigPaths(
  config: SandboxConfig,
  cwd: NvimCwd,
  homeDir: HomeDir,
): SandboxRuntimeConfig;
```

Key behavior:

- `initializeSandbox`: checks `config.enabled`, `isSupportedPlatform()`, `checkDependencies()`. If any fail, sets state to `disabled`/`unsupported` and logs warning. Otherwise calls `SandboxManager.initialize()` with `enableLogMonitor: true`.
- `updateSandboxConfigIfChanged`: compares serialized config, calls `SandboxManager.updateConfig()` if different. Called from SandboxShell before each command.
- `resolveConfigPaths`: maps our `SandboxConfig` → `SandboxRuntimeConfig`, expanding `~/` to homeDir, `./` to cwd, relative paths to cwd-relative.
- `checkDependencies()` returns `{ warnings: string[], errors: string[] }` — treat non-empty `errors` as unsupported.

- [ ] Initialize in `node/magenta.ts` `Magenta.start()`, after options loader creation, before constructing Magenta. The `askCallback` parameter is wired later (Step 5).

#### Tests: sandbox-manager

- **disabled config** → state is `disabled`, SandboxManager.initialize not called
- **unsupported platform** → state is `unsupported`, logger.warn called
- **dependency errors** → state is `unsupported` with reason
- **successful init** → state is `ready`, SandboxManager.initialize called with resolved paths
- **resolveConfigPaths** → `"~/.ssh"` expands to `/home/user/.ssh`, `"./"` expands to cwd, absolute paths unchanged
- **updateSandboxConfigIfChanged same config** → updateConfig NOT called
- **updateSandboxConfigIfChanged changed config** → updateConfig called
- **resetSandbox** → state returns to `uninitialized`, SandboxManager.reset called

All tests mock `@anthropic-ai/sandbox-runtime` via `vi.mock()`. Use `vi.resetModules()` in beforeEach to reset module-level state.

---

### Step 3: SandboxShell

- [ ] Create `node/capabilities/sandbox-shell.ts` (replaces `BaseShell` — absorbs its process-spawning logic):

```typescript
// Absorbs BaseShell's spawn logic + adds srt wrapping and fallback prompts.
// Two Shell implementations remain: SandboxShell (local) and DockerShell (docker).
export class SandboxShell implements Shell {
  private runningProcess: ChildProcess | undefined;

  constructor(
    private context: {
      cwd: NvimCwd;
      homeDir: HomeDir;
      threadId: ThreadId;
      getOptions: () => MagentaOptions;
    },
    private violationHandler: SandboxViolationHandler,
  ) {}

  terminate(): void {
    /* same as BaseShell — SIGTERM then SIGKILL after 1s */
  }

  private spawnCommand(command: string, opts): Promise<ShellResult> {
    // Moved from BaseShell.execute() — spawn("bash", ["-c", command], ...)
    // with logging, timeout, output capture, etc.
  }

  async execute(command, opts): Promise<ShellResult> {
    if (getSandboxState().status !== "ready") {
      // Sandbox unavailable — prompt user for every command
      return this.violationHandler.promptForApproval(command, () =>
        this.spawnCommand(command, opts),
      );
    }

    // Push config updates if options changed
    updateSandboxConfigIfChanged(options.sandbox, cwd, homeDir);

    // Snapshot violation count before execution
    const store = SandboxManager.getSandboxViolationStore();
    const preCount = store.getTotalCount();

    // Wrap and execute
    const wrapped = await SandboxManager.wrapWithSandbox(command);
    const result = await this.spawnCommand(wrapped, opts);

    // Check for new violations
    const postCount = store.getTotalCount();
    if (postCount > preCount && result.exitCode !== 0) {
      const newViolations = store.getViolations(postCount - preCount);
      const stderr = result.output
        .filter((l) => l.stream === "stderr")
        .map((l) => l.text)
        .join("\n");
      const annotated = SandboxManager.annotateStderrWithSandboxFailures(
        command,
        stderr,
      );

      // Block until user decides
      return this.violationHandler.addViolation(
        { command, violations: newViolations, stderr: annotated },
        () => this.spawnCommand(command, opts), // retry unsandboxed
      );
    }

    SandboxManager.cleanupAfterCommand();
    return result;
  }
}
```

- [ ] Delete `node/capabilities/base-shell.ts`
- [ ] Move shared utilities (log writer, process termination) to `shell-utils.ts` if not already there

#### Tests: sandbox-shell

- **command wrapped when sandbox ready** → inner.execute called with wrapped command, not original
- **prompts when disabled** → violationHandler.promptForApproval called, inner.execute only after approval
- **prompts when unsupported** → same
- **violation detected** → violationHandler.addViolation called; returned promise is the handler's promise
- **no violation when exit 0** → returns result directly, no handler interaction
- **normal failure (no new violations)** → returns failed result directly
- **terminate delegates** → inner.terminate called

---

### Step 4: SandboxFileIO

- [ ] Create `node/capabilities/sandbox-file-io.ts`:

```typescript
export class SandboxFileIO implements FileIO {
  constructor(
    private inner: FileIO, // BufferAwareFileIO
    private context: { cwd: NvimCwd; homeDir: HomeDir },
    private promptForWriteApproval: (absPath: string) => Promise<void>,
    // Resolves if approved, rejects if denied. Used for both sandbox violations and fallback prompts.
  ) {}

  private isReadBlocked(absPath: string): boolean {
    // When sandbox unavailable, don't block reads (only shell commands prompt)
    if (getSandboxState().status !== "ready") return false;
    const readConfig = SandboxManager.getFsReadConfig();
    // readConfig.denyOnly contains resolved deny paths
    return readConfig.denyOnly.some(
      (denied) => absPath === denied || absPath.startsWith(denied + "/"),
    );
  }

  private isWriteBlocked(absPath: string): boolean {
    if (getSandboxState().status !== "ready") return true; // prompt for every write
    const writeConfig = SandboxManager.getFsWriteConfig();
    // writeConfig.allowOnly: only these paths are writable
    // writeConfig.denyWithinAllow: exceptions within allowed paths
    const inAllowed = writeConfig.allowOnly.some(
      (allowed) => absPath === allowed || absPath.startsWith(allowed + "/"),
    );
    if (!inAllowed) return true;
    const inDeny = writeConfig.denyWithinAllow.some(
      (denied) => absPath === denied || absPath.startsWith(denied + "/"),
    );
    return inDeny;
  }

  async readFile(path: string): Promise<string> {
    const abs = resolveFilePath(this.context.cwd, path, this.context.homeDir);
    if (this.isReadBlocked(abs)) {
      this.onViolation(`Read blocked: ${path}`);
      throw new Error(`Sandbox: read access denied for ${path}`);
    }
    return this.inner.readFile(path);
  }

  // readBinaryFile: same deny pattern as readFile

  async writeFile(path: string, content: string): Promise<void> {
    const abs = resolveFilePath(...);
    if (this.isWriteBlocked(abs)) {
      await this.promptForWriteApproval(abs); // blocks until user approves; throws if denied
    }
    return this.inner.writeFile(path, content);
  }

  // fileExists, mkdir, stat: passthrough to inner (metadata only)
}
```

This sits in the same position as `PermissionCheckingFileIO` — wraps `BufferAwareFileIO`. No refactoring of `BufferAwareFileIO` needed.

#### Tests: sandbox-file-io

- **read allowed path** → delegates to inner
- **read denied path** → throws, calls onViolation, inner NOT called
- **read deny prefix matching** → `/home/user/.sshrc` NOT blocked by deny of `/home/user/.ssh`
- **write to allowed path** → delegates to inner
- **write to denied path** → throws, calls onViolation
- **write outside allowOnly** → blocked
- **write prompts when sandbox disabled** → promptForWriteApproval called for every write
- **read allowed when sandbox disabled** → delegates to inner (no prompt for reads)
- **fileExists/mkdir/stat** → always delegate, no sandbox checks

---

### Step 5: SandboxViolationHandler

- [ ] Create `node/capabilities/sandbox-violation-handler.ts`:

```typescript
export type SandboxViolation = {
  command: string;
  violations: SandboxViolationEvent[];
  stderr: string;
};

export type PendingViolation = {
  id: string;
  violation: SandboxViolation;
  retryUnsandboxed: () => Promise<ShellResult>;
  resolve: (result: ShellResult) => void;
  reject: (err: Error) => void;
};

export class SandboxViolationHandler {
  private pending: Map<string, PendingViolation> = new Map();
  private nextId = 0;

  constructor(private onPendingChange: () => void) {}

  addViolation(violation, retryUnsandboxed): Promise<ShellResult>;
  promptForApproval(
    command: string,
    execute: () => Promise<ShellResult>,
  ): Promise<ShellResult>;
  // Used when sandbox is unavailable. Shows "may I run X?" with APPROVE / DENY buttons.
  approve(id: string): void; // calls execute/retryUnsandboxed, resolves promise
  reject(id: string): void; // rejects promise with error
  approveAll(): void;
  rejectAll(): void;
  getPendingViolations(): Map<string, PendingViolation>;
  view(): VDOMNode; // renders both violation prompts and approval prompts
}
```

The view follows the same pattern as `PermissionCheckingShell.view()`: renders each pending item with APPROVE / REJECT buttons, plus APPROVE ALL / REJECT ALL for multiple items. No "add to config" button — users update config via a separate thread using the `update-permissions` skill.

For sandbox violations, the view should display the command that was attempted and the annotated srt error output, so the user can copy-paste that context into a new thread to ask the agent to update the sandbox config. Example rendering:

```
🔒 Sandbox blocked: `cat ~/.ssh/id_rsa`
> Operation not permitted: read access denied for /Users/me/.ssh/id_rsa
> APPROVE
> REJECT
```

- [ ] Wire `SandboxAskCallback` for network prompts: when srt's proxy encounters an unknown host during command execution, it calls our callback. We render a network permission prompt in the sidebar and resolve the callback based on user choice. This requires the violation handler to support network prompts as a separate pending type.

#### Tests: sandbox-violation-handler

- **addViolation creates pending entry** → pending size is 1, onPendingChange called, promise is pending
- **reject rejects promise** → promise rejects with error, pending cleared
- **approve calls retry** → retryFn called, promise resolves with retry result
- **approve propagates retry errors** → promise rejects with retryFn's error
- **approveAll approves all** → all retryFns called, all promises resolve
- **rejectAll rejects all** → all promises reject, pending cleared
- **operations on non-existent IDs** → no-ops, no errors
- **view empty when no violations** → returns empty VDOMNode
- **view renders buttons** → contains "Sandbox blocked", "APPROVE", "REJECT"
- **view renders APPROVE ALL / REJECT ALL for multiple** → only shown when 2+ items
- **promptForApproval shows command prompt** → renders "May I run X?" with APPROVE / REJECT
- **promptForApproval approve** → execute callback called, promise resolves with result
- **promptForApproval reject** → promise rejects, execute NOT called

---

### Step 6: Wire into environment and delete old permission system

- [ ] Delete old files:
  - `node/capabilities/permission-shell.ts`
  - `node/capabilities/permission-file-io.ts`
  - `node/capabilities/permissions.ts`
  - `node/capabilities/base-shell.ts` (absorbed into SandboxShell)
  - `node/capabilities/bash-parser/` (entire directory)
  - All corresponding test files

- [ ] Update `Environment` interface in `node/environment.ts`:
  - Remove `permissionFileIO?: PermissionCheckingFileIO`
  - Remove `permissionShell?: PermissionCheckingShell`
  - Add `sandboxViolationHandler?: SandboxViolationHandler`

- [ ] Update `createLocalEnvironment()`:
  - Remove `rememberedCommands` parameter
  - Create `SandboxViolationHandler` with `onPendingChange` callback
  - Create `SandboxFileIO` wrapping `BufferAwareFileIO`
  - Create `SandboxShell` directly (no BaseShell — it spawns processes itself)
  - Return sandbox wrappers instead of permission wrappers

- [ ] `createDockerEnvironment()` unchanged (no sandbox, no permissions)

- [ ] Update `node/chat/thread.ts`:
  - Replace `permissionFileIO`/`permissionShell` properties with `sandboxViolationHandler`
  - In `aborting` handler: call `sandboxViolationHandler?.rejectAll()` instead of `denyAll()`

- [ ] Update `node/chat/thread-view.ts` (lines 290-300):
  - Replace `filePermissionView` + `shellPermissionView` with single `sandboxView`:
    ```typescript
    const sandboxView = thread.sandboxViolationHandler?.getPendingViolations()
      .size
      ? d`\n${thread.sandboxViolationHandler.view()}`
      : d``;
    ```
  - Use `sandboxView` where `permissionView` was

- [ ] Update `node/chat/chat.ts`:
  - Remove `rememberedCommands` field from `Chat` class
  - Remove `rememberedCommands` from `createLocalEnvironment()` calls
  - Update `threadHasPendingApprovals()` to check `sandboxViolationHandler` instead

- [ ] The `permission-pending-change` message type can stay as-is (just triggers re-render). The `onPendingChange` callback dispatches it the same way.

- [ ] Type check: `npx tsgo -b`

#### Tests: environment wiring (integration with withDriver)

- **sandboxed command succeeds** → no violation UI, tool result contains output
- **sandbox violation shows UI** → "Sandbox blocked" rendered in sidebar
- **REJECT removes UI** → violation UI disappears, agent receives error
- **ALLOW ONCE retries unsandboxed** → command re-executed, tool result shows output
- **abort rejects all violations** → all pending cleared, UI disappears
- **file read denied** → tool result contains sandbox error, no violation UI (instant rejection)

---

### Step 7: Rewrite update-permissions skill

- [ ] Rewrite `node/skills/update-permissions/skill.md` to document the new `sandbox` config:
  - How `SandboxConfig` maps to srt's `SandboxRuntimeConfig`
  - How to add paths to `filesystem.allowWrite`, `filesystem.denyWrite`, `filesystem.denyRead`
  - How to add domains to `network.allowedDomains`, `network.deniedDomains`
  - Where config lives: lua options, `~/.magenta/options.json` (user), `.magenta/options.json` (project)
  - Example: user reports "sandbox blocked `npm install`" → add `registry.npmjs.org` to `allowedDomains`
  - Example: user reports "write denied to `/tmp/build`" → add `/tmp/build` to `allowWrite`

---

## Open questions

1. **SandboxManager lifecycle**: Does `initialize()` start long-lived proxy servers? Need to verify cleanup on nvim exit. `reset()` exists but may need explicit call in Magenta shutdown.

2. **Log monitor timing**: Violations arrive asynchronously via macOS log monitor. After a command completes, there may be a brief delay before violations appear in the store. May need a small delay or use `subscribe()` for reliable detection.

3. **Performance of network proxy**: Does the HTTP/SOCKS proxy add noticeable latency to `npm install` etc.? Needs benchmarking.

4. **"Add to Config" inference**: `SandboxViolationEvent.line` is a raw kernel log string. Parsing it to infer the right config patch (e.g., "add /tmp to allowWrite") is heuristic and fragile. May need to start with a simpler UX (just show the violation, let user manually edit config).

5. **SandboxAskCallback threading**: The callback is called during command execution (from the proxy). We need to show a UI prompt and block until the user responds. This means the callback returns a Promise that resolves when the user clicks allow/deny. Need to verify this works with our single-threaded dispatch model.

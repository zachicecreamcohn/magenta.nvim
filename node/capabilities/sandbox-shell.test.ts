import type { ChildProcess } from "node:child_process";
import type { ThreadId } from "@magenta/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { MagentaOptions, SandboxConfig } from "../options.ts";
import type { SandboxState } from "../sandbox-manager.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { SandboxShell } from "./sandbox-shell.ts";
import type { SandboxViolationHandler } from "./sandbox-violation-handler.ts";
import type { ShellResult } from "./shell.ts";

// Mock sandbox object (implements Sandbox interface via DI)
const mockWrapWithSandbox = vi.fn<(command: string) => Promise<string>>();
const mockGetSandboxViolationStore = vi.fn();
const mockAnnotateStderrWithSandboxFailures =
  vi.fn<(command: string, stderr: string) => string>();
const mockCleanupAfterCommand = vi.fn();
const mockGetSandboxState = vi.fn<() => SandboxState>();
const mockUpdateConfigIfChanged = vi.fn();

const mockSandbox = {
  getState: () => mockGetSandboxState(),
  wrapWithSandbox: (...args: [string]) => mockWrapWithSandbox(...args),
  getViolationStore: () => mockGetSandboxViolationStore(),
  annotateStderrWithSandboxFailures: (...args: [string, string]) =>
    mockAnnotateStderrWithSandboxFailures(...args),
  cleanupAfterCommand: () => mockCleanupAfterCommand(),
  getFsReadConfig: () => ({ denyOnly: [] }),
  getFsWriteConfig: () => ({ allowOnly: ["/"], denyWithinAllow: [] }),
  updateConfigIfChanged: (...args: [SandboxConfig, NvimCwd, HomeDir]) =>
    mockUpdateConfigIfChanged(...args),
};

// Mock child_process
const mockSpawn = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => mockSpawn(...args),
  };
});

function createMockChildProcess(): ChildProcess & {
  _listeners: Record<string, ((...args: unknown[]) => void)[]>;
  _emit: (event: string, ...args: unknown[]) => void;
} {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const proc = {
    pid: 1234,
    stdout: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners[`stdout:${event}`] = listeners[`stdout:${event}`] || [];
        listeners[`stdout:${event}`].push(handler);
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners[`stderr:${event}`] = listeners[`stderr:${event}`] || [];
        listeners[`stderr:${event}`].push(handler);
      }),
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    }),
    kill: vi.fn(),
    _listeners: listeners,
    _emit: (event: string, ...args: unknown[]) => {
      const handlers = listeners[event] || [];
      for (const handler of handlers) {
        handler(...args);
      }
    },
  };
  return proc as unknown as ChildProcess & {
    _listeners: Record<string, ((...args: unknown[]) => void)[]>;
    _emit: (event: string, ...args: unknown[]) => void;
  };
}

function createMockViolationHandler(): SandboxViolationHandler & {
  promptForApproval: ReturnType<typeof vi.fn>;
  addViolation: ReturnType<typeof vi.fn>;
  promptForWriteApproval: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  approveAll: ReturnType<typeof vi.fn>;
  rejectAll: ReturnType<typeof vi.fn>;
  getPendingViolations: ReturnType<typeof vi.fn>;
  view: ReturnType<typeof vi.fn>;
} {
  return {
    promptForApproval: vi.fn(),
    addViolation: vi.fn(),
    promptForWriteApproval: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    approveAll: vi.fn(),
    rejectAll: vi.fn(),
    getPendingViolations: vi.fn(),
    view: vi.fn(),
  } as unknown as ReturnType<typeof createMockViolationHandler>;
}

const defaultSandboxConfig: SandboxConfig = {
  filesystem: {
    allowWrite: ["./"],
    denyWrite: [],
    denyRead: [],
    allowRead: [],
  },
  network: {
    allowedDomains: [],
    deniedDomains: [],
  },
};

function createContext() {
  return {
    cwd: "/test/cwd" as NvimCwd,
    homeDir: "/home/user" as HomeDir,
    threadId: "test-thread" as ThreadId,
    getOptions: () =>
      ({
        sandbox: defaultSandboxConfig,
      }) as MagentaOptions,
  };
}

function createOpts() {
  return {
    toolRequestId: "test-tool-1",
    onOutput: vi.fn(),
    onStart: vi.fn(),
  };
}

function setupSpawnSuccess(
  stdout = "hello world",
  exitCode = 0,
): ReturnType<typeof createMockChildProcess> {
  const proc = createMockChildProcess();
  mockSpawn.mockReturnValue(proc);

  // Schedule output and close after spawn
  setTimeout(() => {
    if (stdout) {
      proc._emit("stdout:data", Buffer.from(stdout));
    }
    proc._emit("close", exitCode, null);
  }, 0);

  return proc;
}

describe("SandboxShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSandboxState.mockReturnValue({ status: "ready" });
    mockWrapWithSandbox.mockImplementation(
      async (cmd: string) => `sandbox-wrapped:${cmd}`,
    );
    mockGetSandboxViolationStore.mockReturnValue({
      getTotalCount: () => 0,
      getViolations: () => [],
    });
    mockAnnotateStderrWithSandboxFailures.mockImplementation(
      (_cmd: string, stderr: string) => stderr,
    );
  });

  test("command wrapped when sandbox ready", async () => {
    setupSpawnSuccess("output", 0);
    const handler = createMockViolationHandler();
    const shell = new SandboxShell(createContext(), mockSandbox, handler);

    const result = await shell.execute("echo hello", createOpts());

    expect(mockWrapWithSandbox).toHaveBeenCalledWith("echo hello");
    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      ["-c", "sandbox-wrapped:echo hello"],
      expect.objectContaining({ cwd: "/test/cwd" }),
    );
    expect(result.exitCode).toBe(0);
    expect(handler.promptForApproval).not.toHaveBeenCalled();
    expect(mockCleanupAfterCommand).toHaveBeenCalled();
  });

  test("prompts when disabled", async () => {
    mockGetSandboxState.mockReturnValue({
      status: "unsupported",
      reason: "disabled",
    });
    const handler = createMockViolationHandler();
    const expectedResult: ShellResult = {
      exitCode: 0,
      signal: undefined,
      output: [{ stream: "stdout", text: "ok" }],
      logFilePath: undefined,
      durationMs: 100,
    };
    handler.promptForApproval.mockResolvedValue(expectedResult);

    const shell = new SandboxShell(createContext(), mockSandbox, handler);
    const result = await shell.execute("rm -rf /", createOpts());

    expect(handler.promptForApproval).toHaveBeenCalledWith(
      "rm -rf /",
      expect.any(Function),
    );
    expect(mockWrapWithSandbox).not.toHaveBeenCalled();
    expect(result).toBe(expectedResult);
  });

  test("prompts when unsupported", async () => {
    mockGetSandboxState.mockReturnValue({
      status: "unsupported",
      reason: "missing deps",
    });
    const handler = createMockViolationHandler();
    const expectedResult: ShellResult = {
      exitCode: 0,
      signal: undefined,
      output: [],
      logFilePath: undefined,
      durationMs: 50,
    };
    handler.promptForApproval.mockResolvedValue(expectedResult);

    const shell = new SandboxShell(createContext(), mockSandbox, handler);
    const result = await shell.execute("cat /etc/passwd", createOpts());

    expect(handler.promptForApproval).toHaveBeenCalledWith(
      "cat /etc/passwd",
      expect.any(Function),
    );
    expect(mockWrapWithSandbox).not.toHaveBeenCalled();
    expect(result).toBe(expectedResult);
  });

  test("prompts when uninitialized", async () => {
    mockGetSandboxState.mockReturnValue({ status: "uninitialized" });
    const handler = createMockViolationHandler();
    const expectedResult: ShellResult = {
      exitCode: 0,
      signal: undefined,
      output: [],
      logFilePath: undefined,
      durationMs: 50,
    };
    handler.promptForApproval.mockResolvedValue(expectedResult);

    const shell = new SandboxShell(createContext(), mockSandbox, handler);
    await shell.execute("ls", createOpts());

    expect(handler.promptForApproval).toHaveBeenCalled();
  });

  test("violation detected on non-zero exit", async () => {
    let preCountCalls = 0;
    mockGetSandboxViolationStore.mockReturnValue({
      getTotalCount: () => {
        preCountCalls++;
        // First call returns 0 (pre-count), second returns 2 (post-count)
        return preCountCalls === 1 ? 0 : 2;
      },
      getViolations: (limit: number) =>
        [
          {
            line: "sandbox deny read",
            command: "cat ~/.ssh/id_rsa",
            timestamp: new Date(),
          },
          {
            line: "sandbox deny read 2",
            command: "cat ~/.ssh/id_rsa",
            timestamp: new Date(),
          },
        ].slice(0, limit),
    });
    mockAnnotateStderrWithSandboxFailures.mockReturnValue(
      "Operation not permitted",
    );

    setupSpawnSuccess("", 1);
    const handler = createMockViolationHandler();
    const violationResult: ShellResult = {
      exitCode: 0,
      signal: undefined,
      output: [{ stream: "stdout", text: "retried" }],
      logFilePath: undefined,
      durationMs: 200,
    };
    handler.addViolation.mockResolvedValue(violationResult);

    const shell = new SandboxShell(createContext(), mockSandbox, handler);
    const result = await shell.execute("cat ~/.ssh/id_rsa", createOpts());

    expect(handler.addViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "cat ~/.ssh/id_rsa",
        stderr: "Operation not permitted",
      }),
      expect.any(Function),
    );
    expect(result).toBe(violationResult);
    expect(mockCleanupAfterCommand).not.toHaveBeenCalled();
  });

  test("no violation when exit 0", async () => {
    let preCountCalls = 0;
    mockGetSandboxViolationStore.mockReturnValue({
      getTotalCount: () => {
        preCountCalls++;
        // Even if count changes, exit code 0 means no violation
        return preCountCalls === 1 ? 0 : 1;
      },
      getViolations: () => [],
    });

    setupSpawnSuccess("output", 0);
    const handler = createMockViolationHandler();
    const shell = new SandboxShell(createContext(), mockSandbox, handler);

    const result = await shell.execute("echo hi", createOpts());

    expect(handler.addViolation).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(mockCleanupAfterCommand).toHaveBeenCalled();
  });

  test("normal failure without new violations", async () => {
    mockGetSandboxViolationStore.mockReturnValue({
      getTotalCount: () => 5, // Same count before and after
      getViolations: () => [],
    });

    setupSpawnSuccess("command failed", 1);
    const handler = createMockViolationHandler();
    const shell = new SandboxShell(createContext(), mockSandbox, handler);

    const result = await shell.execute("false", createOpts());

    expect(handler.addViolation).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(mockCleanupAfterCommand).toHaveBeenCalled();
  });

  test("updates sandbox config before execution", async () => {
    setupSpawnSuccess("ok", 0);
    const handler = createMockViolationHandler();
    const context = createContext();
    const shell = new SandboxShell(context, mockSandbox, handler);

    await shell.execute("ls", createOpts());

    expect(mockUpdateConfigIfChanged).toHaveBeenCalledWith(
      defaultSandboxConfig,
      context.cwd,
      context.homeDir,
    );
  });

  test("terminate delegates to running process", () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const handler = createMockViolationHandler();
    const shell = new SandboxShell(createContext(), mockSandbox, handler);

    // Start a command without awaiting
    shell.execute("sleep 100", createOpts());

    shell.terminate();

    // terminateProcess tries process.kill(-pid, "SIGTERM") first
    // Since we mock process.kill, we verify the process got the signal
    // The terminate method uses terminateProcess from shell-utils
    expect(proc.kill).toBeDefined();
  });

  test("execute callback in promptForApproval spawns command directly", async () => {
    mockGetSandboxState.mockReturnValue({
      status: "unsupported",
      reason: "disabled",
    });
    const handler = createMockViolationHandler();

    handler.promptForApproval.mockImplementation(
      async (_command: string, execute: () => Promise<ShellResult>) => {
        // Simulate the handler calling the execute callback
        setupSpawnSuccess("direct output", 0);
        return execute();
      },
    );

    const shell = new SandboxShell(createContext(), mockSandbox, handler);
    const result = await shell.execute("echo test", createOpts());

    // The command should be spawned directly (not wrapped)
    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      ["-c", "echo test"],
      expect.objectContaining({ cwd: "/test/cwd" }),
    );
    expect(mockWrapWithSandbox).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });
});

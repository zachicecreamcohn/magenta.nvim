import type {
  DiagnosticsProvider,
  FileIO,
  LspClient,
  ThreadId,
  ToolCapability,
} from "@magenta/core";
import type { SandboxViolationHandler } from "./capabilities/sandbox-violation-handler.ts";
import type { Shell } from "./capabilities/shell.ts";
import type { Sandbox } from "./sandbox-manager.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";

export type EnvironmentConfig =
  | { type: "local" }
  | { type: "docker"; container: string; cwd: string };

export interface Environment {
  fileIO: FileIO;
  shell: Shell;
  sandboxViolationHandler?: SandboxViolationHandler | undefined;
  lspClient: LspClient;
  diagnosticsProvider: DiagnosticsProvider;
  cwd: NvimCwd;
  homeDir: HomeDir;
  availableCapabilities: Set<ToolCapability>;
  environmentConfig: EnvironmentConfig;
}

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { BufferTracker } from "./buffer-tracker.ts";
import { DockerFileIO } from "./capabilities/docker-file-io.ts";
import { DockerShell } from "./capabilities/docker-shell.ts";
import type { Lsp } from "./capabilities/lsp.ts";
import { NvimLspClient } from "./capabilities/lsp-client-adapter.ts";
import { NoopDiagnosticsProvider } from "./capabilities/noop-diagnostics-provider.ts";
import { NoopLspClient } from "./capabilities/noop-lsp-client.ts";
import { SandboxFileIO } from "./capabilities/sandbox-file-io.ts";
import { SandboxShell } from "./capabilities/sandbox-shell.ts";
import { SandboxViolationHandler as SandboxViolationHandlerImpl } from "./capabilities/sandbox-violation-handler.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import type { MagentaOptions } from "./options.ts";
import { getDiagnostics } from "./utils/diagnostics.ts";

export function createLocalEnvironment({
  nvim,
  lsp,
  bufferTracker,
  cwd,
  homeDir,
  getOptions,
  threadId,
  sandbox,
  onPendingChange,
}: {
  nvim: Nvim;
  lsp: Lsp;
  bufferTracker: BufferTracker;
  cwd: NvimCwd;
  homeDir: HomeDir;
  getOptions: () => MagentaOptions;
  threadId: ThreadId;
  sandbox: Sandbox;
  onPendingChange: () => void;
}): Environment {
  const violationHandler = new SandboxViolationHandlerImpl(onPendingChange);

  const sandboxFileIO = new SandboxFileIO(
    { nvim, bufferTracker, cwd, homeDir },
    sandbox,
    (absPath) => violationHandler.promptForWriteApproval(absPath),
  );

  const sandboxShell = new SandboxShell(
    { cwd, homeDir, threadId, getOptions },
    sandbox,
    violationHandler,
  );

  const lspClient = new NvimLspClient(lsp, nvim, cwd, homeDir);
  const diagnosticsProvider = {
    getDiagnostics: () => getDiagnostics(nvim, cwd, homeDir),
  };

  return {
    fileIO: sandboxFileIO,
    shell: sandboxShell,
    sandboxViolationHandler: violationHandler,
    lspClient,
    diagnosticsProvider,
    cwd,
    homeDir,
    availableCapabilities: new Set([
      "lsp",
      "shell",
      "diagnostics",
      "threads",
      "file-io",
    ]),
    environmentConfig: { type: "local" },
  };
}
const execFile = promisify(execFileCb);

export async function createDockerEnvironment({
  container,
  cwd: cwdParam,
  threadId,
}: {
  container: string;
  cwd?: string;
  threadId: ThreadId;
}): Promise<Environment> {
  const resolvedCwd: string =
    cwdParam ??
    (await execFile("docker", ["exec", container, "pwd"]).then((r) =>
      r.stdout.trim(),
    ));
  const resolvedHome = await execFile("docker", [
    "exec",
    container,
    "sh",
    "-c",
    "echo $HOME",
  ]).then((r) => r.stdout.trim());

  const fileIO = new DockerFileIO({ container });
  const shell = new DockerShell({ container, cwd: resolvedCwd, threadId });
  const lspClient = new NoopLspClient();
  const diagnosticsProvider = new NoopDiagnosticsProvider();

  return {
    fileIO,
    shell,
    sandboxViolationHandler: undefined,
    lspClient,
    diagnosticsProvider,
    cwd: resolvedCwd as NvimCwd,
    homeDir: resolvedHome as HomeDir,
    availableCapabilities: new Set(["file-io", "shell", "threads"]),
    environmentConfig: { type: "docker", container, cwd: resolvedCwd },
  };
}

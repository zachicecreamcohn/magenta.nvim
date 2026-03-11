import type {
  DiagnosticsProvider,
  FileIO,
  LspClient,
  ThreadId,
  ToolCapability,
} from "@magenta/core";
import type { PermissionCheckingFileIO } from "./capabilities/permission-file-io.ts";
import type { PermissionCheckingShell } from "./capabilities/permission-shell.ts";
import type { Shell } from "./capabilities/shell.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";

export type EnvironmentConfig =
  | { type: "local" }
  | { type: "docker"; container: string; cwd: string };

export interface Environment {
  fileIO: FileIO;
  permissionFileIO?: PermissionCheckingFileIO | undefined;
  shell: Shell;
  permissionShell?: PermissionCheckingShell | undefined;
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
import { BaseShell } from "./capabilities/base-shell.ts";
import { BufferAwareFileIO } from "./capabilities/buffer-file-io.ts";
import { DockerFileIO } from "./capabilities/docker-file-io.ts";
import { DockerShell } from "./capabilities/docker-shell.ts";
import type { Lsp } from "./capabilities/lsp.ts";
import { NvimLspClient } from "./capabilities/lsp-client-adapter.ts";
import { NoopDiagnosticsProvider } from "./capabilities/noop-diagnostics-provider.ts";
import { NoopLspClient } from "./capabilities/noop-lsp-client.ts";
import { PermissionCheckingFileIO as PermissionCheckingFileIOImpl } from "./capabilities/permission-file-io.ts";
import { PermissionCheckingShell as PermissionCheckingShellImpl } from "./capabilities/permission-shell.ts";
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
  rememberedCommands,
  onPendingChange,
}: {
  nvim: Nvim;
  lsp: Lsp;
  bufferTracker: BufferTracker;
  cwd: NvimCwd;
  homeDir: HomeDir;
  getOptions: () => MagentaOptions;
  threadId: ThreadId;
  rememberedCommands: Set<string>;
  onPendingChange: () => void;
}): Environment {
  const bufferFileIO = new BufferAwareFileIO({
    nvim,
    bufferTracker,
    cwd,
    homeDir,
  });
  const permissionFileIO = new PermissionCheckingFileIOImpl(
    bufferFileIO,
    { cwd, homeDir, getOptions, nvim },
    onPendingChange,
  );

  const baseShell = new BaseShell({ cwd, threadId });
  const permissionShell = new PermissionCheckingShellImpl(
    baseShell,
    { cwd, homeDir, getOptions, nvim, rememberedCommands },
    onPendingChange,
  );

  const lspClient = new NvimLspClient(lsp, nvim, cwd, homeDir);
  const diagnosticsProvider = {
    getDiagnostics: () => getDiagnostics(nvim, cwd, homeDir),
  };

  return {
    fileIO: permissionFileIO,
    permissionFileIO,
    shell: permissionShell,
    permissionShell,
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
    permissionFileIO: undefined,
    shell,
    permissionShell: undefined,
    lspClient,
    diagnosticsProvider,
    cwd: resolvedCwd as NvimCwd,
    homeDir: resolvedHome as HomeDir,
    availableCapabilities: new Set(["file-io", "shell", "threads"]),
    environmentConfig: { type: "docker", container, cwd: resolvedCwd },
  };
}

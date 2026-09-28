import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { DockerFileIO } from "./capabilities/docker-file-io.ts";
import { DockerShell } from "./capabilities/docker-shell.ts";
import type { FileIO } from "./capabilities/file-io.ts";
import type { GitClient } from "./capabilities/git-client.ts";
import { DockerGitClient, LocalGitClient } from "./capabilities/git-clients.ts";
import type { LspClient } from "./capabilities/lsp-client.ts";
import type { LuaExecutor } from "./capabilities/lua-executor.ts";
import { NoopLspClient } from "./capabilities/noop-lsp-client.ts";
import { SandboxFileIO } from "./capabilities/sandbox-file-io.ts";
import { SandboxShell } from "./capabilities/sandbox-shell.ts";
import { SandboxViolationHandler } from "./capabilities/sandbox-violation-handler.ts";
import type { Shell } from "./capabilities/shell.ts";
import type { ThreadId } from "./chat-types.ts";
import type { Logger } from "./logger.ts";
import type { SandboxConfig } from "./sandbox-config.ts";
import type { Sandbox } from "./sandbox-manager.ts";
import type { ToolCapability } from "./tools/tool-registry.ts";
import {
  type AbsFilePath,
  type Cwd,
  type HomeDir,
  toCwd,
} from "./utils/files.ts";
export type EnvironmentConfig =
  | { type: "local"; cwd?: Cwd }
  | { type: "docker"; container: string; cwd: string };

export interface Environment {
  fileIO: FileIO;
  shell: Shell;
  gitClient: GitClient;
  sandboxViolationHandler?: SandboxViolationHandler | undefined;
  lspClient: LspClient;
  luaExecutor?: LuaExecutor | undefined;
  cwd: Cwd;
  homeDir: HomeDir;
  availableCapabilities: Set<ToolCapability>;
  environmentConfig: EnvironmentConfig;
}

export function createLocalEnvironment({
  logger,
  cwd,
  homeDir,
  getSandboxConfig,
  threadId,
  sandbox,
  onPendingChange,
  isBypassed,
  lspClient,
  luaExecutor,
  onFileWritten,
}: {
  logger: Logger;
  cwd: Cwd;
  homeDir: HomeDir;
  getSandboxConfig: () => SandboxConfig;
  threadId: ThreadId;
  sandbox: Sandbox;
  onPendingChange: () => void;
  isBypassed: () => boolean;
  /** Editor-backed; the lsp tools are only offered when supplied. */
  lspClient?: LspClient | undefined;
  /** Editor-backed; the nvim tools are only offered when supplied. */
  luaExecutor?: LuaExecutor | undefined;
  onFileWritten?: ((absPath: AbsFilePath) => Promise<void>) | undefined;
}): Environment {
  const violationHandler = new SandboxViolationHandler(onPendingChange);
  const sandboxFileIO = new SandboxFileIO(
    { logger, cwd, homeDir },
    sandbox,
    (absPath) => violationHandler.promptForWriteApproval(absPath),
    isBypassed,
    onFileWritten,
  );
  const sandboxShell = new SandboxShell(
    { cwd, homeDir, threadId, getSandboxConfig, isBypassed },
    sandbox,
    violationHandler,
  );
  const availableCapabilities = new Set<ToolCapability>([
    "shell",
    "threads",
    "file-io",
    "scripts",
  ]);
  if (lspClient) availableCapabilities.add("lsp");
  if (luaExecutor) availableCapabilities.add("nvim");
  return {
    fileIO: sandboxFileIO,
    shell: sandboxShell,
    gitClient: new LocalGitClient(cwd),
    sandboxViolationHandler: violationHandler,
    lspClient: lspClient ?? new NoopLspClient(),
    luaExecutor,
    cwd,
    homeDir,
    availableCapabilities,
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

  return {
    fileIO,
    shell,
    gitClient: new DockerGitClient(container, resolvedCwd),
    sandboxViolationHandler: undefined,
    lspClient,
    cwd: toCwd(resolvedCwd),
    homeDir: resolvedHome as HomeDir,
    availableCapabilities: new Set(["file-io", "shell", "threads"]),
    environmentConfig: { type: "docker", container, cwd: resolvedCwd },
  };
}

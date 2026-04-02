import * as path from "node:path";
import type {
  SandboxAskCallback,
  SandboxRuntimeConfig,
  SandboxViolationEvent,
} from "@anthropic-ai/sandbox-runtime";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxConfig } from "./options.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";

export type SandboxState =
  | { status: "uninitialized" }
  | { status: "ready" }
  | { status: "unsupported"; reason: string };

export type FsReadConfig = { denyOnly: string[]; allowWithinDeny?: string[] };
export type FsWriteConfig = { allowOnly: string[]; denyWithinAllow: string[] };

export interface Sandbox {
  getState(): SandboxState;
  wrapWithSandbox(command: string): Promise<string>;
  getViolationStore(): {
    getTotalCount(): number;
    getViolations(count: number): SandboxViolationEvent[];
  };
  annotateStderrWithSandboxFailures(command: string, stderr: string): string;
  getFsReadConfig(): FsReadConfig;
  getFsWriteConfig(): FsWriteConfig;
  updateConfigIfChanged(
    config: SandboxConfig,
    cwd: NvimCwd,
    homeDir: HomeDir,
  ): void;
  cleanupAfterCommand(): void;
}

// -- Path resolution helpers --

function resolvePath(p: string, cwd: NvimCwd, homeDir: HomeDir): string {
  if (p.startsWith("~/")) {
    return path.join(homeDir, p.slice(2));
  }
  if (p.startsWith("./")) {
    return path.join(cwd, p.slice(2));
  }
  if (path.isAbsolute(p)) {
    return p;
  }
  return path.join(cwd, p);
}

function resolvePaths(
  paths: string[],
  cwd: NvimCwd,
  homeDir: HomeDir,
): string[] {
  return paths.map((p) => resolvePath(p, cwd, homeDir));
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

export function resolveConfigPaths(
  config: SandboxConfig,
  cwd: NvimCwd,
  homeDir: HomeDir,
): SandboxRuntimeConfig {
  return {
    filesystem: {
      allowWrite: dedup(
        resolvePaths(config.filesystem.allowWrite, cwd, homeDir),
      ),
      denyWrite: dedup(resolvePaths(config.filesystem.denyWrite, cwd, homeDir)),
      denyRead: dedup(resolvePaths(config.filesystem.denyRead, cwd, homeDir)),
      allowRead: dedup(resolvePaths(config.filesystem.allowRead, cwd, homeDir)),
    },
    network: {
      allowedDomains: dedup(config.network.allowedDomains),
      deniedDomains: dedup(config.network.deniedDomains),
    },
  };
}

// -- Real implementation wrapping @anthropic-ai/sandbox-runtime --

class RealSandbox implements Sandbox {
  private state: SandboxState;
  private lastConfigJson: string | undefined;

  constructor(state: SandboxState, lastConfigJson?: string) {
    this.state = state;
    this.lastConfigJson = lastConfigJson;
  }

  getState(): SandboxState {
    return this.state;
  }

  wrapWithSandbox(command: string): Promise<string> {
    return SandboxManager.wrapWithSandbox(command);
  }

  getViolationStore() {
    return SandboxManager.getSandboxViolationStore();
  }

  annotateStderrWithSandboxFailures(command: string, stderr: string): string {
    return SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
  }

  getFsReadConfig(): FsReadConfig {
    return SandboxManager.getFsReadConfig();
  }

  getFsWriteConfig(): FsWriteConfig {
    return SandboxManager.getFsWriteConfig();
  }

  updateConfigIfChanged(
    config: SandboxConfig,
    cwd: NvimCwd,
    homeDir: HomeDir,
  ): void {
    const runtimeConfig = resolveConfigPaths(config, cwd, homeDir);
    const configJson = JSON.stringify(runtimeConfig);
    if (configJson === this.lastConfigJson) {
      return;
    }
    this.lastConfigJson = configJson;
    SandboxManager.updateConfig(runtimeConfig);
  }

  cleanupAfterCommand(): void {
    SandboxManager.cleanupAfterCommand();
  }
}

// -- Factory --

export async function initializeSandbox(
  config: SandboxConfig,
  cwd: NvimCwd,
  homeDir: HomeDir,
  askCallback: SandboxAskCallback | undefined,
  logger: { warn(msg: string): void },
): Promise<Sandbox> {
  if (!SandboxManager.isSupportedPlatform()) {
    const reason = "Sandbox is not supported on this platform";
    logger.warn(reason);
    return new RealSandbox({ status: "unsupported", reason });
  }

  const depCheck = SandboxManager.checkDependencies();
  if (depCheck.errors.length > 0) {
    const reason = `Sandbox dependencies missing: ${depCheck.errors.join(", ")}`;
    logger.warn(reason);
    return new RealSandbox({ status: "unsupported", reason });
  }

  if (depCheck.warnings.length > 0) {
    for (const warning of depCheck.warnings) {
      logger.warn(`Sandbox dependency warning: ${warning}`);
    }
  }

  const runtimeConfig = resolveConfigPaths(config, cwd, homeDir);
  await SandboxManager.initialize(runtimeConfig, askCallback, true);
  const lastConfigJson = JSON.stringify(runtimeConfig);

  return new RealSandbox({ status: "ready" }, lastConfigJson);
}

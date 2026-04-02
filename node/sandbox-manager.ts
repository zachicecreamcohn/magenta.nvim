import * as path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type {
  SandboxRuntimeConfig,
  SandboxAskCallback,
} from "@anthropic-ai/sandbox-runtime";
import type { SandboxConfig } from "./options.ts";
import type { NvimCwd, HomeDir } from "./utils/files.ts";

export type SandboxState =
  | { status: "uninitialized" }
  | { status: "initializing" }
  | { status: "ready" }
  | { status: "unsupported"; reason: string }
  | { status: "disabled" };

let state: SandboxState = { status: "uninitialized" };
let lastConfigJson: string | undefined;

export function getSandboxState(): SandboxState {
  return state;
}

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

export function resolveConfigPaths(
  config: SandboxConfig,
  cwd: NvimCwd,
  homeDir: HomeDir,
): SandboxRuntimeConfig {
  return {
    filesystem: {
      allowWrite: resolvePaths(config.filesystem.allowWrite, cwd, homeDir),
      denyWrite: resolvePaths(config.filesystem.denyWrite, cwd, homeDir),
      denyRead: resolvePaths(config.filesystem.denyRead, cwd, homeDir),
    },
    network: {
      allowedDomains: config.network.allowedDomains,
      deniedDomains: config.network.deniedDomains,
    },
  };
}

export async function initializeSandbox(
  config: SandboxConfig,
  cwd: NvimCwd,
  homeDir: HomeDir,
  askCallback: SandboxAskCallback | undefined,
  logger: { warn(msg: string): void },
): Promise<SandboxState> {
  if (!config.enabled) {
    state = { status: "disabled" };
    return state;
  }

  if (!SandboxManager.isSupportedPlatform()) {
    const reason = "Sandbox is not supported on this platform";
    logger.warn(reason);
    state = { status: "unsupported", reason };
    return state;
  }

  const depCheck = SandboxManager.checkDependencies();
  if (depCheck.errors.length > 0) {
    const reason = `Sandbox dependencies missing: ${depCheck.errors.join(", ")}`;
    logger.warn(reason);
    state = { status: "unsupported", reason };
    return state;
  }

  if (depCheck.warnings.length > 0) {
    for (const warning of depCheck.warnings) {
      logger.warn(`Sandbox dependency warning: ${warning}`);
    }
  }

  state = { status: "initializing" };

  const runtimeConfig = resolveConfigPaths(config, cwd, homeDir);
  await SandboxManager.initialize(runtimeConfig, askCallback, true);
  lastConfigJson = JSON.stringify(runtimeConfig);

  state = { status: "ready" };
  return state;
}

export function updateSandboxConfigIfChanged(
  config: SandboxConfig,
  cwd: NvimCwd,
  homeDir: HomeDir,
): void {
  const runtimeConfig = resolveConfigPaths(config, cwd, homeDir);
  const configJson = JSON.stringify(runtimeConfig);
  if (configJson === lastConfigJson) {
    return;
  }
  lastConfigJson = configJson;
  SandboxManager.updateConfig(runtimeConfig);
}

export async function resetSandbox(): Promise<void> {
  await SandboxManager.reset();
  state = { status: "uninitialized" };
  lastConfigJson = undefined;
}

import { platform } from "node:os";
import {
  COMPACT_SYSTEM_PROMPT,
  createSystemPrompt as coreCreateSystemPrompt,
  type FileIO,
  type HomeDir,
  type NvimCwd,
  type ProviderOptions,
  type SubagentConfig,
  type SystemInfo,
  type SystemPrompt,
  type ThreadType,
} from "@magenta/core";
import type { Nvim } from "../nvim/nvim-node/index.ts";

export { COMPACT_SYSTEM_PROMPT };

export type { SystemInfo, SystemPrompt } from "@magenta/core";

export async function createSystemPrompt(
  type: ThreadType,
  context: {
    nvim: Nvim;
    cwd: NvimCwd;
    options: ProviderOptions;
    fileIO: FileIO;
    homeDir: HomeDir;
    systemInfoOverrides?: Partial<SystemInfo>;
    dockerAvailable?: boolean;
    subagentConfig?: SubagentConfig;
  },
): Promise<SystemPrompt> {
  const neovimVersion = (await context.nvim.call("nvim_eval", [
    "v:version",
  ])) as string;

  return coreCreateSystemPrompt(type, {
    systemInfo: {
      timestamp: new Date().toString(),
      platform: platform(),
      neovimVersion,
      cwd: context.cwd,
      ...context.systemInfoOverrides,
    },
    logger: context.nvim.logger,
    cwd: context.cwd,
    options: context.options,
    fileIO: context.fileIO,
    homeDir: context.homeDir,
    ...(context.dockerAvailable
      ? { dockerAvailable: context.dockerAvailable }
      : {}),
    ...(context.subagentConfig
      ? { subagentConfig: context.subagentConfig }
      : {}),
  });
}

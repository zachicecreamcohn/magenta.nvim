import { platform } from "node:os";
import {
  COMPACT_SYSTEM_PROMPT,
  CONDUCTOR_SYSTEM_PROMPT,
  createSystemPrompt as coreCreateSystemPrompt,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  type NvimCwd,
  type ProviderOptions,
  type SubagentConfig,
  type SystemInfo,
  type SystemPrompt,
  type ThreadType,
} from "@magenta/core";
import type { Nvim } from "../nvim/nvim-node/index.ts";

export {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  COMPACT_SYSTEM_PROMPT,
  CONDUCTOR_SYSTEM_PROMPT,
};

export type { SystemInfo, SystemPrompt } from "@magenta/core";

export async function createSystemPrompt(
  type: ThreadType,
  context: {
    nvim: Nvim;
    cwd: NvimCwd;
    options: ProviderOptions;
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
    ...(context.dockerAvailable
      ? { dockerAvailable: context.dockerAvailable }
      : {}),
    ...(context.subagentConfig
      ? { subagentConfig: context.subagentConfig }
      : {}),
  });
}

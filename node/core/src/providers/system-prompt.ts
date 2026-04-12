import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileIO } from "../capabilities/file-io.ts";
import type { SubagentConfig, ThreadType } from "../chat-types.ts";
import type { Logger } from "../logger.ts";
import type { ProviderOptions } from "../provider-options.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import {
  formatSkillsIntroduction,
  loadSkills,
  type SkillsMap,
} from "./skills.ts";

export type SystemPrompt = string & { __systemPrompt: true };

export interface SystemInfo {
  timestamp: string;
  platform: string;
  neovimVersion: string;
  cwd: NvimCwd;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPTS_DIR = path.join(__dirname, "prompts");

function loadPrompt(filename: string): string {
  return readFileSync(path.join(PROMPTS_DIR, filename), "utf8");
}

export const DEFAULT_SYSTEM_PROMPT =
  loadPrompt("default-system-prompt.md") +
  "\n\n" +
  loadPrompt("codebase-conventions.md") +
  "\n" +
  loadPrompt("code-changes.md") +
  "\n" +
  loadPrompt("system-reminder.md");

export const DEFAULT_SUBAGENT_SYSTEM_PROMPT =
  loadPrompt("subagent-common.md") +
  "\n" +
  loadPrompt("codebase-conventions.md") +
  "\n" +
  loadPrompt("code-changes.md");

export const COMPACT_SYSTEM_PROMPT =
  "You are a compaction agent that reduces conversation transcripts using the edl tool. You MUST write your summary to the `/summary.md` file using the edl tool. Do NOT place the summary in your text response — only the contents of `/summary.md` are captured.";

function getBaseSystemPrompt(
  type: ThreadType,
  opts: {
    dockerAvailable?: boolean;
    subagentConfig?: SubagentConfig | undefined;
  },
): string {
  switch (type) {
    case "subagent":
      return (
        opts.subagentConfig?.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT
      );
    case "compact":
      return COMPACT_SYSTEM_PROMPT;
    case "root":
      return DEFAULT_SYSTEM_PROMPT;
    case "docker_root": {
      return (
        DEFAULT_SYSTEM_PROMPT +
        "\n\n# Docker Environment\n\n" +
        "You are running inside an isolated Docker container. " +
        "You have full shell access and can install packages, run builds, and execute tests freely. " +
        "When your task is complete, call `yield_to_parent` with a summary of what you did. " +
        "Your file changes will be automatically synced back to the host.\n\n" +
        "**Important rules:**\n" +
        "- Do NOT stop without yielding. If you need to pause, explain why in your yield message."
      );
    }
    default:
      assertUnreachable(type);
  }
}

export async function createSystemPrompt(
  type: ThreadType,
  context: {
    systemInfo: SystemInfo;
    logger: Logger;
    cwd: NvimCwd;
    options: ProviderOptions;
    fileIO: FileIO;
    homeDir: HomeDir;
    dockerAvailable?: boolean;
    subagentConfig?: SubagentConfig;
  },
): Promise<SystemPrompt> {
  const basePrompt = getBaseSystemPrompt(type, {
    ...(context.dockerAvailable ? { dockerAvailable: true } : {}),
    subagentConfig: context.subagentConfig,
  });
  const skills =
    type === "compact" ? ({} as SkillsMap) : await loadSkills(context);
  const systemInfo = context.systemInfo;

  const systemInfoText = `

# System Information
- Current time: ${systemInfo.timestamp}
- Operating system: ${systemInfo.platform}
- Neovim version: ${systemInfo.neovimVersion}
- Current working directory: ${systemInfo.cwd}`;

  const skillsText = formatSkillsIntroduction(skills, systemInfo.cwd);

  return (basePrompt + systemInfoText + skillsText) as SystemPrompt;
}

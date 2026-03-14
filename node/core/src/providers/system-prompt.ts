import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadType } from "../chat-types.ts";
import type { Logger } from "../logger.ts";
import type { ProviderOptions } from "../provider-options.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { NvimCwd } from "../utils/files.ts";
import {
  formatSkillsIntroduction,
  loadSkills,
  type SkillsMap,
} from "./skills.ts";

export const AGENT_TYPES = ["default", "fast", "explore"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

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

export const EXPLORE_SUBAGENT_SYSTEM_PROMPT = loadPrompt("explore-subagent.md");
export const CONDUCTOR_SYSTEM_PROMPT = loadPrompt("conductor-system-prompt.md");
const CONDUCTOR_DOCKER_ADDENDUM = loadPrompt("conductor-docker-addendum.md");
export const COMPACT_SYSTEM_PROMPT =
  "You are a compaction agent that reduces conversation transcripts using the edl tool. You MUST write your summary to the `/summary.md` file using the edl tool. Do NOT place the summary in your text response — only the contents of `/summary.md` are captured.";

function getBaseSystemPrompt(
  type: ThreadType,
  dockerContext?: DockerContext,
): string {
  switch (type) {
    case "subagent_default":
      return DEFAULT_SUBAGENT_SYSTEM_PROMPT;
    case "subagent_fast":
      return DEFAULT_SUBAGENT_SYSTEM_PROMPT;
    case "subagent_explore":
      return EXPLORE_SUBAGENT_SYSTEM_PROMPT;
    case "compact":
      return COMPACT_SYSTEM_PROMPT;
    case "root":
      return DEFAULT_SYSTEM_PROMPT;
    case "conductor": {
      const base = CONDUCTOR_SYSTEM_PROMPT;
      if (dockerContext) {
        return `${base}\n\n${CONDUCTOR_DOCKER_ADDENDUM}`;
      }
      return base;
    }
    case "docker_root": {
      const branchInfo = dockerContext
        ? `\n\nYou are working on branch \`${dockerContext.workerBranch}\` (forked from \`${dockerContext.baseBranch}\`).`
        : "";
      return (
        DEFAULT_SYSTEM_PROMPT +
        "\n\n# Docker Environment\n\n" +
        "You are running inside an isolated Docker container. " +
        "You have full shell access and can install packages, run builds, and execute tests freely." +
        branchInfo +
        "\n\n**Important rules:**\n" +
        "- Commit all your changes to the current branch with `git commit` before finishing.\n" +
        "- Do NOT use `git push` — there is no remote configured inside the container.\n" +
        "- When your task is complete and all changes are committed, call `yield_to_parent` with a summary of what you did.\n" +
        "- Your git working tree must be clean (no uncommitted changes) when you yield.\n" +
        "- When you yield, your commits will be automatically synced back to the host repository. " +
        "The parent agent will see your changes on the worker branch.\n" +
        "- Do NOT stop without yielding. If you need to pause, explain why in your yield message."
      );
    }
    default:
      assertUnreachable(type);
  }
}

export interface DockerContext {
  workerBranch: string;
  baseBranch: string;
}

export function createSystemPrompt(
  type: ThreadType,
  context: {
    systemInfo: SystemInfo;
    logger: Logger;
    cwd: NvimCwd;
    options: ProviderOptions;
    dockerContext?: DockerContext;
  },
): SystemPrompt {
  const basePrompt = getBaseSystemPrompt(type, context.dockerContext);
  const skills = type === "compact" ? ({} as SkillsMap) : loadSkills(context);
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

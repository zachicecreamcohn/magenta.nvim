import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Logger } from "../logger.ts";
import type { ProviderOptions } from "../provider-options.ts";
import type { AbsFilePath, NvimCwd } from "../utils/files.ts";

export type AgentInfo = {
  agentFile: AbsFilePath;
  name: string;
  description: string;
  systemPrompt: string;
  systemReminder: string | undefined;
  fastModel: boolean | undefined;
};

export type AgentsMap = {
  [agentName: string]: AgentInfo;
};

type AgentFrontmatter = {
  name?: string;
  description?: string;
  fastModel?: boolean;
};

export function loadAgents(context: {
  cwd: NvimCwd;
  logger: Logger;
  options: ProviderOptions;
}): AgentsMap {
  const agents: AgentsMap = {};

  if (!context.options.agentsPaths || context.options.agentsPaths.length === 0) {
    return agents;
  }

  try {
    for (const agentsDir of context.options.agentsPaths) {
      const agentFiles = findAgentFilesInDirectory(agentsDir, context);

      for (const agentFile of agentFiles) {
        try {
          const agentInfo = parseAgentFile(agentFile, context);
          if (agentInfo) {
            if (agentInfo.name in agents) {
              context.logger.info(
                `Agent "${agentInfo.name}" from ${agentFile} overrides agent from ${agents[agentInfo.name].agentFile}`,
              );
            }
            agents[agentInfo.name] = agentInfo;
          }
        } catch (err) {
          context.logger.error(
            `Error parsing agent file ${agentFile}: ${(err as Error).message}`,
          );
        }
      }
    }
  } catch (err) {
    context.logger.error(`Error loading agents: ${(err as Error).message}`);
  }

  return agents;
}

function expandTilde(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

function findAgentFilesInDirectory(
  agentsDir: string,
  context: {
    cwd: NvimCwd;
    logger: Logger;
  },
): AbsFilePath[] {
  const agentFiles: AbsFilePath[] = [];

  try {
    const expandedDir = expandTilde(agentsDir);
    const agentsDirPath = path.isAbsolute(expandedDir)
      ? expandedDir
      : path.join(context.cwd, expandedDir);

    try {
      const stats = fs.statSync(agentsDirPath);
      if (!stats.isDirectory()) {
        context.logger.warn(`Agents path "${agentsDir}" is not a directory`);
        return agentFiles;
      }
    } catch {
      return agentFiles;
    }

    const entries = fs.readdirSync(agentsDirPath);

    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".md")) {
        continue;
      }

      const entryPath = path.join(agentsDirPath, entry);

      try {
        const stats = fs.statSync(entryPath);
        if (!stats.isFile()) {
          continue;
        }
      } catch {
        continue;
      }

      agentFiles.push(entryPath as AbsFilePath);
    }
  } catch (err) {
    context.logger.error(
      `Error processing agents directory "${agentsDir}": ${(err as Error).message}`,
    );
  }

  return agentFiles;
}

export function parseAgentFile(
  agentFile: AbsFilePath,
  context: { logger: Logger },
): AgentInfo | undefined {
  const content = fs.readFileSync(agentFile, "utf8");

  const frontmatter = extractAgentFrontmatter(content);

  if (!frontmatter) {
    context.logger.warn(
      `Agent file ${agentFile} is missing YAML frontmatter`,
    );
    return undefined;
  }

  if (!frontmatter.name || !frontmatter.description) {
    context.logger.warn(
      `Agent file ${agentFile} is missing required fields (name and/or description) in YAML frontmatter`,
    );
    return undefined;
  }

  const body = extractBody(content);
  const { systemPrompt, systemReminder } = extractSystemReminder(body);

  return {
    agentFile,
    name: frontmatter.name,
    description: frontmatter.description,
    systemPrompt,
    systemReminder,
    fastModel: frontmatter.fastModel,
  };
}

function extractAgentFrontmatter(
  content: string,
): AgentFrontmatter | undefined {
  const lines = content.split("\n");

  if (lines.length === 0 || lines[0].trim() !== "---") {
    return undefined;
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return undefined;
  }

  const result: AgentFrontmatter = {};
  for (let i = 1; i < endIndex; i++) {
    const colonIndex = lines[i].indexOf(":");
    if (colonIndex === -1) continue;
    const key = lines[i].slice(0, colonIndex).trim();
    const value = lines[i].slice(colonIndex + 1).trim();
    if (key === "name" || key === "description") {
      result[key] = value;
    } else if (key === "fastModel") {
      result.fastModel = value === "true";
    }
  }
  return result;
}

function extractBody(content: string): string {
  const lines = content.split("\n");

  if (lines.length === 0 || lines[0].trim() !== "---") {
    return content;
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return content;
  }

  return lines.slice(endIndex + 1).join("\n").trim();
}

function extractSystemReminder(body: string): {
  systemPrompt: string;
  systemReminder: string | undefined;
} {
  const reminderMatch = body.match(
    /<system_reminder>\s*\n([\s\S]*?)\n\s*<\/system_reminder>/,
  );

  if (!reminderMatch) {
    return { systemPrompt: body, systemReminder: undefined };
  }

  const systemReminder = reminderMatch[1].trim();
  const systemPrompt = body
    .replace(/<system_reminder>\s*\n[\s\S]*?\n\s*<\/system_reminder>/, "")
    .trim();

  return { systemPrompt, systemReminder };
}

export function formatAgentsIntroduction(
  agents: AgentsMap,
  cwd: NvimCwd,
): string {
  if (Object.keys(agents).length === 0) {
    return "";
  }

  const agentsList = Object.values(agents)
    .map((agent) => {
      const relPath = path.relative(cwd, agent.agentFile);
      const displayPath = relPath.startsWith("..") ? agent.agentFile : relPath;
      return `- **${agent.name}** (\`${displayPath}\`): ${agent.description}`;
    })
    .join("\n");

  return `
# Available Agents

Here are the agent types you can use with spawn_subagents:

<available-agents>
${agentsList}
</available-agents>`;
}

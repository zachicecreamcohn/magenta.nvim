import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Nvim } from "../nvim/nvim-node";
import type { MagentaOptions } from "../options";
import type { NvimCwd, RelFilePath } from "../utils/files";

export type SkillInfo = {
  skillFile: RelFilePath;
  name: string;
  description: string;
};

export type SkillsMap = {
  [skillName: string]: SkillInfo;
};

type YamlFrontmatter = {
  name?: string;
  description?: string;
};

export function loadSkills(context: {
  cwd: NvimCwd;
  nvim: Nvim;
  options: MagentaOptions;
}): SkillsMap {
  const skills: SkillsMap = {};

  if (
    !context.options.skillsPaths ||
    context.options.skillsPaths.length === 0
  ) {
    return skills;
  }

  try {
    const skillFiles = findSkillFiles(context);

    for (const skillFile of skillFiles) {
      try {
        const skillInfo = parseSkillFile(skillFile, context);
        if (skillInfo) {
          // Check for duplicate skill names
          if (skillInfo.name in skills) {
            context.nvim.logger.warn(
              `Duplicate skill name "${skillInfo.name}" found in ${skillFile}. Using first occurrence from ${skills[skillInfo.name].skillFile}`,
            );
          } else {
            skills[skillInfo.name] = skillInfo;
          }
        }
      } catch (err) {
        context.nvim.logger.error(
          `Error parsing skill file ${skillFile}: ${(err as Error).message}`,
        );
      }
    }
  } catch (err) {
    context.nvim.logger.error(
      `Error loading skills: ${(err as Error).message}`,
    );
  }

  return skills;
}

function findSkillFiles(context: {
  cwd: NvimCwd;
  nvim: Nvim;
  options: MagentaOptions;
}): RelFilePath[] {
  const skillFiles: RelFilePath[] = [];

  for (const skillsDir of context.options.skillsPaths) {
    try {
      const skillsDirPath = path.join(context.cwd, skillsDir);

      // Check if the skills directory exists
      try {
        const stats = fs.statSync(skillsDirPath);
        if (!stats.isDirectory()) {
          context.nvim.logger.warn(
            `Skills path "${skillsDir}" is not a directory`,
          );
          continue;
        }
      } catch {
        // Directory doesn't exist, skip silently
        continue;
      }

      // Read immediate children of the skills directory
      const entries = fs.readdirSync(skillsDirPath);

      for (const entry of entries) {
        const entryPath = path.join(skillsDirPath, entry);

        // Check if it's a directory
        try {
          const stats = fs.statSync(entryPath);
          if (!stats.isDirectory()) {
            continue;
          }
        } catch {
          continue;
        }

        // Look for skill.md file (case-insensitive)
        const files = fs.readdirSync(entryPath);
        const skillFile = files.find(
          (file) => file.toLowerCase() === "skill.md",
        );

        if (skillFile) {
          const fullPath = path.join(skillsDir, entry, skillFile);
          skillFiles.push(fullPath as RelFilePath);
        }
      }
    } catch (err) {
      context.nvim.logger.error(
        `Error processing skills directory "${skillsDir}": ${(err as Error).message}`,
      );
    }
  }

  return skillFiles;
}

function parseSkillFile(
  skillFile: RelFilePath,
  context: { cwd: NvimCwd; nvim: Nvim },
): SkillInfo | undefined {
  const fullPath = path.join(context.cwd, skillFile);
  const content = fs.readFileSync(fullPath, "utf8");

  const frontmatter = extractYamlFrontmatter(content);

  if (!frontmatter) {
    context.nvim.logger.warn(
      `Skill file ${skillFile} is missing YAML frontmatter`,
    );
    return undefined;
  }

  if (!frontmatter.name || !frontmatter.description) {
    context.nvim.logger.warn(
      `Skill file ${skillFile} is missing required fields (name and/or description) in YAML frontmatter`,
    );
    return undefined;
  }

  return {
    skillFile,
    name: frontmatter.name,
    description: frontmatter.description,
  };
}

function extractYamlFrontmatter(content: string): YamlFrontmatter | undefined {
  const lines = content.split("\n");

  // First line must be just "---"
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return undefined;
  }

  // Find the closing "---" line
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

  // Extract YAML content between the delimiters
  const yamlLines = lines.slice(1, endIndex);
  const yamlContent = yamlLines.join("\n");

  try {
    const parsed = parseYaml(yamlContent) as YamlFrontmatter;
    return parsed;
  } catch (err) {
    throw new Error(
      `Failed to parse YAML frontmatter: ${(err as Error).message}`,
    );
  }
}

export function formatSkillsIntroduction(skills: SkillsMap): string {
  if (Object.keys(skills).length === 0) {
    return "";
  }

  const skillsList = Object.values(skills)
    .map(
      (skill) =>
        `- **${skill.name}** (\`${skill.skillFile}\`): ${skill.description}`,
    )
    .join("\n");

  return `

# Skills

Here are skills you have available to you:

${skillsList}

When a skill is relevant to a task, use the get_file tool to read the skill file.`;
}

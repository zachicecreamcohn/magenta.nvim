import { glob } from "glob";
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

export class SkillsManager {
  public skills: SkillsMap;
  private hasShownSkills: boolean;

  private constructor(skills: SkillsMap) {
    this.skills = skills;
    this.hasShownSkills = false;
  }

  static async create(context: {
    cwd: NvimCwd;
    nvim: Nvim;
    options: MagentaOptions;
  }): Promise<SkillsManager> {
    const skills = await SkillsManager.loadSkills(context);
    return new SkillsManager(skills);
  }

  private static async loadSkills(context: {
    cwd: NvimCwd;
    nvim: Nvim;
    options: MagentaOptions;
  }): Promise<SkillsMap> {
    const skills: SkillsMap = {};

    if (
      !context.options.skillsPaths ||
      context.options.skillsPaths.length === 0
    ) {
      return skills;
    }

    try {
      const skillFiles = await this.findSkillFiles(context);

      for (const skillFile of skillFiles) {
        try {
          const skillInfo = this.parseSkillFile(skillFile, context);
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

  private static async findSkillFiles(context: {
    cwd: NvimCwd;
    nvim: Nvim;
    options: MagentaOptions;
  }): Promise<RelFilePath[]> {
    const skillFiles: RelFilePath[] = [];

    for (const pattern of context.options.skillsPaths) {
      try {
        // Find all items matching the pattern, then filter to directories
        const matches = await glob(pattern, {
          cwd: context.cwd,
          nocase: true,
        });

        for (const match of matches) {
          const dirPath = path.join(context.cwd, match);

          // Check if it's a directory
          try {
            const stats = fs.statSync(dirPath);
            if (!stats.isDirectory()) {
              continue;
            }
          } catch {
            continue;
          }

          // Look for skill.md file (case-insensitive)
          const files = fs.readdirSync(dirPath);
          const skillFile = files.find(
            (file) => file.toLowerCase() === "skill.md",
          );

          if (skillFile) {
            const fullPath = path.join(match, skillFile);
            skillFiles.push(fullPath as RelFilePath);
          }
        }
      } catch (err) {
        context.nvim.logger.error(
          `Error processing skills pattern "${pattern}": ${(err as Error).message}`,
        );
      }
    }

    return skillFiles;
  }

  private static parseSkillFile(
    skillFile: RelFilePath,
    context: { cwd: NvimCwd; nvim: Nvim },
  ): SkillInfo | undefined {
    const fullPath = path.join(context.cwd, skillFile);
    const content = fs.readFileSync(fullPath, "utf8");

    const frontmatter = this.extractYamlFrontmatter(content);

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

  private static extractYamlFrontmatter(
    content: string,
  ): YamlFrontmatter | undefined {
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

  isEmpty(): boolean {
    return Object.keys(this.skills).length === 0;
  }

  reset(): void {
    this.hasShownSkills = false;
  }

  /**
   * Returns the skills prompt if it hasn't been shown yet.
   * Similar to ContextManager.getContextUpdate()
   */
  getSkillsIntroduction(): string | undefined {
    if (this.isEmpty() || this.hasShownSkills) {
      return undefined;
    }

    this.hasShownSkills = true;

    const skillsList = Object.values(this.skills)
      .map(
        (skill) =>
          `- **${skill.name}** (\`${skill.skillFile}\`): ${skill.description}`,
      )
      .join("\n");

    return `Here are skills you have available to you:

${skillsList}

When a skill is relevant to a task you are trying to do, first use the get_file tool to read the entire skill markdown file.`;
  }
}

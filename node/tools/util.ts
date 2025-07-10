import ignore from "ignore";
import fs from "node:fs";
import {
  resolveFilePath,
  type NvimCwd,
  type RelFilePath,
} from "../utils/files";

export async function readGitignore(cwd: NvimCwd): Promise<ignore.Ignore> {
  const ig = ignore();
  try {
    const gitignorePath = resolveFilePath(cwd, ".gitignore" as RelFilePath);
    const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
    ig.add(gitignoreContent);
  } catch {
    // If .gitignore doesn't exist, just return empty ignore rules
  }
  return ig;
}

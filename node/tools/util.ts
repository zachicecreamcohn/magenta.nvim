import ignore from "ignore";
import path from "node:path";
import fs from "node:fs";

export async function readGitignore(cwd: string): Promise<ignore.Ignore> {
  const ig = ignore();
  try {
    const gitignorePath = path.join(cwd, ".gitignore");
    const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
    ig.add(gitignoreContent);
  } catch {
    // If .gitignore doesn't exist, just return empty ignore rules
  }
  return ig;
}

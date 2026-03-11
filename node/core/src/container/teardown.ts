import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export async function teardownContainer({
  containerName,
  repoPath,
  branch,
  startSha,
  workspacePath,
  tempDir,
  force = false,
  onProgress,
}: {
  containerName: string;
  repoPath: string;
  branch: string;
  startSha: string;
  workspacePath: string;
  tempDir: string;
  force?: boolean;
  onProgress?: (message: string) => void;
}): Promise<void> {
  const progress = onProgress ?? (() => {});

  // Extract patches for commits the agent made (startSha..HEAD)
  progress("Extracting patches from container...");
  const patchDir = path.join(tempDir, "patches");
  await fs.promises.mkdir(patchDir, { recursive: true });

  const { stdout: patchOutput } = await execFile("docker", [
    "exec",
    "-w",
    workspacePath,
    containerName,
    "git",
    "format-patch",
    "--stdout",
    `${startSha}..HEAD`,
  ]).catch(() => ({ stdout: "" }));

  progress("Stopping container...");
  await execFile("docker", ["rm", "-f", containerName]).catch(() => {});

  // Apply patches to the host repo if there are any
  if (patchOutput.length > 0) {
    if (!force) {
      // Check if the branch exists and has diverged
      const hostRef = await execFile("git", [
        "-C",
        repoPath,
        "rev-parse",
        "--verify",
        branch,
      ]).then(
        (r) => r.stdout.trim(),
        () => undefined,
      );

      if (hostRef !== undefined && hostRef !== startSha) {
        throw new Error(
          `Branch "${branch}" has diverged in the host repo. Use force=true to overwrite.`,
        );
      }
    }

    progress("Applying patches to host repo...");

    // Ensure the branch exists in the host repo at startSha
    const hostHasBranch = await execFile("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      branch,
    ]).then(
      () => true,
      () => false,
    );

    if (!hostHasBranch) {
      await execFile("git", ["-C", repoPath, "branch", branch, startSha]);
    } else if (force) {
      await execFile("git", ["-C", repoPath, "branch", "-f", branch, startSha]);
    }

    // Write patches to a temp file and apply with git am
    const patchFile = path.join(tempDir, "agent.patch");
    await fs.promises.writeFile(patchFile, patchOutput);

    // Get current branch so we can restore it after
    const { stdout: currentBranch } = await execFile("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);

    await execFile("git", ["-C", repoPath, "checkout", branch]);
    await execFile("git", ["-C", repoPath, "am", patchFile]);
    await execFile("git", ["-C", repoPath, "checkout", currentBranch.trim()]);
  }

  progress("Cleaning up...");
  await fs.promises.rm(tempDir, { recursive: true, force: true });
}

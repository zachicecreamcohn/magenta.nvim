import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { TeardownResult } from "./types.ts";

const execFile = promisify(execFileCb);

export async function teardownContainer({
  containerName,
  repoPath,
  baseBranch,
  workerBranch,
  startSha,
  workspacePath,
  tempDir,
  onProgress,
}: {
  containerName: string;
  repoPath: string;
  baseBranch: string;
  workerBranch: string;
  startSha: string;
  workspacePath: string;
  tempDir: string;
  onProgress?: (message: string) => void;
}): Promise<TeardownResult> {
  const progress = onProgress ?? (() => {});

  // Count commits the agent made
  progress("Extracting commits from container...");
  const { stdout: commitCountStr } = await execFile("docker", [
    "exec",
    "-w",
    workspacePath,
    containerName,
    "git",
    "rev-list",
    "--count",
    `${startSha}..HEAD`,
  ]).catch(() => ({ stdout: "0" }));

  const commitCount = parseInt(commitCountStr.trim(), 10);

  if (commitCount > 0) {
    // Create a git bundle of the worker branch
    const bundlePath = path.join(workspacePath, "worker.bundle");
    await execFile("docker", [
      "exec",
      "-w",
      workspacePath,
      containerName,
      "git",
      "bundle",
      "create",
      bundlePath,
      workerBranch,
    ]);

    // Copy the bundle out of the container
    const hostBundlePath = path.join(tempDir, "worker.bundle");
    await execFile("docker", [
      "cp",
      `${containerName}:${bundlePath}`,
      hostBundlePath,
    ]);

    // Import the branch into the host repo
    progress("Importing commits to host repo...");
    await execFile("git", [
      "-C",
      repoPath,
      "fetch",
      hostBundlePath,
      `${workerBranch}:${workerBranch}`,
    ]);
  }

  progress("Stopping container...");
  await execFile("docker", ["rm", "-f", containerName]).catch(() => {});

  progress("Cleaning up...");
  await fs.promises.rm(tempDir, { recursive: true, force: true });

  return {
    workerBranch,
    baseBranch,
    commitCount,
  };
}

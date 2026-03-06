import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ContainerConfig, ProvisionResult } from "./types.ts";

const execFile = promisify(execFileCb);

const TEMP_BASE = "/tmp/magenta-dev-containers";

export async function provisionContainer({
  repoPath,
  branch,
  baseBranch = "HEAD",
  containerConfig,
  onProgress,
}: {
  repoPath: string;
  branch: string;
  baseBranch?: string;
  containerConfig: ContainerConfig;
  onProgress?: (message: string) => void;
}): Promise<ProvisionResult> {
  const progress = onProgress ?? (() => {});
  const shortHash = crypto.randomBytes(4).toString("hex");
  const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, "-");
  const containerName = `magenta-${safeBranch}-${shortHash}`;
  const tempDir = path.join(TEMP_BASE, containerName);
  const repoDir = path.join(tempDir, "repo");

  await fs.promises.mkdir(repoDir, { recursive: true });

  // Shallow-clone into a temp dir and checkout the desired branch
  progress("Cloning repository...");
  await execFile("git", ["clone", "--depth=1", "--local", repoPath, repoDir]);

  const { exitCode: branchExists } = await execFile("git", [
    "-C",
    repoDir,
    "rev-parse",
    "--verify",
    branch,
  ]).then(
    () => ({ exitCode: 0 }),
    () => ({ exitCode: 1 }),
  );

  if (branchExists === 0) {
    await execFile("git", ["-C", repoDir, "checkout", branch]);
  } else {
    await execFile("git", [
      "-C",
      repoDir,
      "checkout",
      "-b",
      branch,
      baseBranch,
    ]);
  }

  await execFile("git", ["-C", repoDir, "remote", "remove", "origin"]);

  // Record the starting commit so teardown can extract only new commits
  const { stdout: startSha } = await execFile("git", [
    "-C",
    repoDir,
    "rev-parse",
    "HEAD",
  ]);

  // Build image using the cloned branch as context.
  // Docker layer caching keeps the npm ci layer cached when the lockfile is unchanged.
  progress("Building Docker image...");
  const dockerfilePath = path.join(repoPath, containerConfig.devcontainer);
  const imageName = `magenta-dev-${safeBranch}`;

  await execFile(
    "docker",
    ["build", "-t", imageName, "-f", dockerfilePath, repoDir],
    { timeout: 600_000 },
  );

  progress("Starting container...");
  await execFile("docker", ["run", "-d", "--name", containerName, imageName]);

  return {
    containerName,
    tempDir,
    imageName,
    startSha: startSha.trim(),
  };
}

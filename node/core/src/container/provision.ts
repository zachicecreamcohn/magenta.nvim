import { execFile as execFileCb } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ContainerConfig, ProvisionResult } from "./types.ts";

const execFile = promisify(execFileCb);

const TEMP_BASE = "/tmp/magenta-dev-containers";

export async function provisionContainer({
  repoPath,
  baseBranch = "HEAD",
  containerConfig,
  onProgress,
}: {
  repoPath: string;
  baseBranch?: string;
  containerConfig: ContainerConfig;
  onProgress?: (message: string) => void;
}): Promise<ProvisionResult> {
  const progress = onProgress ?? (() => {});
  const shortHash = crypto.randomBytes(4).toString("hex");
  const workerBranch = `magenta/worker-${shortHash}`;
  const containerName = `magenta-worker-${shortHash}`;
  const tempDir = path.join(TEMP_BASE, containerName);
  const repoDir = path.join(tempDir, "repo");

  await fs.promises.mkdir(repoDir, { recursive: true });

  // Shallow-clone into a temp dir, checking out the desired branch directly
  progress("Cloning repository...");
  const cloneArgs = ["clone", "--depth=1", "--local"];
  if (baseBranch !== "HEAD") {
    cloneArgs.push("--branch", baseBranch);
  }
  cloneArgs.push(repoPath, repoDir);
  await execFile("git", cloneArgs);

  // Create the worker branch from the cloned HEAD
  await execFile("git", ["-C", repoDir, "checkout", "-b", workerBranch]);

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
  const dockerfilePath = path.join(repoPath, containerConfig.dockerfile);
  const imageName = `magenta-dev-${shortHash}`;

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
    workerBranch,
  };
}

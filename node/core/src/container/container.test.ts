import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionContainer } from "./provision.ts";
import { teardownContainer } from "./teardown.ts";
import type { ContainerConfig } from "./types.ts";

const execFile = promisify(execFileCb);

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFile("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("Container Provisioning", () => {
  let sourceRepo: string;
  let result:
    | {
        containerName: string;
        tempDir: string;
        imageName: string;
        startSha: string;
        workerBranch: string;
      }
    | undefined;

  const containerConfig: ContainerConfig = {
    dockerfile: "Dockerfile",
    workspacePath: "/workspace",
    installCommand: "echo install-done",
  };

  beforeAll(async () => {
    sourceRepo = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "magenta-test-repo-"),
    );
    await execFile("git", ["-C", sourceRepo, "init", "-b", "main"]);
    await execFile("git", ["-C", sourceRepo, "config", "user.name", "test"]);
    await execFile("git", [
      "-C",
      sourceRepo,
      "config",
      "user.email",
      "test@test.com",
    ]);

    const dockerfile = [
      "FROM alpine:latest",
      "RUN apk add --no-cache git",
      'RUN git config --global user.name "test" && git config --global user.email "test@test"',
      "WORKDIR /workspace",
      "COPY . .",
      'CMD ["tail", "-f", "/dev/null"]',
    ].join("\n");
    await fs.promises.writeFile(
      path.join(sourceRepo, "Dockerfile"),
      dockerfile,
    );
    await fs.promises.writeFile(
      path.join(sourceRepo, "hello.txt"),
      "hello from source",
    );

    await execFile("git", ["-C", sourceRepo, "add", "."]);
    await execFile("git", ["-C", sourceRepo, "commit", "-m", "initial commit"]);
  }, 30_000);

  afterAll(async () => {
    if (result) {
      await execFile("docker", ["rm", "-f", result.containerName]).catch(
        () => {},
      );
      await fs.promises.rm(result.tempDir, { recursive: true, force: true });
    }
    if (sourceRepo) {
      await fs.promises.rm(sourceRepo, { recursive: true, force: true });
    }
  });

  it("provisions a container with project files baked in", async () => {
    result = await provisionContainer({
      repoPath: sourceRepo,
      containerConfig,
    });

    expect(result.containerName).toMatch(/^magenta-worker-/);
    expect(result.tempDir).toContain("magenta-dev-containers");
    expect(result.startSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.workerBranch).toMatch(/^magenta\/worker-/);

    // Container should be running
    const { stdout: status } = await execFile("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      result.containerName,
    ]);
    expect(status.trim()).toBe("true");

    // Project files should be baked into the image (not bind-mounted)
    const { stdout: content } = await execFile("docker", [
      "exec",
      result.containerName,
      "cat",
      "/workspace/hello.txt",
    ]);
    expect(content.trim()).toBe("hello from source");

    // Branch should match the workerBranch from provision result
    const { stdout: branchOutput } = await execFile("docker", [
      "exec",
      "-w",
      "/workspace",
      result.containerName,
      "git",
      "branch",
      "--show-current",
    ]);
    expect(branchOutput.trim()).toBe(result.workerBranch);
  }, 120_000);

  it("tears down and applies patches back", async () => {
    expect(result).toBeDefined();
    const r = result!;

    // Make a commit inside the container
    await execFile("docker", [
      "exec",
      "-w",
      "/workspace",
      r.containerName,
      "sh",
      "-c",
      'echo "agent change" > agent.txt && git add . && git commit -m "agent commit"',
    ]);

    const containerName = r.containerName;
    const tempDir = r.tempDir;

    const teardownResult = await teardownContainer({
      containerName,
      repoPath: sourceRepo,
      baseBranch: "main",
      workerBranch: r.workerBranch,
      startSha: r.startSha,
      workspacePath: containerConfig.workspacePath,
      tempDir,
    });

    result = undefined;

    expect(teardownResult.workerBranch).toBe(r.workerBranch);
    expect(teardownResult.baseBranch).toBe("main");
    expect(teardownResult.commitCount).toBe(1);

    // Container should be gone
    const inspectResult = await execFile("docker", [
      "inspect",
      containerName,
    ]).then(
      () => "exists",
      () => "gone",
    );
    expect(inspectResult).toBe("gone");

    // Worker branch should exist in source repo with the agent's commit
    const { stdout: logOutput } = await execFile("git", [
      "-C",
      sourceRepo,
      "log",
      "--oneline",
      r.workerBranch,
    ]);
    expect(logOutput).toContain("agent commit");

    // Temp directory should be gone
    expect(fs.existsSync(tempDir)).toBe(false);
  }, 60_000);
});

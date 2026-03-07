import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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
      branch: "test-branch",
      containerConfig,
    });

    expect(result.containerName).toMatch(/^magenta-test-branch-/);
    expect(result.tempDir).toContain("magenta-dev-containers");
    expect(result.startSha).toMatch(/^[0-9a-f]{40}$/);

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

    // Branch should exist
    const { stdout: branchOutput } = await execFile("docker", [
      "exec",
      "-w",
      "/workspace",
      result.containerName,
      "git",
      "branch",
      "--show-current",
    ]);
    expect(branchOutput.trim()).toBe("test-branch");
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

    await teardownContainer({
      containerName,
      repoPath: sourceRepo,
      branch: "test-branch",
      startSha: r.startSha,
      workspacePath: containerConfig.workspacePath,
      tempDir,
    });

    result = undefined;

    // Container should be gone
    const inspectResult = await execFile("docker", [
      "inspect",
      containerName,
    ]).then(
      () => "exists",
      () => "gone",
    );
    expect(inspectResult).toBe("gone");

    // Branch should exist in source repo with the agent's commit
    const { stdout: logOutput } = await execFile("git", [
      "-C",
      sourceRepo,
      "log",
      "--oneline",
      "test-branch",
    ]);
    expect(logOutput).toContain("agent commit");

    // Temp directory should be gone
    expect(fs.existsSync(tempDir)).toBe(false);
  }, 60_000);

  it("fails teardown on diverged branch without force", async () => {
    result = await provisionContainer({
      repoPath: sourceRepo,
      branch: "diverge-test",
      containerConfig,
    });

    // Make a commit in the container
    await execFile("docker", [
      "exec",
      "-w",
      "/workspace",
      result.containerName,
      "sh",
      "-c",
      'echo "clone change" > clone.txt && git add . && git commit -m "clone commit"',
    ]);

    // Make a diverging commit in the source repo on the same branch
    await execFile("git", ["-C", sourceRepo, "checkout", "-b", "diverge-test"]);
    await fs.promises.writeFile(
      path.join(sourceRepo, "source-change.txt"),
      "source change",
    );
    await execFile("git", ["-C", sourceRepo, "add", "."]);
    await execFile("git", ["-C", sourceRepo, "commit", "-m", "source diverge"]);
    await execFile("git", ["-C", sourceRepo, "checkout", "main"]);

    await expect(
      teardownContainer({
        containerName: result.containerName,
        repoPath: sourceRepo,
        branch: "diverge-test",
        startSha: result.startSha,
        workspacePath: containerConfig.workspacePath,
        tempDir: result.tempDir,
      }),
    ).rejects.toThrow("diverged");

    // Container was removed but temp dir should remain since teardown threw
    expect(fs.existsSync(result.tempDir)).toBe(true);

    await fs.promises.rm(result.tempDir, { recursive: true, force: true });
    result = undefined;
  }, 120_000);

  it("succeeds teardown on diverged branch with force", async () => {
    result = await provisionContainer({
      repoPath: sourceRepo,
      branch: "force-test",
      containerConfig,
    });

    // Make a commit in the container
    await execFile("docker", [
      "exec",
      "-w",
      "/workspace",
      result.containerName,
      "sh",
      "-c",
      'echo "clone change" > clone.txt && git add . && git commit -m "clone commit"',
    ]);

    // Make a diverging commit in the source repo
    await execFile("git", ["-C", sourceRepo, "checkout", "-b", "force-test"]);
    await fs.promises.writeFile(
      path.join(sourceRepo, "source-force.txt"),
      "source",
    );
    await execFile("git", ["-C", sourceRepo, "add", "."]);
    await execFile("git", ["-C", sourceRepo, "commit", "-m", "source diverge"]);
    await execFile("git", ["-C", sourceRepo, "checkout", "main"]);

    const containerName = result.containerName;
    const tempDir = result.tempDir;

    await teardownContainer({
      containerName,
      repoPath: sourceRepo,
      branch: "force-test",
      startSha: result.startSha,
      workspacePath: containerConfig.workspacePath,
      tempDir,
      force: true,
    });

    result = undefined;

    const { stdout: logOutput } = await execFile("git", [
      "-C",
      sourceRepo,
      "log",
      "--oneline",
      "force-test",
    ]);
    expect(logOutput).toContain("clone commit");

    expect(fs.existsSync(tempDir)).toBe(false);
  }, 120_000);
});

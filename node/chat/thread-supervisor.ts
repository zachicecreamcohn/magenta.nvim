import type { Shell } from "../capabilities/shell.ts";
import { teardownContainer } from "@magenta/core";
import type { ContainerConfig, ProvisionResult } from "@magenta/core";
import type { NvimCwd } from "../utils/files.ts";

export type SupervisorAction =
  | { type: "send-message"; text: string }
  | { type: "accept" }
  | { type: "reject"; message: string }
  | { type: "none" };

export interface ThreadSupervisor {
  onEndTurnWithoutYield(): SupervisorAction;
  onYield(result: string): Promise<SupervisorAction>;
  onAbort(): SupervisorAction;
}

export class DockerSupervisor implements ThreadSupervisor {
  private restartCount = 0;
  private readonly maxRestarts: number;

  constructor(
    private shell: Shell,
    private provisionResult: ProvisionResult,
    private containerConfig: ContainerConfig,
    private branch: string,
    private repoPath: NvimCwd,
    opts?: { maxRestarts?: number },
  ) {
    this.maxRestarts = opts?.maxRestarts ?? 5;
  }

  onEndTurnWithoutYield(): SupervisorAction {
    if (this.restartCount >= this.maxRestarts) {
      return { type: "none" };
    }
    this.restartCount++;
    return {
      type: "send-message",
      text: `You stopped without yielding. You must complete the task, commit all changes with git, and call yield_to_parent when done. (auto-restart ${this.restartCount}/${this.maxRestarts})`,
    };
  }

  async onYield(_result: string): Promise<SupervisorAction> {
    const gitStatus = await this.shell.execute("git status --porcelain", {
      toolRequestId: "supervisor-git-status",
    });
    const stdout = gitStatus.output
      .filter((l) => l.stream === "stdout")
      .map((l) => l.text)
      .join("\n");
    const isDirty = stdout.trim().length > 0;

    if (isDirty) {
      return {
        type: "reject",
        message: `Your git working tree is dirty. Please commit or clean up all changes before yielding.\n\ngit status:\n${stdout}`,
      };
    }

    // Clean yield — trigger teardown
    await teardownContainer({
      containerName: this.provisionResult.containerName,
      tempDir: this.provisionResult.tempDir,
      repoPath: this.repoPath,
      branch: this.branch,
      volumeOverlays: this.containerConfig.volumeOverlays,
    });

    return { type: "accept" };
  }

  onAbort(): SupervisorAction {
    return { type: "none" };
  }
}

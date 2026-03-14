import type {
  ContainerConfig,
  ProvisionResult,
  SupervisorAction,
  TeardownResult,
  ThreadSupervisor,
} from "@magenta/core";
import { teardownContainer } from "@magenta/core";
import type { Shell } from "../capabilities/shell.ts";
import type { NvimCwd } from "../utils/files.ts";

export class DockerSupervisor implements ThreadSupervisor {
  private restartCount = 0;
  private readonly maxRestarts: number;

  public teardownResult: TeardownResult | undefined;

  constructor(
    private shell: Shell,
    private provisionResult: ProvisionResult,
    private containerConfig: ContainerConfig,
    private baseBranch: string,
    private repoPath: NvimCwd,
    opts?: { maxRestarts?: number; onProgress?: (message: string) => void },
  ) {
    this.maxRestarts = opts?.maxRestarts ?? 5;
    this.onProgress = opts?.onProgress;
  }

  private onProgress: ((message: string) => void) | undefined;

  onEndTurnWithoutYield(stopReason: string): SupervisorAction {
    if (stopReason === "aborted" || this.restartCount >= this.maxRestarts) {
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

    this.teardownResult = await teardownContainer({
      containerName: this.provisionResult.containerName,
      tempDir: this.provisionResult.tempDir,
      startSha: this.provisionResult.startSha,
      workspacePath: this.containerConfig.workspacePath,
      repoPath: this.repoPath,
      baseBranch: this.baseBranch,
      workerBranch: this.provisionResult.workerBranch,
      ...(this.onProgress ? { onProgress: this.onProgress } : {}),
    });

    const { workerBranch, baseBranch, commitCount } = this.teardownResult;
    return {
      type: "accept",
      resultPrefix: `[Worker branch: ${workerBranch} (forked from ${baseBranch}), ${commitCount} commit(s) synced to host]`,
    };
  }

  onAbort(): SupervisorAction {
    return { type: "none" };
  }
}

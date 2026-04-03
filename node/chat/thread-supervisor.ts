import type {
  SupervisorAction,
  TeardownResult,
  ThreadSupervisor,
} from "@magenta/core";
import { teardownContainer } from "@magenta/core";

export class DockerSupervisor implements ThreadSupervisor {
  private restartCount = 0;
  private readonly maxRestarts: number;

  public teardownResult: TeardownResult | undefined;

  constructor(
    private containerName: string,
    private workspacePath: string,
    private hostDir: string,
    private opts?: {
      maxRestarts?: number;
      onProgress?: (message: string) => void;
    },
  ) {
    this.maxRestarts = opts?.maxRestarts ?? 5;
  }

  onEndTurnWithoutYield(stopReason: string): SupervisorAction {
    if (stopReason === "aborted" || this.restartCount >= this.maxRestarts) {
      return { type: "none" };
    }
    this.restartCount++;
    return {
      type: "send-message",
      text: `You stopped without yielding. You must complete your task and call yield_to_parent when done. (auto-restart ${this.restartCount}/${this.maxRestarts})`,
    };
  }

  async onYield(_result: string): Promise<SupervisorAction> {
    this.teardownResult = await teardownContainer({
      containerName: this.containerName,
      workspacePath: this.workspacePath,
      hostDir: this.hostDir,
      ...(this.opts?.onProgress ? { onProgress: this.opts.onProgress } : {}),
    });

    return {
      type: "accept",
      resultPrefix: `[Changes synced to ${this.hostDir}]`,
    };
  }

  onAbort(): SupervisorAction {
    return { type: "none" };
  }
}

import type { SubagentConfig, ThreadId, ThreadType } from "../chat-types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { Result } from "../utils/result.ts";

export type DockerSpawnConfig = {
  containerName: string;
  imageName: string;
  workspacePath: string;
  hostDir: string;
  supervised: boolean;
};

export interface ThreadManager {
  spawnThread(opts: {
    parentThreadId: ThreadId;
    prompt: string;
    threadType: ThreadType;
    subagentConfig?: SubagentConfig;
    contextFiles?: UnresolvedFilePath[];
    dockerSpawnConfig?: DockerSpawnConfig;
    cwd?: string;
  }): Promise<ThreadId>;

  onThreadYielded(threadId: ThreadId, callback: () => void): void;

  getThreadResult(
    threadId: ThreadId,
  ): { status: "done"; result: Result<string> } | { status: "pending" };
}

import type { ThreadId, ThreadType } from "../chat-types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { Result } from "../utils/result.ts";

export type DockerSpawnConfig = {
  baseBranch: string;
  workerBranch: string;
  containerName: string;
  tempDir: string;
  imageName: string;
  startSha: string;
  workspacePath: string;
  supervised: boolean;
};

export interface ThreadManager {
  spawnThread(opts: {
    parentThreadId: ThreadId;
    prompt: string;
    threadType: ThreadType;
    contextFiles?: UnresolvedFilePath[];
    dockerSpawnConfig?: DockerSpawnConfig;
  }): Promise<ThreadId>;

  waitForThread(threadId: ThreadId): Promise<Result<string>>;

  yieldResult(threadId: ThreadId, result: Result<string>): void;
}

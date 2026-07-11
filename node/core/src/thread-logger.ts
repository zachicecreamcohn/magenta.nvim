import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import type { Logger } from "./logger.ts";
import type { ProviderMessage } from "./providers/provider-types.ts";
import { threadConversationLogPath } from "./utils/files.ts";

export type ForkProvenance = {
  fromThreadId: ThreadId;
  nativeMessageIdx: number;
};

export type ThreadLogEntry =
  | {
      type: "thread_start";
      threadId: ThreadId;
      timestamp: string;
      threadType: ThreadType;
    }
  | {
      type: "fork";
      timestamp: string;
      fromThreadId: ThreadId;
      nativeMessageIdx: number;
    }
  | {
      type: "message";
      timestamp: string;
      message: ProviderMessage;
    }
  | {
      type: "compaction";
      timestamp: string;
      summary: string;
      chunkCount: number;
    }
  | {
      type: "compaction";
      timestamp: string;
      chunkCount: number;
    }
  | { type: "restart"; timestamp: string };

/**
 * Best-effort, append-only archive of a thread's full conversation.
 *
 * Writes are serialized through an internal promise chain and never awaited by
 * thread execution or UI. All filesystem errors are caught and routed to the
 * diagnostic `Logger`, never rethrown. This is magenta-internal plumbing (like
 * diagnostic logging), so it uses node `fs` directly rather than the `FileIO`
 * abstraction.
 */
export class ThreadLogger {
  private filePath: string;
  private persistedCount = 0;
  private queue: Promise<void>;
  private ready: Promise<void>;

  constructor(
    threadId: ThreadId,
    threadType: ThreadType,
    private logger: Logger,
    forkedFrom?: ForkProvenance,
  ) {
    this.filePath = threadConversationLogPath(threadId);
    const dir = path.dirname(this.filePath);
    this.ready = fs.mkdir(dir, { recursive: true }).then(() => undefined);
    this.queue = this.ready.catch((err) => {
      this.logger.error(`ThreadLogger: failed to create directory ${dir}`, err);
    });

    this.append({
      type: "thread_start",
      threadId,
      timestamp: new Date().toISOString(),
      threadType,
    });

    if (forkedFrom) {
      this.append({
        type: "fork",
        timestamp: new Date().toISOString(),
        fromThreadId: forkedFrom.fromThreadId,
        nativeMessageIdx: forkedFrom.nativeMessageIdx,
      });
    }
  }

  /**
   * Append all messages at index >= persistedCount, up to `stableCount`.
   * Idempotent by cursor, so calling repeatedly with a growing array never
   * double-writes. Fire-and-forget: returns immediately.
   */
  flushMessages(
    messages: ReadonlyArray<ProviderMessage>,
    stableCount: number = messages.length,
  ): void {
    const timestamp = new Date().toISOString();
    for (let i = this.persistedCount; i < stableCount; i++) {
      this.append({ type: "message", timestamp, message: messages[i] });
    }
    if (stableCount > this.persistedCount) {
      this.persistedCount = stableCount;
    }
  }

  recordCompaction(opts: { summary?: string; chunkCount: number }): void {
    const timestamp = new Date().toISOString();
    this.append(
      opts.summary !== undefined
        ? {
            type: "compaction",
            timestamp,
            summary: opts.summary,
            chunkCount: opts.chunkCount,
          }
        : {
            type: "compaction",
            timestamp,
            chunkCount: opts.chunkCount,
          },
    );
  }

  recordRestart(): void {
    this.append({
      type: "restart",
      timestamp: new Date().toISOString(),
    });
  }

  resetCursor(): void {
    this.persistedCount = 0;
  }

  /** Resolves once all enqueued writes have flushed. For tests. */
  async flushed(): Promise<void> {
    await this.queue;
  }

  private append(entry: ThreadLogEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    this.queue = this.queue.then(async () => {
      try {
        await fs.appendFile(this.filePath, line);
      } catch (err) {
        this.logger.error(
          `ThreadLogger: failed to append to ${this.filePath}`,
          err,
        );
      }
    });
  }
}

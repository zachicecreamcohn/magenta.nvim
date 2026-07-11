import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadId } from "./chat-types.ts";
import type { Logger } from "./logger.ts";
import type { ProviderMessage } from "./providers/provider-types.ts";
import { type ThreadLogEntry, ThreadLogger } from "./thread-logger.ts";
import { threadConversationLogPath } from "./utils/files.ts";

function makeLogger(): { logger: Logger; errors: unknown[][] } {
  const errors: unknown[][] = [];
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => errors.push(args),
    debug: () => {},
  };
  return { logger, errors };
}

function msg(text: string): ProviderMessage {
  return {
    role: "user",
    content: [{ type: "text", text, nativeMessageIdx: 0 as never }],
  };
}

async function readEntries(threadId: ThreadId): Promise<ThreadLogEntry[]> {
  const contents = await fs.readFile(
    threadConversationLogPath(threadId),
    "utf8",
  );
  return contents
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ThreadLogEntry);
}

describe("ThreadLogger", () => {
  const threadIds: ThreadId[] = [];

  function freshThreadId(): ThreadId {
    const id = `test-${Math.random().toString(36).slice(2)}` as ThreadId;
    threadIds.push(id);
    return id;
  }

  afterEach(async () => {
    for (const id of threadIds) {
      await fs.rm(path.dirname(threadConversationLogPath(id)), {
        recursive: true,
        force: true,
      });
    }
    threadIds.length = 0;
  });

  it("appends only the new tail of a growing message array", async () => {
    const threadId = freshThreadId();
    const { logger } = makeLogger();
    const tl = new ThreadLogger(threadId, "root", logger);

    tl.flushMessages([msg("a")]);
    tl.flushMessages([msg("a"), msg("b"), msg("c")]);
    await tl.flushed();

    const entries = await readEntries(threadId);
    expect(entries[0].type).toBe("thread_start");
    const messages = entries.filter((e) => e.type === "message");
    expect(messages).toHaveLength(3);
  });

  it("withholds the streaming last message on update-style flush", async () => {
    const threadId = freshThreadId();
    const { logger } = makeLogger();
    const tl = new ThreadLogger(threadId, "root", logger);

    const messages = [msg("a"), msg("b"), msg("c")];
    tl.flushMessages(messages, messages.length - 1);
    await tl.flushed();
    expect(
      (await readEntries(threadId)).filter((e) => e.type === "message"),
    ).toHaveLength(2);

    tl.flushMessages(messages, messages.length);
    await tl.flushed();
    expect(
      (await readEntries(threadId)).filter((e) => e.type === "message"),
    ).toHaveLength(3);
  });

  it("records compaction marker and re-appends after cursor reset", async () => {
    const threadId = freshThreadId();
    const { logger } = makeLogger();
    const tl = new ThreadLogger(threadId, "root", logger);

    tl.flushMessages([msg("a"), msg("b"), msg("c")]);
    tl.recordCompaction({ summary: "sum", chunkCount: 2 });
    tl.resetCursor();
    tl.flushMessages([msg("x"), msg("y")]);
    await tl.flushed();

    const entries = await readEntries(threadId);
    const types = entries.map((e) => e.type);
    expect(types).toEqual([
      "thread_start",
      "message",
      "message",
      "message",
      "compaction",
      "message",
      "message",
    ]);
  });

  it("writes fork provenance before inherited history", async () => {
    const threadId = freshThreadId();
    const parentId = "parent-thread" as ThreadId;
    const { logger } = makeLogger();
    const tl = new ThreadLogger(threadId, "root", logger, {
      fromThreadId: parentId,
      nativeMessageIdx: 5,
    });

    tl.flushMessages([msg("a")]);
    await tl.flushed();

    const entries = await readEntries(threadId);
    expect(entries[0].type).toBe("thread_start");
    expect(entries[1]).toMatchObject({
      type: "fork",
      fromThreadId: parentId,
      nativeMessageIdx: 5,
    });
    expect(entries[2].type).toBe("message");
  });

  it("does not throw when the fs write fails", async () => {
    const threadId = freshThreadId();
    const { logger, errors } = makeLogger();
    const tl = new ThreadLogger(threadId, "root", logger);
    await tl.flushed();

    // Make the target path unwritable by replacing the dir with a file.
    const dir = path.dirname(threadConversationLogPath(threadId));
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, "not a dir");

    expect(() => tl.flushMessages([msg("a")])).not.toThrow();
    await tl.flushed();
    expect(errors.length).toBeGreaterThan(0);

    await fs.rm(dir, { force: true });
  });
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadId } from "./chat-types.ts";
import type { Logger } from "./logger.ts";
import type { ProviderMessage } from "./providers/provider-types.ts";
import { ThreadLogger } from "./thread-logger.ts";
import { threadConversationLogPath } from "./utils/files.ts";

const TEST_BASE_DIR = path.join(os.tmpdir(), "magenta-test-thread-logger");

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

describe("ThreadLogger", () => {
  const threadIds: ThreadId[] = [];

  function freshThreadId(): ThreadId {
    const id = `test-${Math.random().toString(36).slice(2)}` as ThreadId;
    threadIds.push(id);
    return id;
  }

  afterEach(async () => {
    for (const id of threadIds) {
      await fs.rm(path.dirname(threadConversationLogPath(id, TEST_BASE_DIR)), {
        recursive: true,
        force: true,
      });
    }
    threadIds.length = 0;
  });

  it("produces the {baseDir}/threads/{threadId}/conversation.jsonl path", () => {
    const threadId = "abc123" as ThreadId;
    expect(threadConversationLogPath(threadId)).toBe(
      "/tmp/magenta/threads/abc123/conversation.jsonl",
    );
    expect(threadConversationLogPath(threadId, "/base")).toBe(
      "/base/threads/abc123/conversation.jsonl",
    );
  });

  it("does not throw and routes fs errors to the logger", async () => {
    const threadId = freshThreadId();
    const { logger, errors } = makeLogger();
    const tl = new ThreadLogger(threadId, "root", logger, {
      baseDir: TEST_BASE_DIR,
    });
    await tl.flushed();

    // Replace the thread dir with a file so subsequent appends fail.
    const dir = path.dirname(
      threadConversationLogPath(threadId, TEST_BASE_DIR),
    );
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, "not a dir");

    expect(() => tl.onTurnEnded([msg("a")])).not.toThrow();
    await tl.flushed();
    expect(errors.length).toBeGreaterThan(0);

    await fs.rm(dir, { force: true });
  });
});

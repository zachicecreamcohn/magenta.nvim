import * as fs from "node:fs/promises";
import type { ThreadId } from "@magenta/core";
import { threadConversationLogPath, threadMetaPath } from "@magenta/core";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

async function seedArchivedThread(id: ThreadId, title?: string): Promise<void> {
  const metaPath = threadMetaPath(id);
  await fs.mkdir(metaPath.replace(/\/meta\.json$/, ""), { recursive: true });
  await fs.writeFile(
    metaPath,
    JSON.stringify(
      title === undefined
        ? { threadType: "root" }
        : { title, threadType: "root" },
    ),
  );
  await fs.writeFile(threadConversationLogPath(id), "");
}

describe("node/chat/archive-view.test.ts", () => {
  it("lists archived threads newest-first and hydrates titles", async () => {
    await withDriver({}, async (driver) => {
      const chat = driver.magenta.chat;

      const older = uuidv7() as ThreadId;
      await new Promise((r) => setTimeout(r, 5));
      const newer = uuidv7() as ThreadId;

      await seedArchivedThread(older, "Older thread");
      await seedArchivedThread(newer, "Newer thread");

      chat.update({ type: "chat-msg", msg: { type: "archive-open" } });

      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          const { threadIds, titles } = chat.state;
          if (!threadIds.includes(older) || !threadIds.includes(newer)) {
            throw new Error("ids not listed yet");
          }
          const olderTitle = titles[older];
          const newerTitle = titles[newer];
          if (
            olderTitle?.status !== "titled" ||
            olderTitle.title !== "Older thread" ||
            newerTitle?.status !== "titled" ||
            newerTitle.title !== "Newer thread"
          ) {
            throw new Error("titles not hydrated yet");
          }
        },
        { timeout: 3000 },
      );

      if (chat.state.state !== "archive") throw new Error("unreachable");
      // Newest id sorts after older, so it appears earlier in the list.
      expect(chat.state.threadIds.indexOf(newer)).toBeLessThan(
        chat.state.threadIds.indexOf(older),
      );

      // renderArchive should not throw for the hydrated state.
      expect(chat.renderArchive()).toBeTruthy();
    });
  });

  it("dd deletes a thread from the archive and disk", async () => {
    await withDriver({}, async (driver) => {
      const chat = driver.magenta.chat;
      const id = uuidv7() as ThreadId;
      await seedArchivedThread(id, "To delete");

      chat.update({ type: "chat-msg", msg: { type: "archive-open" } });
      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          if (!chat.state.threadIds.includes(id)) throw new Error("not listed");
        },
        { timeout: 3000 },
      );

      chat.update({
        type: "chat-msg",
        msg: { type: "archive-delete-thread", id },
      });

      if (chat.state.state !== "archive") throw new Error("unreachable");
      expect(chat.state.threadIds).not.toContain(id);

      await pollUntil(
        async () => {
          const exists = await fs
            .stat(threadConversationLogPath(id))
            .then(() => true)
            .catch(() => false);
          if (exists) throw new Error("still on disk");
        },
        { timeout: 3000 },
      );
    });
  });

  it("hydrates untitled threads as untitled", async () => {
    await withDriver({}, async (driver) => {
      const chat = driver.magenta.chat;
      const id = uuidv7() as ThreadId;
      await seedArchivedThread(id);

      chat.update({ type: "chat-msg", msg: { type: "archive-open" } });
      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          if (chat.state.titles[id] === undefined) {
            throw new Error("not hydrated yet");
          }
        },
        { timeout: 3000 },
      );

      if (chat.state.state !== "archive") throw new Error("unreachable");
      expect(chat.state.titles[id]).toEqual({ status: "untitled" });
    });
  });

  it("lazily hydrates a page at a time and load-more reveals the next page", async () => {
    await withDriver({}, async (driver) => {
      const chat = driver.magenta.chat;

      const ids: ThreadId[] = [];
      for (let i = 0; i < 55; i++) {
        const id = uuidv7() as ThreadId;
        ids.push(id);
        await seedArchivedThread(id, `Thread ${i}`);
      }
      // Newest-first order.
      const sorted = [...ids].sort().reverse();

      chat.update({ type: "chat-msg", msg: { type: "archive-open" } });

      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          for (const id of ids) {
            if (!chat.state.threadIds.includes(id)) {
              throw new Error("ids not listed yet");
            }
          }
          // First 50 should hydrate.
          for (const id of sorted.slice(0, 50)) {
            if (chat.state.titles[id] === undefined) {
              throw new Error("first page not hydrated yet");
            }
          }
        },
        { timeout: 5000 },
      );

      if (chat.state.state !== "archive") throw new Error("unreachable");
      // Rows beyond the first page must NOT be hydrated yet.
      for (const id of sorted.slice(50)) {
        expect(chat.state.titles[id]).toBeUndefined();
      }

      chat.update({ type: "chat-msg", msg: { type: "archive-load-more" } });

      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          for (const id of sorted.slice(50)) {
            if (chat.state.titles[id] === undefined) {
              throw new Error("second page not hydrated yet");
            }
          }
        },
        { timeout: 10000 },
      );
    });
  }, 30000);

  it("navigate-back returns to the thread overview", async () => {
    await withDriver({}, async (driver) => {
      const chat = driver.magenta.chat;
      chat.update({ type: "chat-msg", msg: { type: "archive-open" } });
      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
        },
        { timeout: 3000 },
      );

      chat.update({
        type: "chat-msg",
        msg: { type: "archive-navigate-back" },
      });
      expect(chat.state.state).toBe("thread-overview");
    });
  });
});

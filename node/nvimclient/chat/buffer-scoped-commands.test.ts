import type { ThreadId } from "@magenta/server";
import { expect, it } from "vitest";
import type { Line } from "../nvim/buffer.ts";
import type { Position0Indexed, Row0Indexed } from "../nvim/window.ts";
import type { NvimDriver } from "../test/driver.ts";
import { leftThread } from "../test/left-thread.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

/** Returns [first thread, second thread]; the second is shown. */
async function twoThreads(driver: NvimDriver): Promise<[ThreadId, ThreadId]> {
  await driver.showSidebar();
  const first = leftThread(driver.magenta.chat).id;
  await driver.magenta.command("new-thread");
  await driver.awaitThreadCount(2);
  const second = driver.getThreadIds().find((id) => id !== first)!;
  await pollUntil(() => driver.assertVisibleInputThread(second));
  return [first, second];
}

it("send submits to the invoking input buffer's thread", async () => {
  await withDriver({}, async (driver) => {
    const [a, b] = await twoThreads(driver);
    await pollUntil(() => {
      if (driver.magenta.chat.lastCursorThreadId !== b) throw new Error("wait");
    });

    const { inputBuffer } =
      await driver.magenta.bufferManager.registerThread(a);
    await inputBuffer.setLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: ["for thread a"] as Line[],
    });
    await driver.magenta.command("send", inputBuffer.id);
    await driver.mockAnthropic.awaitPendingStreamWithText("for thread a");

    const texts = (id: ThreadId) =>
      JSON.stringify(
        driver.magenta.chat.getThread(id).thread.getProviderMessages(),
      );
    expect(texts(a)).toContain("for thread a");
    expect(texts(b)).not.toContain("for thread a");
  });
});

it("abort from a display buffer aborts that buffer's thread only", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const a = leftThread(driver.magenta.chat).id;
    await driver.inputMagentaText("hello a");
    await driver.send();
    const stream = await driver.mockAnthropic.awaitPendingStream();

    await driver.magenta.command("new-thread");
    await driver.awaitThreadCount(2);

    const { displayBuffer } =
      await driver.magenta.bufferManager.registerThread(a);
    await driver.magenta.command("abort", displayBuffer.id);
    await pollUntil(() => {
      if (!stream.aborted) throw new Error("not aborted yet");
    });
  });
});

it("paste-selection with the sidebar hidden goes to the thread last entered", async () => {
  await withDriver({}, async (driver) => {
    const [a, b] = await twoThreads(driver);

    // Enter a's input buffer, then leave magenta and switch the sidebar to b
    // without entering it.
    await driver.magenta.selectThreadEffect(a);
    const { inputWindow } = driver.getVisibleState();
    await driver.nvim.call("nvim_set_current_win", [inputWindow.id]);
    await pollUntil(() => {
      if (driver.magenta.chat.lastCursorThreadId !== a) throw new Error("wait");
    });
    await driver.editFile("poem.txt");
    await driver.magenta.selectThreadEffect(b);
    expect(driver.magenta.chat.lastCursorThreadId).toBe(a);
    await driver.magenta.command("toggle");

    await driver.selectRange(
      { row: 0, col: 0 } as Position0Indexed,
      { row: 0, col: 4 } as Position0Indexed,
    );
    await driver.pasteSelection();

    await pollUntil(() => driver.assertVisibleInputThread(a));
    await driver.assertInputBufferContains("poem.txt");
  });
});
it("send from a display buffer does nothing", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const a = leftThread(driver.magenta.chat).id;
    await driver.inputMagentaText("should not send");
    const { displayBuffer } =
      await driver.magenta.bufferManager.registerThread(a);
    await driver.magenta.command("send", displayBuffer.id);
    expect(
      driver.magenta.chat.getThread(a).thread.getProviderMessages(),
    ).toEqual([]);
  });
});
it("external target forgets a deleted thread and never falls back to a subagent", async () => {
  await withDriver({}, async (driver) => {
    const [a, b] = await twoThreads(driver);
    const chat = driver.magenta.chat;
    await pollUntil(() => {
      if (chat.lastCursorThreadId !== b) throw new Error("wait");
    });
    chat.recordCursorThread(a);
    expect(chat.lastCursorThreadId).toBe(a);
    const sub = await chat.session.spawnThread({
      parentThreadId: b,
      prompt: "child work",
      threadType: "subagent",
    });
    await pollUntil(() => {
      if (!chat.threadWrappers[sub as ThreadId]) throw new Error("wait");
    });
    chat.session.deleteThread(a);
    await pollUntil(() => {
      if (chat.lastCursorThreadId !== undefined) throw new Error("wait");
    });
    expect(chat.externalTarget(false)).toBe(b);
  });
});

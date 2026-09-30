// biome-ignore-all lint/complexity/useLiteralKeys: White-box test: reads the view adapter's viewed timestamps.
import {
  ABORTED,
  type ContentBlockIdx,
  type DisplayBufferText,
  type MessageIdx,
  type ThreadId,
} from "@magenta/server";
import { expect, it } from "vitest";
import type { NvimDriver as Driver } from "../test/driver.ts";
import { withDriver } from "../test/preamble.ts";

async function setupReflection(
  driver: Driver,
): Promise<{ source: ThreadId; child: ThreadId }> {
  await driver.showSidebar();
  await driver.inputMagentaText("Why?");
  await driver.send();
  const request = await driver.mockAnthropic.awaitPendingStream();
  request.respond({
    stopReason: "end_turn",
    text: "Because.",
    toolRequests: [],
  });
  await driver.assertDisplayBufferContains("Because.");
  const source = driver.magenta.chat.leftThreadId!;
  const created =
    await driver.magenta.serverInternals.internals.session.reflectThread(
      source,
      {
        messageIdx: 1 as MessageIdx,
        contentIdx: 0 as ContentBlockIdx,
        reflectionText: "Because." as DisplayBufferText,
      },
    );
  if (created === ABORTED) throw new Error("aborted");
  const child = created;
  driver.magenta.dispatch({
    type: "chat-msg",
    msg: { type: "show-reflection", parent: source, child },
  });
  return { source, child };
}
it("deleting the shown reflection collapses to the left thread", async () => {
  await withDriver({}, async (driver) => {
    const { source, child } = await setupReflection(driver);
    const chat = driver.magenta.chat;
    expect(chat.rightThreadId).toBe(child);
    await chat.deleteThread(child);
    expect(chat.state).toEqual({
      state: "thread-selected",
      left: source,
      right: undefined,
    });
    expect(chat.leftThreadId).toBe(source);
  });
});
it("deleting the left thread returns to the overview", async () => {
  await withDriver({}, async (driver) => {
    const { source } = await setupReflection(driver);
    const chat = driver.magenta.chat;
    await chat.deleteThread(source);
    expect(chat.state.state).toBe("thread-overview");
    expect(chat.leftThreadId).toBeUndefined();
  });
});
it("- closes a reflection beside a root, marks it viewed, then falls through to navigate-up", async () => {
  await withDriver({}, async (driver) => {
    const { source, child } = await setupReflection(driver);
    const chat = driver.magenta.chat;
    const before = Date.now();
    driver.magenta.dispatch({
      type: "chat-msg",
      msg: { type: "reflect-navigate-up" },
    });
    expect(chat.state).toEqual({
      state: "thread-selected",
      left: source,
      right: undefined,
    });
    expect(chat["lastViewedTimes"].get(child)).toBeGreaterThanOrEqual(before);
    driver.magenta.dispatch({
      type: "chat-msg",
      msg: { type: "reflect-navigate-up" },
    });
    expect(chat.state.state).toBe("thread-overview");
  });
});

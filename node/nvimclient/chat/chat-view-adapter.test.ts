// biome-ignore-all lint/complexity/useLiteralKeys: White-box test: the view adapter is rebuilt over an existing session.

import type { ThreadId, ToolName, ToolRequestId } from "@magenta/server";
import { ABORTED } from "@magenta/server";
import { expect, it } from "vitest";
import {
  leftThread,
  registerServerSession,
  serverThread,
} from "../test/left-thread.ts";
import { withDriver } from "../test/preamble.ts";
import { Chat } from "./chat.ts";

it("rebuilding the view adapter over an existing session makes no new thread or title request", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Tell me about the solar system");
    await driver.send();

    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "tool_use",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "thread_title" as ToolName,
          input: { title: "Solar system" },
        },
      },
    });
    const request = await driver.mockAnthropic.awaitPendingStream();
    request.streamText("The sun is large.");
    request.finishResponse("end_turn");
    await driver.assertDisplayBufferContains("The sun is large.");

    const chat = driver.magenta.chat;
    if (chat.state.state !== "thread-selected")
      throw new Error("expected a selected thread");
    const threadId = chat.state.left;
    const liveThread = serverThread(leftThread(chat));
    const titleRequests = driver.mockAnthropic.forceToolUseRequests.length;

    const rebuilt = new Chat(chat.context, {
      sessionId: chat.sessionId,
      host: chat.host,
      server: chat.server,
      scriptRunner: chat.scriptRunner,
    });
    registerServerSession(
      rebuilt,
      driver.magenta.serverInternals.internals.session,
    );

    // The rebuilt view sees the same registry, wrapping the same server Thread.
    expect(Object.keys(rebuilt.threadWrappers)).toEqual([threadId]);
    const wrapper = rebuilt.threadWrappers[threadId];
    expect(wrapper?.state).toBe("initialized");
    if (wrapper?.state !== "initialized") throw new Error("not initialized");
    expect(serverThread(wrapper.thread)).toBe(liveThread);
    expect(rebuilt.getThreadDisplayName(threadId)).toBe("Solar system");

    // No second Thread was constructed, and no second title was requested.
    expect(chat.session.listThreads().length).toBe(1);
    expect(driver.mockAnthropic.forceToolUseRequests.length).toBe(
      titleRequests,
    );
  });
});

it("a turn completes with no view listener attached to the session", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const chat = driver.magenta.chat;
    const thread = serverThread(leftThread(chat));

    // Detach every observer: execution must not depend on one.
    driver.magenta.serverInternals.internals.session.removeAllListeners();

    const submitted = thread.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello with no view",
        },
      ],
    });
    const request = await driver.mockAnthropic.awaitPendingStream();
    request.streamText("response with no view");
    request.finishResponse("end_turn");

    const result = await submitted;
    expect(result.type).toBe("completed");
    expect(chat.session.getThread(thread.id as ThreadId)?.state).toBe("ready");
  });
});

it("renders an initialized record whose view has not been built as initializing", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const chat = driver.magenta.chat;
    const threadId = leftThread(chat).id;
    // Drop the view-local wrapper while the session record stays initialized:
    // the same window a change event that has not been observed yet leaves.
    chat["threadViews"].get(threadId)?.dispose();
    chat["threadViews"].delete(threadId);
    expect(chat.threadWrappers[threadId]?.state).toBe("view-pending");
    expect(chat.getThreadSummary(threadId).status.type).toBe("pending");
  });
});

it("a thread that fails to construct takes the view out of thread-selected", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const chat = driver.magenta.chat;
    expect(chat.state.state).toBe("thread-selected");
    chat.host.prepareThread = () => ({
      promise: Promise.reject(new Error("preparation exploded")),
      abort: () => {},
    });
    await expect(
      driver.magenta.serverInternals.internals.session.createRootThread(),
    ).rejects.toThrow("preparation exploded");
    expect(chat.state.state).toBe("thread-overview");
    const failedId = chat.session
      .listThreads()
      .find((record) => record.state === "error")?.id;
    if (!failedId) throw new Error("expected an error record");
    expect(chat.threadWrappers[failedId]?.state).toBe("error");
  });
});

it("a disposed view observes no further session events", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const chat = driver.magenta.chat;
    const session = driver.magenta.serverInternals.internals.session;
    const existingId = leftThread(chat).id;
    chat.dispose();
    expect(chat["threadViews"].size).toBe(0);
    // Session mutations after dispose must not repopulate the view cache.
    const newIdOrAborted = await session.createRootThread();
    if (newIdOrAborted === ABORTED)
      throw new Error("thread creation was aborted");
    const newId = newIdOrAborted;

    expect(chat["threadViews"].size).toBe(0);
    session.deleteThread(newId);
    session.deleteThread(existingId);
    expect(chat["threadViews"].size).toBe(0);
  });
});
it("deleting a thread drops its wrapper and view but keeps siblings", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const chat = driver.magenta.chat;
    const first = leftThread(chat).id;
    const second = await chat.createThread({ type: "thread.create" });
    if (second === ABORTED) throw new Error("aborted");
    expect(Object.keys(chat.threadWrappers).sort()).toEqual(
      [first, second].sort(),
    );
    await chat.deleteThread(second);
    expect(Object.keys(chat.threadWrappers)).toEqual([first]);
    const views = chat["threadViews"];
    expect(views.has(second)).toBe(false);
    expect(views.has(first)).toBe(true);
    expect(chat.threadWrappers[first]?.state).toBe("initialized");
  });
});
it("chat.execute rejects with the message of an error result", async () => {
  await withDriver({}, async (driver) => {
    const chat = driver.magenta.chat;
    await expect(
      chat.execute({
        type: "session.setActiveProfile",
        sessionId: chat.sessionId,
        name: "missing",
      }),
    ).rejects.toThrow('Profile "missing" not found.');
    await expect(
      chat.execute({ type: "thread.delete", threadId: "nope" as ThreadId }),
    ).rejects.toThrow();
  });
});

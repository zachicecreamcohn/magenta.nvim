import type { ToolName, ToolRequestId } from "@magenta/core";
import { describe, it } from "vitest";
import { withDriver } from "../test/preamble.ts";
import { LOGO } from "./thread-view.ts";

describe("node/chat/chat.test.ts", () => {
  it("resets view when switching to a new thread", async () => {
    await withDriver({}, async (driver) => {
      // 1. Open the sidebar
      await driver.showSidebar();

      // 2. Send a message in the first thread
      await driver.inputMagentaText(
        "Hello, this is a test message in thread 1",
      );
      await driver.send();

      // Verify the message is in the display buffer
      await driver.assertDisplayBufferContains(
        "Hello, this is a test message in thread 1",
      );

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.streamText("I'm the assistant's response to the first thread");
      request.finishResponse("end_turn");

      await driver.assertDisplayBufferContains(
        "I'm the assistant's response to the first thread",
      );

      await driver.magenta.command("new-thread");
      await driver.assertDisplayBufferContains("# [ Untitled ]");
      await driver.assertDisplayBufferContains(LOGO);
    });
  });

  it("shows thread overview and allows selecting a thread", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const thread1 = driver.getThreadId(0);

      // Send a message in thread 1
      await driver.inputMagentaText("First thread message");
      await driver.send();

      // Handle the main response and thread title request
      const response1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "First thread message",
      );
      response1.respond({
        stopReason: "end_turn",
        text: "Response to first thread",
        toolRequests: [],
      });

      // Respond to thread title request for thread 1
      await driver.mockAnthropic.respondToForceToolUse({
        toolRequest: {
          status: "ok",
          value: {
            id: "title-1" as ToolRequestId,
            toolName: "thread_title" as ToolName,
            input: { title: "First Thread" },
          },
        },
        stopReason: "tool_use",
      });

      // Create second thread
      await driver.magenta.command("new-thread");
      await driver.awaitThreadCount(2);
      const thread2 = driver.getThreadId(1);
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread2,
      });

      // Send a message in thread 2
      await driver.inputMagentaText("Second thread message");
      await driver.send();

      const response2 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Second thread message",
      );
      response2.respond({
        stopReason: "end_turn",
        text: "Response to second thread",
        toolRequests: [],
      });

      // Respond to thread title request for thread 2
      await driver.mockAnthropic.respondToForceToolUse({
        toolRequest: {
          status: "ok",
          value: {
            id: "title-2" as ToolRequestId,
            toolName: "thread_title" as ToolName,
            input: { title: "Second Thread" },
          },
        },
        stopReason: "tool_use",
      });

      await driver.magenta.command("threads-overview");

      await driver.assertDisplayBufferContains("# Threads");
      await driver.assertDisplayBufferContains(
        `- First Thread: ⏹️ stopped (end_turn)`,
      );
      await driver.assertDisplayBufferContains(
        `* Second Thread: ⏹️ stopped (end_turn)`,
      );

      await driver.triggerDisplayBufferKeyOnContent(
        `- First Thread: ⏹️ stopped (end_turn)`,
        "<CR>",
      );
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread1,
      });
    });
  });
});

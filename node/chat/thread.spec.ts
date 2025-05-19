import { withDriver } from "../test/preamble.ts";
import { LOGO } from "./thread.ts";
import { type ToolRequestId } from "../tools/toolManager.ts";
import { describe, expect, it } from "vitest";

describe("node/chat/thread.spec.ts", () => {
  it("chat render and a few updates", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Can you look at my list of buffers?");
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-list-buffers" as ToolRequestId;

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "Sure, let me use the list_buffers tool.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "list_buffers",
              input: {},
            },
          },
        ],
      });

      // Check that the buffer contains the expected content during tool execution
      await driver.assertDisplayBufferContains(
        "Can you look at my list of buffers?",
      );
      await driver.assertDisplayBufferContains(
        "Sure, let me use the list_buffers tool.",
      );

      // After the tool executes
      await driver.assertDisplayBufferContains("✅ Finished getting buffers.");
    });
  });

  it("chat clear", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Can you look at my list of buffers?");
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "Sure, let me use the list_buffers tool.",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains(
        "Can you look at my list of buffers?",
      );
      await driver.assertDisplayBufferContains(
        "Sure, let me use the list_buffers tool.",
      );

      await driver.clear();
      await driver.assertDisplayBufferContains(LOGO.split("\n")[0]);
    });
  });

  it("getMessages correctly interleaves tool requests and responses", async () => {
    await withDriver({}, async (driver) => {
      // Create a more complex conversation with multiple tool uses
      await driver.showSidebar();
      await driver.inputMagentaText("Can you help me with my code?");
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();

      const toolRequestId1 = "tool-1" as ToolRequestId;
      const toolRequestId2 = "tool-2" as ToolRequestId;

      // First response with list_directory tool use
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "I'll help you. Let me check your files first.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId1,
              toolName: "list_directory",
              input: { dirPath: "." },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Finished listing directory");

      await driver.mockAnthropic.awaitPendingRequest();
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "Now let me check your buffers too.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId2,
              toolName: "list_buffers",
              input: {},
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Finished getting buffers");

      // Final part of the assistant's response
      await driver.mockAnthropic.awaitPendingRequest();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "Based on these results, I can help you.",
        toolRequests: [],
      });

      // Verify all parts of the conversation are present
      await driver.assertDisplayBufferContains("Can you help me with my code?");
      await driver.assertDisplayBufferContains(
        "I'll help you. Let me check your files first.",
      );
      await driver.assertDisplayBufferContains(
        "Now let me check your buffers too.",
      );
      await driver.assertDisplayBufferContains(
        "Based on these results, I can help you.",
      );

      // Verify the thread's internal message structure is correct with a snapshot
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      expect(messages.length).toBe(6);
      expect(
        messages.flatMap((m) => m.content.map((b) => m.role + ":" + b.type)),
      ).toEqual([
        "user:text",
        "assistant:text",
        "assistant:tool_use",
        "user:tool_result",
        "assistant:text",
        "assistant:tool_use",
        "user:tool_result",
        "assistant:text",
      ]);
    });
  });

  it("handles errors during streaming response", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Test error handling during response");
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();

      // Simulate an error during streaming
      const errorMessage = "Simulated error during streaming";
      await driver.mockAnthropic.respondWithError(new Error(errorMessage));

      // Verify the error is handled and displayed to the user
      await driver.assertDisplayBufferContains(
        "Test error handling during response",
      );

      // Verify error message is displayed in the UI
      await driver.assertDisplayBufferContains("Error");
      await driver.assertDisplayBufferContains(errorMessage);
    });
  });
});

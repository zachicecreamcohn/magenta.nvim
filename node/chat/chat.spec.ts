import { withDriver } from "../test/preamble.ts";
import { describe, it } from "vitest";
import { LOGO, type ThreadId } from "./thread.ts";

describe("node/chat/chat.spec.ts", () => {
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

      await driver.mockAnthropic.streamText(
        "I'm the assistant's response to the first thread",
      );

      await driver.assertDisplayBufferContains(
        "I'm the assistant's response to the first thread",
      );

      await driver.magenta.command("new-thread");
      await driver.assertDisplayBufferContent(LOGO + "\n");
    });
  });

  it("shows thread overview and allows selecting a thread", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.magenta.command("new-thread");
      await driver.awaitChatState({
        state: "thread-selected",
        id: 2 as ThreadId,
      });

      await driver.magenta.command("threads-overview");

      await driver.assertDisplayBufferContains(`\
# Threads

- 1
* 2`);

      const threadPos = await driver.assertDisplayBufferContains("1");
      await driver.triggerDisplayBufferKey(threadPos, "<CR>");
      await driver.awaitChatState({
        state: "thread-selected",
        id: 1 as ThreadId,
      });
    });
  });
});

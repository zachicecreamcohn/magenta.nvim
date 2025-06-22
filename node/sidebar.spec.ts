import { describe, it, expect } from "vitest";
import { withDriver } from "./test/preamble";
import { pollUntil } from "./utils/async";

describe("node/sidebar.spec.ts", () => {
  it("send command should scroll to last user message", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`\n`.repeat(100));
      await driver.send();
      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "end_turn",
        text: "sup?",
        toolRequests: [],
      });
      await driver.inputMagentaText(`sup!`);
      await driver.send();

      const displayWindow = driver.getVisibleState().displayWindow;
      await pollUntil(async () => {
        const current = await displayWindow.topLine();
        const expected = 110;
        if (current != expected) {
          throw new Error(
            `Expected to scroll to line ${expected} but we were at ${current}`,
          );
        }
      });
    });
  });

  it("should display and update token count in input window title", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      const { inputWindow } = driver.getVisibleState();
      const initialWinbar = await inputWindow.getOption("winbar");
      expect(initialWinbar).toContain("Magenta Input (claude-sonnet-3.7) [~");

      // Generate a large message that will definitely increase the token count
      const largeMessage = "Hello, this is a test message. ".repeat(500);
      await driver.inputMagentaText(largeMessage);
      await driver.send();
      const request1 = await driver.mockAnthropic.awaitPendingRequest();
      request1.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [],
        usage: {
          inputTokens: 1000,
          outputTokens: 2000,
        },
      });

      // Wait for token count to update after the large message
      await pollUntil(async () => {
        const updatedWinbar = await inputWindow.getOption("winbar");
        const updatedCount = extractTokenCount(updatedWinbar as string);
        // Token count should be noticeably higher
        if (updatedCount <= 2000) {
          throw new Error(
            `Token count did not increase: 2K -> ${updatedCount}`,
          );
        }
      });
    });
  });
});

// Helper function to extract token count from winbar title
function extractTokenCount(winbar: string): number {
  const match = winbar.match(/\[~?(\d+)K?\s+tokens\]/);
  if (!match) return 0;

  if (match[1] && match[0].includes("K")) {
    return parseInt(match[1]) * 1000;
  }
  return parseInt(match[1]);
}

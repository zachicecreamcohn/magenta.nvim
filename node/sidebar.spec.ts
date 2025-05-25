import { describe, it } from "vitest";
import { withDriver } from "./test/preamble";
import { pollUntil } from "./utils/async";

describe("node/sidebar.spec.ts", () => {
  it("send command should scroll to last user message", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`\n`.repeat(100));
      await driver.send();
      await driver.mockAnthropic.respond({
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
});

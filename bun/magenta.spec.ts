import { describe, it } from "bun:test";
import { withDriver } from "./test/preamble";

describe("bun/magenta.spec.ts", () => {
  it("clear command should work", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`hello`);
      await driver.send();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "sup?",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContent(`\
# user:
hello

# assistant:
sup?

Stopped (end_turn)`);

      await driver.clear();
      await driver.assertDisplayBufferContent(`Stopped (end_turn)`);
      await driver.inputMagentaText(`hello again`);
      await driver.send();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "huh?",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContent(`\
# user:
hello again

# assistant:
huh?

Stopped (end_turn)`);
    });
  });
});

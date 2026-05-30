import { describe, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

describe("tool definitions view", () => {
  it("toggles the collapsible tool definitions section", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      const collapsed = await driver.assertDisplayBufferContains(
        "🔧 [Tool Definitions",
      );
      await driver.triggerDisplayBufferKey(collapsed, "=");

      await driver.assertDisplayBufferContains("## get_file");

      const expanded = await driver.assertDisplayBufferContains(
        "🔧 [Tool Definitions",
      );
      await driver.triggerDisplayBufferKey(expanded, "=");

      await driver.assertDisplayBufferDoesNotContain("## get_file");
    });
  });
});

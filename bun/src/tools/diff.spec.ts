import { describe, expect, it } from "bun:test";
import { withDriver } from "../../test/preamble";
import type { ToolRequestId } from "./toolManager";
import * as path from "path";

describe("tea/diff.spec.ts", () => {
  it.only("basic diff flow", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Write me a short poem in the file poem.txt`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here is a poem",
        toolRequests: [
          {
            status: "ok",
            value: {
              type: "tool_use",
              id: "id" as ToolRequestId,
              name: "insert",
              input: {
                filePath: "poem.txt",
                insertAfter: "",
                content: "a poem",
              },
            },
          },
        ],
      });

      const reviewPos =
        await driver.assertDisplayBufferContains("review edits");

      await driver.triggerDisplayBufferKey(reviewPos, "<CR>");
      await driver.assertWindowCount(4);

      const poemWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return path.basename(name) == "poem.txt";
      });

      expect(await poemWin.getOption("diff")).toBe(true);

      const poemText = (
        await (await poemWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(poemText).toEqual("");

      const diffWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        console.log(`name: ${name}`);
        return path.basename(name) == "diff_poem.txt";
      });

      expect(await diffWin.getOption("diff")).toBe(true);

      const diffText = (
        await (await diffWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(diffText).toEqual("a poem");
    });
  });
});

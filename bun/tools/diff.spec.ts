import { describe, expect, it } from "bun:test";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import * as path from "path";

describe("bun/tools/diff.spec.ts", () => {
  it("insert into new file", async () => {
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
        return /poem.txt_message_2_diff$/.test(name);
      });

      expect(await diffWin.getOption("diff")).toBe(true);

      const diffText = (
        await (await diffWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(diffText).toEqual("a poem");
    });
  });

  it("replace in existing file", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Update the poem in the file bun/test/fixtures/poem.txt`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, I will try to rewrite the poem in that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              type: "tool_use",
              id: "id" as ToolRequestId,
              name: "replace",
              input: {
                filePath: "bun/test/fixtures/poem.txt",
                startLine: `Moonlight whispers through the trees,`,
                endLine: `Paint their stories in the night.`,
                replace: `In gardens wild and flowing free,
Magenta blooms for all to see.
Nature's canvas, bold and bright,
Paints its colors in the light.`,
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
        return /bun\/test\/fixtures\/poem.txt$/.test(name);
      });

      expect(await poemWin.getOption("diff")).toBe(true);

      const poemText = (
        await (await poemWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(poemText).toEqual(
        "Moonlight whispers through the trees,\nSilver shadows dance with ease.\nStars above like diamonds bright,\nPaint their stories in the night.",
      );

      const diffWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return /bun\/test\/fixtures\/poem.txt_message_2_diff$/.test(name);
      });

      expect(await diffWin.getOption("diff")).toBe(true);

      const diffText = (
        await (await diffWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(diffText).toEqual(
        "In gardens wild and flowing free,\nMagenta blooms for all to see.\nNature's canvas, bold and bright,\nPaints its colors in the light.",
      );
    });
  });

  it("multiple messages editing same file", async () => {
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

      let reviewPos;
      {
        reviewPos = await driver.assertDisplayBufferContains("review edits");

        await driver.triggerDisplayBufferKey(reviewPos, "<CR>");
        await driver.assertWindowCount(4);

        const diffWin = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return /poem.txt_message_2_diff$/.test(name);
        });
        await diffWin.close();
      }

      await driver.inputMagentaText(`Another one!`);
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here is another poem",
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
                content: "another poem",
              },
            },
          },
        ],
      });

      {
        const nextReviewPos = await driver.assertDisplayBufferContains(
          "review edits",
          reviewPos.row + 1,
        );

        await driver.triggerDisplayBufferKey(nextReviewPos, "<CR>");
        await driver.assertWindowCount(4);

        const diffWin = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return /poem.txt_message_4_diff$/.test(name);
        });

        const diffText = (
          await (await diffWin.buffer()).getLines({ start: 0, end: -1 })
        ).join("\n");
        expect(diffText).toEqual("another poem");
      }
    });
  });
});

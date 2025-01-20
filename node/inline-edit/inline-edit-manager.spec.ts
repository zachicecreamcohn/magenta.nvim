import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "../tools/toolManager";
import { getCurrentBuffer, getCurrentWindow } from "../nvim/nvim";
import type { Line } from "../nvim/buffer";

describe("node/inline-edit/inline-edit-manager.spec.ts", () => {
  it("performs inline edit on file", async () => {
    await withDriver(async (driver) => {
      await driver.editFile("node/test/fixtures/poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);
      await driver.startInlineEdit();

      // Verify inline edit window opened
      await driver.assertWindowCount(2);

      const inputWindow = await getCurrentWindow(driver.nvim);
      const winbar = await inputWindow.getOption("winbar");
      expect(winbar).toEqual("Magenta Inline Prompt");

      const mode = await driver.nvim.call("nvim_get_mode", []);
      expect(mode).toEqual({ mode: "i", blocking: false });

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0,
        end: -1,
        lines: ["Please change 'Silver' to 'Golden' in line 2"] as Line[],
      });
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      await driver.mockAnthropic.awaitPendingInlineRequest();

      const modifiable = await inputBuffer.getOption("modifiable");
      expect(modifiable).toBe(false);

      const inputLines = await inputBuffer.getLines({ start: 0, end: -1 });
      expect(inputLines.join("\n")).toEqual("Input sent, awaiting response...");

      await driver.mockAnthropic.respondInline({
        stopReason: "end_turn",
        inlineEdit: {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            name: "inline-edit",
            input: {
              find: "Silver shadows dance with ease.",
              replace: "Golden shadows dance with ease.",
            },
          },
        },
      });

      await driver.assertBufferContains(
        inputBuffer,
        `\
Got tool use: `,
      );

      await driver.assertBufferContains(
        targetBuffer,
        `\
>>>>>>> Suggested change
Golden shadows dance with ease.
=======
Silver shadows dance with ease.
<<<<<<< Current`,
      );
    });
  });

  it("can do multiple inline edits on same file", async () => {
    await withDriver(async (driver) => {
      await driver.editFile("node/test/fixtures/poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);
      await driver.startInlineEdit();
      await driver.assertWindowCount(2);

      {
        const inputWindow = await getCurrentWindow(driver.nvim);
        await inputWindow.close();
      }
      await driver.assertWindowCount(1);

      // open inline edit again
      await driver.startInlineEdit();
      await driver.assertWindowCount(2);

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0,
        end: -1,
        lines: ["Please change 'Silver' to 'Golden' in line 2"] as Line[],
      });
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      await driver.mockAnthropic.awaitPendingInlineRequest();

      const inputLines = await inputBuffer.getLines({ start: 0, end: -1 });
      expect(inputLines.join("\n")).toEqual("Input sent, awaiting response...");
    });
  });
});

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { test } from "vitest";
import { withDriver } from "../test/preamble.ts";

test("summary shows edited file, opens on <CR>, and resets on next turn", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await fs.writeFile(path.join(tmpDir, "a.txt"), "hello\n");
        await fs.writeFile(path.join(tmpDir, "b.txt"), "world\n");
      },
    },
    async (driver, dirs) => {
      await driver.showSidebar();
      await driver.inputMagentaText("edit a");
      await driver.send();

      const aPath = path.join(dirs.tmpDir, "a.txt");
      const bPath = path.join(dirs.tmpDir, "b.txt");

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "tool_use",
        text: "editing a",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "t1" as ToolRequestId,
              toolName: "edl" as ToolName,
              input: {
                script: `file \`${aPath}\`\nnarrow /hello/\nreplace "bye"`,
              },
            },
          },
        ],
      });

      const followup1 = await driver.mockAnthropic.awaitPendingStream();
      followup1.respond({
        stopReason: "end_turn",
        text: "done",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains("Files edited this turn:");
      const pos = await driver.assertDisplayBufferContains("a.txt");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      await driver.inputMagentaText("edit b");
      await driver.send();

      await driver.assertDisplayBufferDoesNotContain("Files edited this turn:");

      const stream2 = await driver.mockAnthropic.awaitPendingStream();
      stream2.respond({
        stopReason: "tool_use",
        text: "editing b",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "t2" as ToolRequestId,
              toolName: "edl" as ToolName,
              input: {
                script: `file \`${bPath}\`\nnarrow /world/\nreplace "globe"`,
              },
            },
          },
        ],
      });

      const followup2 = await driver.mockAnthropic.awaitPendingStream();
      followup2.respond({
        stopReason: "end_turn",
        text: "done",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains("Files edited this turn:");
      await driver.assertDisplayBufferContains("b.txt");
    },
  );
});

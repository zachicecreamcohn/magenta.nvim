import { type ToolRequestId } from "./toolManager.ts";
import { describe, it, expect } from "bun:test";
import { withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async.ts";

describe("bun/tools/hover.spec.ts", () => {
  it("hover end-to-end", async () => {
    await withDriver(async (driver) => {
      await driver.editFile("bun/test/fixtures/test.ts");
      await driver.showSidebar();

      await driver.inputMagentaText(`Try hovering a symbol`);
      await driver.send();

      const toolRequestId = "id" as ToolRequestId;
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              type: "tool_use",
              id: toolRequestId,
              name: "hover",
              input: {
                filePath: "bun/test/fixtures/test.ts",
                symbol: "val.a.b.c",
              },
            },
          },
        ],
      });

      const result = await pollUntil(
        () => {
          const state = driver.magenta.chatApp.getState();
          if (state.status != "running") {
            throw new Error(`app crashed`);
          }

          const toolWrapper =
            state.model.toolManager.toolWrappers[toolRequestId];
          if (!toolWrapper) {
            throw new Error(
              `could not find toolWrapper with id ${toolRequestId}`,
            );
          }

          if (toolWrapper.model.state.state != "done") {
            throw new Error(`Request not done`);
          }

          return toolWrapper.model.state.result;
        },
        { timeout: 3000 },
      );

      expect(result).toEqual({
        tool_use_id: toolRequestId,
        type: "tool_result",
        content: `(markdown):\n\n\`\`\`typescript\n(property) c: "test"\n\`\`\`\n\n`,
      });
    });
  });
});

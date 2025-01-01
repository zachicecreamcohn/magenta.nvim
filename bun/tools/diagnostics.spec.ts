import { type ToolRequestId } from "./toolManager.ts";
import { describe, it, expect } from "bun:test";
import { withDriver } from "../test/preamble";
import { delay, pollUntil } from "../utils/async.ts";

describe("bun/tools/diagnostics.spec.ts", () => {
  it.only("diagnostics end-to-end", async () => {
    await withDriver(async (driver) => {
      await driver.editFile("bun/test/fixtures/test.ts");
      await driver.showSidebar();

      await driver.inputMagentaText(`Try getting the diagnostics`);
      await driver.send();

      const toolRequestId = "id" as ToolRequestId;
      await delay(2000);
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              type: "tool_use",
              id: toolRequestId,
              name: "diagnostics",
              input: {},
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
        { timeout: 5000 },
      );

      expect(result).toEqual({
        tool_use_id: toolRequestId,
        type: "tool_result",
        content: `file: bun/test/fixtures/test.ts source: typescript, severity: 1, message: "Property 'd' does not exist on type '{ c: "test"; }'."`,
      });
    });
  });
});

import { type ToolRequestId } from "./toolManager.ts";
import { describe, it, expect } from "bun:test";
import { withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async.ts";

describe("bun/tools/diagnostics.spec.ts", () => {
  it(
    "diagnostics end-to-end",
    async () => {
      await withDriver(async (driver) => {
        await driver.editFile("bun/test/fixtures/test.ts");
        await driver.showSidebar();

        await driver.inputMagentaText(`Try getting the diagnostics`);
        await driver.send();

        const toolRequestId = "id" as ToolRequestId;

        await pollUntil(
          async () => {
            const state = driver.magenta.chatApp.getState();
            if (state.status != "running") {
              throw new Error(`app crashed`);
            }
            const diagnostics = (await driver.nvim.call("nvim_exec_lua", [
              `return vim.diagnostic.get(nil)`,
              [],
            ])) as unknown[];

            if (diagnostics.length === 0) {
              throw new Error("No diagnostics available yet");
            }
          },
          { timeout: 5000 },
        );

        await driver.mockAnthropic.respond({
          stopReason: "tool_use",
          text: "ok, here goes",
          toolRequests: [
            {
              status: "ok",
              value: {
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
          type: "tool_result",
          id: toolRequestId,
          result: {
            status: "ok",
            value: `file: bun/test/fixtures/test.ts source: typescript, severity: 1, message: "Property 'd' does not exist on type '{ c: "test"; }'."`,
          },
        });
      });
    },
    { timeout: 10000 },
  );
});

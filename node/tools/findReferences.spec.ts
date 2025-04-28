import { type ToolRequestId } from "./toolManager.ts";
import { describe, it, expect } from "vitest";
import { withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async.ts";

describe("node/tools/findReferences.spec.ts", () => {
  it("findReferences end-to-end", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("node/test/fixtures/test.ts");
      await driver.showSidebar();

      await driver.inputMagentaText(`Try finding references for a symbol`);
      await driver.send();

      const toolRequestId = "id" as ToolRequestId;
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              name: "find_references",
              input: {
                filePath: "node/test/fixtures/test.ts",
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
            state.model.thread.state.toolManager.toolWrappers[toolRequestId];
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
        type: "tool_result",
        id: toolRequestId,
        result: {
          status: "ok",
          value: `node/test/fixtures/test.ts:4:6\nnode/test/fixtures/test.ts:12:6\nnode/test/fixtures/test.ts:17:20\n`,
        },
      });
    });
  });
});

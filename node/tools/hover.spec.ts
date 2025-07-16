import { type ToolRequestId } from "./toolManager.ts";
import { describe, it, expect } from "vitest";
import { withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { HoverTool } from "./hover.ts";
import type { ToolName } from "./types.ts";

describe("node/tools/hover.spec.ts", () => {
  it("hover end-to-end", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("test.ts");
      await driver.showSidebar();

      await driver.inputMagentaText(`Try hovering a symbol`);
      await driver.send();

      // wait for ts_ls to start/attach
      const toolRequestId = "id" as ToolRequestId;
      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "hover" as ToolName,
              input: {
                filePath: "test.ts" as UnresolvedFilePath,
                symbol: "val.a.b.c",
              },
            },
          },
        ],
      });

      const result = await pollUntil(
        () => {
          const thread = driver.magenta.chat.getActiveThread();
          if (!thread || !thread.state || typeof thread.state !== "object") {
            throw new Error("Thread state is not valid");
          }

          const tool = thread.toolManager.getTool(toolRequestId);
          if (!(tool && tool.toolName == "hover")) {
            throw new Error(`could not find tool with id ${toolRequestId}`);
          }

          const hoverTool = tool as unknown as HoverTool;
          if (hoverTool.state.state != "done") {
            throw new Error(`Request not done`);
          }

          return hoverTool.state.result;
        },
        { timeout: 5000 },
      );

      expect(result.type).toBe("tool_result");
      expect(result.id).toBe(toolRequestId);
      expect(result.result.status).toBe("ok");
      const res = result.result as Extract<
        typeof result.result,
        { status: "ok" }
      >;
      expect(res.value).toHaveLength(1);
      expect(res.value[0].type).toBe("text");

      const val0 = res.value[0];
      const text = (val0 as Extract<typeof val0, { type: "text" }>).text;

      expect(text).toBe(`
\`\`\`typescript
(property) c: "test"
\`\`\`


Definition locations:
  test.ts:4:7
`);
    });
  });
});

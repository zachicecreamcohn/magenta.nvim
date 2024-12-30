import * as ListBuffers from "./listBuffers.ts";
import { type ToolRequestId } from "./toolManager.ts";
import { createApp } from "../tea/tea.ts";
import { describe, it, expect } from "bun:test";
import { pos } from "../tea/view.ts";
import { NvimBuffer } from "../nvim/buffer.ts";
import { withNvimClient } from "../test/preamble.ts";

describe("tea/listBuffers.spec.ts", () => {
  it("render the getFile tool.", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const [model, _thunk] = ListBuffers.initModel(
        {
          type: "tool_use",
          id: "request_id" as ToolRequestId,
          name: "list_buffers",
          input: {},
        },
        { nvim },
      );

      const app = createApp({
        nvim,
        initialModel: model,
        update: ListBuffers.update,
        View: ListBuffers.view,
      });

      const mountedApp = await app.mount({
        nvim,
        buffer,
        startPos: pos(0, 0),
        endPos: pos(-1, -1),
      });

      await mountedApp.waitForRender();

      const content = (await buffer.getLines({ start: 0, end: -1 })).join("\n");

      expect(
        content,
        // "initial render of list buffers tool is as expected",
      ).toBe(`⚙️ Grabbing buffers...`);

      app.dispatch({
        type: "finish",
        result: {
          type: "tool_result",
          tool_use_id: "request_id" as ToolRequestId,
          content: "buffer list",
        },
      });

      await mountedApp.waitForRender();
      expect(
        (await buffer.getLines({ start: 0, end: -1 })).join("\n"),
        "initialRender is as expected",
      ).toBe(`✅ Finished getting buffers.`);
    });
  });
});

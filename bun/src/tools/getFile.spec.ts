import * as GetFile from "./getFile.ts";
import * as assert from "assert";
import type { ToolRequestId } from "./toolManager.ts";
import { createApp } from "../tea/tea.ts";
import { describe, it } from "bun:test";
import { pos } from "../tea/view.ts";
import { NvimBuffer } from "../nvim/buffer.ts";
import { withNvimClient } from "../../test/preamble.ts";

describe("tea/getFile.spec.ts", () => {
  it("render the getFile tool.", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);
      const [model, _thunk] = GetFile.initModel(
        {
          type: "tool_use",
          id: "request_id" as ToolRequestId,
          name: "get_file",
          input: {
            filePath: "./file.txt",
          },
        },
        { nvim },
      );

      const app = createApp({
        nvim,
        initialModel: model,
        update: GetFile.update,
        View: GetFile.view,
      });

      const mountedApp = await app.mount({
        nvim,
        buffer,
        startPos: pos(0, 0),
        endPos: pos(-1, -1),
      });

      await mountedApp.waitForRender();

      assert.equal(
        (await buffer.getLines({ start: 0, end: -1 })).join("\n"),
        `⚙️ Reading file ./file.txt`,
        "initialRender is as expected",
      );
      app.dispatch({
        type: "finish",
        result: {
          type: "tool_result",
          tool_use_id: "request_id" as ToolRequestId,
          content: "file content",
        },
      });

      await mountedApp.waitForRender();
      assert.equal(
        (await buffer.getLines({ start: 0, end: -1 })).join("\n"),
        `✅ Finished reading file ./file.txt`,
        "initialRender is as expected",
      );
    });
  });
});

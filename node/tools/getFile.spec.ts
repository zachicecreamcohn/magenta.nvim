import { GetFileTool, type Msg as GetFileMsg } from "./getFile.ts";
import * as assert from "assert";
import type { ToolRequestId } from "./toolManager.ts";
import { createApp } from "../tea/tea.ts";
import { describe, it } from "vitest";
import { pos } from "../tea/view.ts";
import { NvimBuffer } from "../nvim/buffer.ts";
import { withDriver, withNvimClient } from "../test/preamble.ts";

describe("tea/getFile.spec.ts", () => {
  it("render the getFile tool.", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);
      const [tool, _thunk] = GetFileTool.create(
        {
          id: "request_id" as ToolRequestId,
          toolName: "get_file",
          input: {
            filePath: "./file.txt",
          },
        },
        { nvim },
      );

      const app = createApp<{ tool: GetFileTool }, GetFileMsg>({
        nvim,
        initialModel: { tool },
        update: (msg, model) => {
          model.tool.update(msg);
          return [model];
        },
        View: ({ model, dispatch }) => model.tool.view(dispatch),
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
      );
      app.dispatch({
        type: "finish",
        result: {
          status: "ok",
          value: "file content",
        },
      });

      await mountedApp.waitForRender();
      assert.equal(
        (await buffer.getLines({ start: 0, end: -1 })).join("\n"),
        `✅ Finished reading file \`./file.txt\``,
      );
    });
  });

  it("getFile rejection", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Try reading the file node/test/fixtures/.secret`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "get_file",
              input: {
                filePath: "node/test/fixtures/.secret",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`\
May I read file \`node/test/fixtures/.secret\`? **[ NO ]** **[ OK ]**`);
      const noPos = await driver.assertDisplayBufferContains("**[ NO ]**");

      await driver.triggerDisplayBufferKey(noPos, "<CR>");
      await driver.assertDisplayBufferContains(`\
Error reading file \`node/test/fixtures/.secret\`: The user did not allow the reading of this file.`);
    });
  });

  it("getFile approval", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Try reading the file node/test/fixtures/.secret`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "get_file",
              input: {
                filePath: "node/test/fixtures/.secret",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`\
May I read file \`node/test/fixtures/.secret\`? **[ NO ]** **[ OK ]**`);
      const okPos = await driver.assertDisplayBufferContains("**[ OK ]**");

      await driver.triggerDisplayBufferKey(okPos, "<CR>");
      await driver.assertDisplayBufferContains(`\
Finished reading file \`node/test/fixtures/.secret\``);
    });
  });

  it("getFile requests approval for gitignored file", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Try reading the file node_modules/test`);
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "get_file",
              input: {
                filePath: "node_modules/test",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`\
May I read file \`node_modules/test\`? **[ NO ]** **[ OK ]**`);
    });
  });

  it("getFile requests approval for file outside cwd", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Try reading the file /tmp/file`);
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "get_file",
              input: {
                filePath: "/tmp/file",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`\
May I read file \`/tmp/file\`? **[ NO ]** **[ OK ]**`);
    });
  });
});

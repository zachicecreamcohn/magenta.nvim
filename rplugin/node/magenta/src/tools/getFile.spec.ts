/* eslint-disable @typescript-eslint/no-floating-promises */
import type { NeovimClient, Buffer } from "neovim";
import { NeovimTestHelper } from "../../test/preamble.ts";
import * as GetFile from "./getFile.ts";
import * as assert from "assert";
import { ToolRequestId } from "./toolManager.ts";
import { createApp } from "../tea/tea.ts";
import { test, describe, it } from "node:test";

describe("tea/getFile.spec.ts", () => {
  let helper: NeovimTestHelper;
  let nvim: NeovimClient;
  let buffer: Buffer;

  test.before(() => {
    helper = new NeovimTestHelper();
  });

  test.beforeEach(async () => {
    nvim = await helper.startNvim();
    buffer = (await nvim.createBuffer(false, true)) as Buffer;
    await buffer.setOption("modifiable", false);
  });

  test.afterEach(() => {
    helper.stopNvim();
  });

  it("render the getFile tool.", async () => {
    const [model, _thunk] = GetFile.initModel({
      type: "tool_use",
      id: "request_id" as ToolRequestId,
      name: "get_file",
      input: {
        filePath: "./file.txt",
      },
    });

    const app = createApp({
      initialModel: model,
      update: GetFile.update,
      View: GetFile.view,
    });

    const mountedApp = await app.mount({
      buffer,
      startPos: { row: 0, col: 0 },
      endPos: { row: -1, col: -1 },
    });

    await mountedApp.waitForRender();

    assert.equal(
      (
        await buffer.getLines({ start: 0, end: -1, strictIndexing: false })
      ).join("\n"),
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
      (
        await buffer.getLines({ start: 0, end: -1, strictIndexing: false })
      ).join("\n"),
      `✅ Finished reading file ./file.txt`,
      "initialRender is as expected",
    );
  });
});

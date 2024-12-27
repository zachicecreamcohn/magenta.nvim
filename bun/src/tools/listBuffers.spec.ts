import { NeovimTestHelper } from "../../test/preamble.ts";
import * as ListBuffers from "./listBuffers.ts";
import { type ToolRequestId } from "./toolManager.ts";
import { createApp } from "../tea/tea.ts";
import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "bun:test";
import { pos } from "../tea/view.ts";
import { NvimBuffer } from "../nvim/buffer.ts";

describe("tea/listBuffers.spec.ts", () => {
  let helper: NeovimTestHelper;
  let buffer: NvimBuffer;

  beforeAll(() => {
    helper = new NeovimTestHelper();
  });

  beforeEach(async () => {
    await helper.startNvim();
    buffer = await NvimBuffer.create(false, true);
    await buffer.setOption("modifiable", false);
  });

  afterEach(() => {
    helper.stopNvim();
  });

  it("render the getFile tool.", async () => {
    const [model, _thunk] = ListBuffers.initModel({
      type: "tool_use",
      id: "request_id" as ToolRequestId,
      name: "list_buffers",
      input: {},
    });

    const app = createApp({
      initialModel: model,
      update: ListBuffers.update,
      View: ListBuffers.view,
    });

    const mountedApp = await app.mount({
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

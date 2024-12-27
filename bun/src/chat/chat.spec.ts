/* eslint-disable @typescript-eslint/no-floating-promises */
import { extractMountTree, NeovimTestHelper } from "../../test/preamble.ts";
import * as Chat from "./chat.ts";
import { type ToolRequestId } from "../tools/toolManager.ts";
import { createApp } from "../tea/tea.ts";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { pos } from "../tea/view.ts";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";

describe("tea/chat.spec.ts", () => {
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

  it.only("chat render and a few updates", async () => {
    const model = Chat.initModel();

    const app = createApp({
      initialModel: model,
      update: Chat.update,
      View: Chat.view,
      suppressThunks: true,
    });

    const mountedApp = await app.mount({
      buffer,
      startPos: pos(0, 0),
      endPos: pos(-1, -1),
    });

    await mountedApp.waitForRender();

    expect(
      await buffer.getLines({ start: 0, end: -1 }),
      "initial render of chat works",
    ).toEqual(["Stopped (end_turn)"] as Line[]);

    app.dispatch({
      type: "add-message",
      role: "user",
      content: "Can you look at my list of buffers?",
    });
    await mountedApp.waitForRender();

    app.dispatch({
      type: "stream-response",
      text: "Sure, let me use the list_buffers tool.",
    });
    await mountedApp.waitForRender();

    app.dispatch({
      type: "init-tool-use",
      request: {
        status: "ok",
        value: {
          type: "tool_use",
          id: "request-id" as ToolRequestId,
          input: {},
          name: "list_buffers",
        },
      },
    });
    await mountedApp.waitForRender();

    expect(
      await buffer.getLines({ start: 0, end: -1 }),
      "in-progress render is as expected",
    ).toEqual([
      "# user:",
      "Can you look at my list of buffers?",
      "",
      "# assistant:",
      "Sure, let me use the list_buffers tool.",
      "⚙️ Grabbing buffers...",
      "",
      "Stopped (end_turn)",
    ] as Line[]);

    expect(
      await extractMountTree(mountedApp.getMountedNode()),
    ).toMatchSnapshot();

    app.dispatch({
      type: "tool-manager-msg",
      msg: {
        type: "tool-msg",
        id: "request-id" as ToolRequestId,
        msg: {
          type: "list_buffers",
          msg: {
            type: "finish",
            result: {
              type: "tool_result",
              tool_use_id: "request-id" as ToolRequestId,
              content: "some buffer content",
            },
          },
        },
      },
    });
    await mountedApp.waitForRender();

    expect(
      await buffer.getLines({ start: 0, end: -1 }),
      "finished render is as expected",
    ).toEqual([
      "# user:",
      "Can you look at my list of buffers?",
      "",
      "# assistant:",
      "Sure, let me use the list_buffers tool.",
      "✅ Finished getting buffers.",
      "",
      "Stopped (end_turn)",
    ] as Line[]);
  });
});

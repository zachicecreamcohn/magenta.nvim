/* eslint-disable @typescript-eslint/no-floating-promises */
import type { NeovimClient, Buffer } from "neovim";
import { extractMountTree, NeovimTestHelper } from "../../test/preamble.ts";
import * as Chat from "./chat.ts";
import * as assert from "assert";
import { ToolRequestId } from "../tools/toolManager.ts";
import { createApp } from "../tea/tea.ts";
import { test, describe, it } from "node:test";
import { pos } from "../tea/view.ts";

describe("tea/chat.spec.ts", () => {
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

  it("chat render and a few updates", async () => {
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

    assert.equal(
      (
        await buffer.getLines({ start: 0, end: -1, strictIndexing: false })
      ).join("\n"),
      ``,
      "initial render of chat works",
    );
    app.dispatch({
      type: "add-message",
      role: "user",
      content: "Can you look at my list of buffers?",
    });
    await mountedApp.waitForRender();

    app.dispatch({
      type: "stream-response",
      text: "Sure, let me use the list-buffers tool.",
    });
    await mountedApp.waitForRender();

    app.dispatch({
      type: "init-tool-use",
      request: {
        type: "tool_use",
        id: "request-id" as ToolRequestId,
        input: {},
        name: "list_buffers",
      },
    });
    await mountedApp.waitForRender();

    assert.deepStrictEqual(
      await buffer.getLines({ start: 0, end: -1, strictIndexing: false }),
      [
        "### user:",
        "Can you look at my list of buffers?",
        "",
        "### assistant:",
        "Sure, let me use the list-buffers tool.",
        "⚙️ Grabbing buffers...",
        "",
        "",
      ],
      "in-progress render is as expected",
    );
    assert.deepStrictEqual(
      await extractMountTree(mountedApp.getMountedNode()),
      {
        type: "node",
        children: [
          {
            type: "node",
            children: [
              {
                type: "array",
                children: [
                  {
                    type: "node",
                    children: [
                      {
                        type: "node",
                        children: [
                          {
                            type: "string",
                            startPos: {
                              row: 0,
                              col: 0,
                            },
                            endPos: {
                              row: 0,
                              col: 4,
                            },
                            content: "### ",
                          },
                          {
                            type: "string",
                            startPos: {
                              row: 0,
                              col: 4,
                            },
                            endPos: {
                              row: 0,
                              col: 8,
                            },
                            content: "user",
                          },
                          {
                            type: "string",
                            startPos: {
                              row: 0,
                              col: 8,
                            },
                            endPos: {
                              row: 1,
                              col: 0,
                            },
                            content: ":\n",
                          },
                          {
                            type: "array",
                            children: [
                              {
                                type: "node",
                                children: [
                                  {
                                    type: "node",
                                    children: [
                                      {
                                        type: "string",
                                        startPos: {
                                          row: 1,
                                          col: 0,
                                        },
                                        endPos: {
                                          row: 1,
                                          col: 35,
                                        },
                                        content:
                                          "Can you look at my list of buffers?",
                                      },
                                    ],
                                    startPos: {
                                      row: 1,
                                      col: 0,
                                    },
                                    endPos: {
                                      row: 1,
                                      col: 35,
                                    },
                                  },
                                  {
                                    type: "string",
                                    startPos: {
                                      row: 1,
                                      col: 35,
                                    },
                                    endPos: {
                                      row: 2,
                                      col: 0,
                                    },
                                    content: "\n",
                                  },
                                ],
                                startPos: {
                                  row: 1,
                                  col: 0,
                                },
                                endPos: {
                                  row: 2,
                                  col: 0,
                                },
                              },
                            ],
                            startPos: {
                              row: 1,
                              col: 0,
                            },
                            endPos: {
                              row: 2,
                              col: 0,
                            },
                          },
                        ],
                        startPos: {
                          row: 0,
                          col: 0,
                        },
                        endPos: {
                          row: 2,
                          col: 0,
                        },
                      },
                      {
                        type: "string",
                        startPos: {
                          row: 2,
                          col: 0,
                        },
                        endPos: {
                          row: 3,
                          col: 0,
                        },
                        content: "\n",
                      },
                    ],
                    startPos: {
                      row: 0,
                      col: 0,
                    },
                    endPos: {
                      row: 3,
                      col: 0,
                    },
                  },
                  {
                    type: "node",
                    children: [
                      {
                        type: "node",
                        children: [
                          {
                            type: "string",
                            startPos: {
                              row: 3,
                              col: 0,
                            },
                            endPos: {
                              row: 3,
                              col: 4,
                            },
                            content: "### ",
                          },
                          {
                            type: "string",
                            startPos: {
                              row: 3,
                              col: 4,
                            },
                            endPos: {
                              row: 3,
                              col: 13,
                            },
                            content: "assistant",
                          },
                          {
                            type: "string",
                            startPos: {
                              row: 3,
                              col: 13,
                            },
                            endPos: {
                              row: 4,
                              col: 0,
                            },
                            content: ":\n",
                          },
                          {
                            type: "array",
                            children: [
                              {
                                type: "node",
                                children: [
                                  {
                                    type: "node",
                                    children: [
                                      {
                                        type: "string",
                                        startPos: {
                                          row: 4,
                                          col: 0,
                                        },
                                        endPos: {
                                          row: 4,
                                          col: 39,
                                        },
                                        content:
                                          "Sure, let me use the list-buffers tool.",
                                      },
                                    ],
                                    startPos: {
                                      row: 4,
                                      col: 0,
                                    },
                                    endPos: {
                                      row: 4,
                                      col: 39,
                                    },
                                  },
                                  {
                                    type: "string",
                                    startPos: {
                                      row: 4,
                                      col: 39,
                                    },
                                    endPos: {
                                      row: 5,
                                      col: 0,
                                    },
                                    content: "\n",
                                  },
                                ],
                                startPos: {
                                  row: 4,
                                  col: 0,
                                },
                                endPos: {
                                  row: 5,
                                  col: 0,
                                },
                              },
                              {
                                type: "node",
                                children: [
                                  {
                                    type: "node",
                                    children: [
                                      {
                                        type: "string",
                                        startPos: {
                                          row: 5,
                                          col: 0,
                                        },
                                        endPos: {
                                          row: 5,
                                          col: 26,
                                        },
                                        content: "⚙️ Grabbing buffers...",
                                      },
                                    ],
                                    startPos: {
                                      row: 5,
                                      col: 0,
                                    },
                                    endPos: {
                                      row: 5,
                                      col: 26,
                                    },
                                  },
                                  {
                                    type: "string",
                                    startPos: {
                                      row: 5,
                                      col: 26,
                                    },
                                    endPos: {
                                      row: 6,
                                      col: 0,
                                    },
                                    content: "\n",
                                  },
                                ],
                                startPos: {
                                  row: 5,
                                  col: 0,
                                },
                                endPos: {
                                  row: 6,
                                  col: 0,
                                },
                              },
                            ],
                            startPos: {
                              row: 4,
                              col: 0,
                            },
                            endPos: {
                              row: 6,
                              col: 0,
                            },
                          },
                        ],
                        startPos: {
                          row: 3,
                          col: 0,
                        },
                        endPos: {
                          row: 6,
                          col: 0,
                        },
                      },
                      {
                        type: "string",
                        startPos: {
                          row: 6,
                          col: 0,
                        },
                        endPos: {
                          row: 7,
                          col: 0,
                        },
                        content: "\n",
                      },
                    ],
                    startPos: {
                      row: 3,
                      col: 0,
                    },
                    endPos: {
                      row: 7,
                      col: 0,
                    },
                  },
                ],
                startPos: {
                  row: 0,
                  col: 0,
                },
                endPos: {
                  row: 7,
                  col: 0,
                },
              },
            ],
            startPos: {
              row: 0,
              col: 0,
            },
            endPos: {
              row: 7,
              col: 0,
            },
          },
        ],
        startPos: {
          row: 0,
          col: 0,
        },
        endPos: {
          row: 7,
          col: 0,
        },
      },
    );

    app.dispatch({
      type: "tool-manager-msg",
      msg: {
        type: "tool-msg",
        id: "request-id" as ToolRequestId,
        msg: {
          type: "list-buffers",
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

    assert.deepStrictEqual(
      await buffer.getLines({ start: 0, end: -1, strictIndexing: false }),
      [
        "### user:",
        "Can you look at my list of buffers?",
        "",
        "### assistant:",
        "Sure, let me use the list-buffers tool.",
        "✅ Finished getting buffers.",
        "",
        "",
      ],
      "in-progress render is as expected",
    );
  });
});

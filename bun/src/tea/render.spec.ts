/* eslint-disable @typescript-eslint/no-floating-promises */
import { extractMountTree, NeovimTestHelper } from "../../test/preamble.ts";
import { d, mountView, pos } from "./view.ts";
import * as assert from "assert";
import { describe, before, beforeEach, afterEach, it } from "node:test";
import { NvimBuffer } from "../nvim/buffer.ts";

await describe("tea/render.spec.ts", () => {
  let helper: NeovimTestHelper;
  let buffer: NvimBuffer;

  before(() => {
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

  it("rendering empty string", async () => {
    const view = () => d`1${""}2`;
    const mountedView = await mountView({
      view,
      props: {},
      mount: {
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, 0),
      },
    });

    const lines = await buffer.getLines({
      start: 0,
      end: 1,
    });

    assert.equal(lines[0], "12");

    assert.deepStrictEqual(
      await extractMountTree(mountedView._getMountedNode()),
      {
        type: "node",
        startPos: {
          row: 0,
          col: 0,
        },
        endPos: {
          row: 0,
          col: 2,
        },
        children: [
          {
            content: "1",
            startPos: {
              col: 0,
              row: 0,
            },
            endPos: {
              col: 1,
              row: 0,
            },
            type: "string",
          },
          {
            content: "",
            startPos: {
              col: 1,
              row: 0,
            },
            endPos: {
              col: 1,
              row: 0,
            },
            type: "string",
          },
          {
            content: "2",
            startPos: {
              col: 1,
              row: 0,
            },
            endPos: {
              col: 2,
              row: 0,
            },
            type: "string",
          },
        ],
      },
    );
  });

  it("rendering multi-line interpolation", async () => {
    const multiLineValue = `first line
second line
third line`;
    const view = () => d`before${multiLineValue}after`;
    const mountedView = await mountView({
      view,
      props: {},
      mount: {
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, 0),
      },
    });

    const lines = await buffer.getLines({
      start: 0,
      end: 4,
    });

    assert.deepStrictEqual(lines, [
      "beforefirst line",
      "second line",
      "third lineafter",
    ]);

    assert.deepStrictEqual(
      await extractMountTree(mountedView._getMountedNode()),
      {
        type: "node",
        startPos: {
          row: 0,
          col: 0,
        },
        endPos: {
          row: 2,
          col: 15,
        },
        children: [
          {
            content: "before",
            startPos: {
              col: 0,
              row: 0,
            },
            endPos: {
              col: 6,
              row: 0,
            },
            type: "string",
          },
          {
            content: "first line\nsecond line\nthird line",
            startPos: {
              row: 0,
              col: 6,
            },
            endPos: {
              row: 2,
              col: 10,
            },
            type: "string",
          },
          {
            content: "after",
            startPos: {
              row: 2,
              col: 10,
            },
            endPos: {
              row: 2,
              col: 15,
            },
            type: "string",
          },
        ],
      },
    );
  });

  it("rendering multi-line template with interpolation", async () => {
    const name = "world";
    const view = () => d`
      Hello
        ${name}
      Goodbye
    `;
    const mountedView = await mountView({
      view,
      props: {},
      mount: {
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, 0),
      },
    });

    const lines = await buffer.getLines({
      start: 0,
      end: 5,
    });

    assert.deepStrictEqual(lines, [
      "",
      "      Hello",
      "        world",
      "      Goodbye",
      "    ",
    ]);

    assert.deepStrictEqual(
      await extractMountTree(mountedView._getMountedNode()),
      {
        type: "node",
        startPos: {
          row: 0,
          col: 0,
        },
        endPos: {
          row: 4,
          col: 4,
        },
        children: [
          {
            content: "\n      Hello\n        ",
            startPos: {
              col: 0,
              row: 0,
            },
            endPos: {
              col: 8,
              row: 2,
            },
            type: "string",
          },
          {
            content: "world",
            startPos: {
              col: 8,
              row: 2,
            },
            endPos: {
              col: 13,
              row: 2,
            },
            type: "string",
          },
          {
            content: "\n      Goodbye\n    ",
            startPos: {
              col: 13,
              row: 2,
            },
            endPos: {
              col: 4,
              row: 4,
            },
            type: "string",
          },
        ],
      },
    );
  });

  it("rendering nested interpolation", async () => {
    const inner = d`(inner)`;
    const view = () => d`outer${inner}end`;
    const mountedView = await mountView({
      view,
      props: {},
      mount: {
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, 0),
      },
    });

    const lines = await buffer.getLines({
      start: 0,
      end: 1,
    });

    assert.equal(lines[0], "outer(inner)end");

    assert.deepStrictEqual(
      await extractMountTree(mountedView._getMountedNode()),
      {
        type: "node",
        startPos: {
          row: 0,
          col: 0,
        },
        endPos: {
          row: 0,
          col: 15,
        },
        children: [
          {
            content: "outer",
            startPos: {
              row: 0,
              col: 0,
            },
            endPos: {
              row: 0,
              col: 5,
            },
            type: "string",
          },
          {
            type: "node",
            startPos: {
              row: 0,
              col: 5,
            },
            endPos: {
              row: 0,
              col: 12,
            },
            children: [
              {
                content: "(inner)",
                startPos: {
                  row: 0,
                  col: 5,
                },
                endPos: {
                  row: 0,
                  col: 12,
                },
                type: "string",
              },
            ],
          },
          {
            content: "end",
            startPos: {
              col: 12,
              row: 0,
            },
            endPos: {
              col: 15,
              row: 0,
            },
            type: "string",
          },
        ],
      },
    );
  });

  it("rendering empty array", async () => {
    const view = ({ arr }: { arr: string[] }) => d`${arr.map((c) => d`${c}`)}`;
    const mountedView = await mountView({
      view,
      props: { arr: [] },
      mount: {
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, 0),
      },
    });

    const lines = await buffer.getLines({
      start: 0,
      end: 1,
    });

    assert.equal(lines[0], "");

    assert.deepStrictEqual(
      await extractMountTree(mountedView._getMountedNode()),
      {
        type: "node",
        startPos: {
          row: 0,
          col: 0,
        },
        endPos: {
          row: 0,
          col: 0,
        },
        children: [
          {
            children: [],
            endPos: {
              col: 0,
              row: 0,
            },
            startPos: {
              col: 0,
              row: 0,
            },
            type: "array",
          },
        ],
      },
    );
  });

  it("rendering array", async () => {
    const view = ({ arr }: { arr: string[] }) => d`${arr.map((c) => d`${c}`)}`;
    const mountedView = await mountView({
      view,
      props: { arr: ["1", "\n", "2"] },
      mount: {
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, 0),
      },
    });

    const lines = await buffer.getLines({
      start: 0,
      end: 2,
    });

    assert.deepStrictEqual(lines, ["1", "2"]);

    assert.deepStrictEqual(
      await extractMountTree(mountedView._getMountedNode()),
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
                    type: "string",
                    content: "1",
                    startPos: {
                      row: 0,
                      col: 0,
                    },
                    endPos: {
                      row: 0,
                      col: 1,
                    },
                  },
                ],
                startPos: {
                  row: 0,
                  col: 0,
                },
                endPos: {
                  row: 0,
                  col: 1,
                },
              },
              {
                type: "node",
                children: [
                  {
                    type: "string",
                    content: "\n",
                    startPos: {
                      row: 0,
                      col: 1,
                    },
                    endPos: {
                      row: 1,
                      col: 0,
                    },
                  },
                ],
                startPos: {
                  row: 0,
                  col: 1,
                },
                endPos: {
                  row: 1,
                  col: 0,
                },
              },
              {
                type: "node",
                children: [
                  {
                    type: "string",
                    content: "2",
                    startPos: {
                      row: 1,
                      col: 0,
                    },
                    endPos: {
                      row: 1,
                      col: 1,
                    },
                  },
                ],
                startPos: {
                  row: 1,
                  col: 0,
                },
                endPos: {
                  row: 1,
                  col: 1,
                },
              },
            ],
            startPos: {
              row: 0,
              col: 0,
            },
            endPos: {
              row: 1,
              col: 1,
            },
          },
        ],
        startPos: {
          row: 0,
          col: 0,
        },
        endPos: {
          row: 1,
          col: 1,
        },
      },
    );
  });
});

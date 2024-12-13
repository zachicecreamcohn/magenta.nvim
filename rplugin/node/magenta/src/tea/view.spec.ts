import type { NeovimClient, Buffer } from "neovim";
import { NeovimTestHelper } from "../../test/preamble.js";
import { d, MountedVDOM, mountView } from "./view.js";
import * as assert from "assert";
import { test } from "node:test";
import { assertUnreachable } from "../utils/assertUnreachable.js";

await test.describe("Neovim Plugin Tests", async () => {
  let helper: NeovimTestHelper;
  let nvim: NeovimClient;

  test.before(() => {
    helper = new NeovimTestHelper();
  });

  test.beforeEach(async () => {
    nvim = await helper.startNvim();
  });

  test.afterEach(() => {
    helper.stopNvim();
  });

  await test("basic rendering & update", async () => {
    console.log("in test");
    const buffer = (await nvim.createBuffer(false, true)) as Buffer;
    await buffer.setLines([""], { start: 0, end: 0, strictIndexing: false });
    const namespace = await nvim.createNamespace("test");

    await buffer.setOption("modifiable", false);

    const view = (props: { helloTo: string }) => d`hello, ${props.helloTo}!`;
    const mountedView = await mountView({
      view,
      props: { helloTo: "world" },
      mount: {
        nvim,
        buffer,
        namespace,
        startPos: { row: 0, col: 0 },
        endPos: { row: 0, col: 0 },
      },
    });

    const lines = await buffer.getLines({
      start: 0,
      end: 1,
      strictIndexing: false,
    });

    assert.equal(lines[0], "hello, world!");

    assert.deepStrictEqual(
      await extractMountTree(mountedView._getMountedNode()),
      {
        type: "node",
        endPos: {
          col: 13,
          row: 0,
        },
        startPos: {
          col: 0,
          row: 0,
        },
        children: [
          {
            content: "hello, ",
            startPos: {
              col: 0,
              row: 0,
            },
            endPos: {
              col: 7,
              row: 0,
            },
            type: "string",
          },
          {
            content: "world",
            startPos: {
              col: 7,
              row: 0,
            },
            endPos: {
              col: 12,
              row: 0,
            },
            type: "string",
          },
          {
            content: "!",
            startPos: {
              col: 12,
              row: 0,
            },
            endPos: {
              col: 13,
              row: 0,
            },
            type: "string",
          },
        ],
      },
    );

    await mountedView.render({ helloTo: "nvim" });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 1,
        strictIndexing: false,
      });

      assert.equal(lines[0], "hello, nvim!");
    }

    assert.deepStrictEqual(
      await extractMountTree(mountedView._getMountedNode()),
      {
        type: "node",
        endPos: {
          col: 12,
          row: 0,
        },
        startPos: {
          col: 0,
          row: 0,
        },
        children: [
          {
            content: "hello, ",
            startPos: {
              col: 0,
              row: 0,
            },
            endPos: {
              col: 7,
              row: 0,
            },
            type: "string",
          },
          {
            content: "nvim",
            startPos: {
              col: 7,
              row: 0,
            },
            endPos: {
              col: 11,
              row: 0,
            },
            type: "string",
          },
          {
            content: "!",
            startPos: {
              col: 11,
              row: 0,
            },
            endPos: {
              col: 12,
              row: 0,
            },
            type: "string",
          },
        ],
      },
    );
  });
});

function extractMountTree(mounted: MountedVDOM): unknown {
  switch (mounted.type) {
    case "string":
      return mounted;
    case "node":
      return {
        type: "node",
        children: mounted.children.map(extractMountTree),
        startPos: mounted.startPos,
        endPos: mounted.endPos,
      };
    default:
      assertUnreachable(mounted);
  }
}

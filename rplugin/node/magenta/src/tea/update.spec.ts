import type { NeovimClient, Buffer } from "neovim";
import { NeovimTestHelper } from "../../test/preamble.js";
import { d, mountView } from "./view.js";
import * as assert from "assert";
import { test } from "node:test";

await test.describe("tea/update.spec.ts", async () => {
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

  await test("updates to and from empty string", async () => {
    const view = (props: { prop: string }) => d`1${props.prop}3`;
    const mountedView = await mountView({
      view,
      props: { prop: "" },
      mount: {
        nvim,
        buffer,
        startPos: { row: 0, col: 0 },
        endPos: { row: 0, col: 0 },
      },
    });

    {
      const lines = await buffer.getLines({
        start: 0,
        end: 1,
        strictIndexing: false,
      });

      assert.equal(lines[0], "13");
    }

    await mountedView.render({ prop: "2" });

    {
      const lines = await buffer.getLines({
        start: 0,
        end: 1,
        strictIndexing: false,
      });

      assert.equal(lines[0], "123");
    }

    await mountedView.render({ prop: "" });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 1,
        strictIndexing: false,
      });

      assert.equal(lines[0], "13");
    }

    await mountedView.render({ prop: "\n" });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 2,
        strictIndexing: false,
      });

      assert.deepStrictEqual(lines, ["1", "3"]);
    }

    await mountedView.render({ prop: "" });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 2,
        strictIndexing: false,
      });

      assert.deepStrictEqual(lines, ["13"]);
    }
  });

  await test("updates to multiple items in the same line", async () => {
    const view = (props: { prop1: string; prop2: string }) =>
      d`${props.prop1}${props.prop2}`;
    const mountedView = await mountView({
      view,
      props: { prop1: "", prop2: "" },
      mount: {
        nvim,
        buffer,
        startPos: { row: 0, col: 0 },
        endPos: { row: 0, col: 0 },
      },
    });

    {
      const lines = await buffer.getLines({
        start: 0,
        end: 1,
        strictIndexing: false,
      });

      assert.equal(
        lines[0],
        "",
        "should handle multiple empty interpolations in a row",
      );
    }

    await mountedView.render({ prop1: "1", prop2: "2" });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 1,
        strictIndexing: false,
      });

      assert.equal(
        lines[0],
        "12",
        "should handle going from empty to segments on the same line",
      );
    }

    await mountedView.render({ prop1: "11", prop2: "22" });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 1,
        strictIndexing: false,
      });

      assert.equal(
        lines[0],
        "1122",
        "should handle growing multiple segments on the same line",
      );
    }

    await mountedView.render({ prop1: "1", prop2: "2" });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 1,
        strictIndexing: false,
      });

      assert.equal(
        lines[0],
        "12",
        "should handle shrinking multiple segments on the same line",
      );
    }

    await mountedView.render({ prop1: "1", prop2: "2" });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 1,
        strictIndexing: false,
      });

      assert.equal(
        lines[0],
        "12",
        "should handle shrinking multiple segments on the same line",
      );
    }

    await mountedView.render({ prop1: "1\n111", prop2: "22" });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 2,
        strictIndexing: false,
      });

      assert.deepStrictEqual(lines, ["1", "11122"]);
    }

    await mountedView.render({ prop1: "\n1\n1\n", prop2: "\n2\n2" });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 6,
        strictIndexing: false,
      });

      assert.deepStrictEqual(
        lines,
        ["", "1", "1", "", "2", "2"],
        "should handle updating a prop on a moving line",
      );
    }
  });
});

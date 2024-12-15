/* eslint-disable @typescript-eslint/no-floating-promises */
import type { NeovimClient, Buffer } from "neovim";
import { NeovimTestHelper } from "../../test/preamble.ts";
import { d, mountView } from "./view.ts";
import * as assert from "assert";
import { describe, it, before, beforeEach, afterEach } from "node:test";

describe("tea/update.spec.ts", () => {
  let helper: NeovimTestHelper;
  let nvim: NeovimClient;
  let buffer: Buffer;

  before(() => {
    helper = new NeovimTestHelper();
  });

  beforeEach(async () => {
    nvim = await helper.startNvim();
    buffer = (await nvim.createBuffer(false, true)) as Buffer;
    await buffer.setOption("modifiable", false);
  });

  afterEach(() => {
    helper.stopNvim();
  });

  it("updates to and from empty string", async () => {
    const view = (props: { prop: string }) => d`1${props.prop}3`;
    const mountedView = await mountView({
      view,
      props: { prop: "" },
      mount: {
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

  it("updates to multiple items in the same line", async () => {
    const view = (props: { prop1: string; prop2: string }) =>
      d`${props.prop1}${props.prop2}`;
    const mountedView = await mountView({
      view,
      props: { prop1: "", prop2: "" },
      mount: {
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

  it("array nodes", async () => {
    const view = (props: { items: string[] }) =>
      d`${props.items.map((s) => d`${s}`)}`;

    const mountedView = await mountView<{ items: string[] }>({
      view,
      props: { items: [] },
      mount: {
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

    await mountedView.render({ items: ["1", "2"] });
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

    await mountedView.render({ items: [] });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 1,
        strictIndexing: false,
      });

      assert.equal(lines[0], "", "should handle shortened array");
    }

    await mountedView.render({ items: ["1\n1\n1\n", "2\n2"] });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: -1,
        strictIndexing: false,
      });

      assert.deepStrictEqual(
        lines,
        ["1", "1", "1", "2", "2"],
        "should handle multiline array items",
      );
    }

    await mountedView.render({ items: ["1\n1\n11", "22\n2"] });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: -1,
        strictIndexing: false,
      });

      assert.deepStrictEqual(
        lines,
        ["1", "1", "1122", "2"],
        "should handle multiline array updates",
      );
    }
  });
});

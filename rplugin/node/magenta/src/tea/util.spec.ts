/* eslint-disable @typescript-eslint/no-floating-promises */
import type { NeovimClient, Buffer as NvimBuffer } from "neovim";
import { NeovimTestHelper } from "../../test/preamble.ts";
import * as assert from "node:assert";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import {
  calculatePosition,
  replaceBetweenPositions,
  strWidthInBytes,
} from "./util.ts";
import { Line } from "../chat/part.ts";
import { pos } from "./view.ts";

describe.only("tea/util.spec.ts", () => {
  let helper: NeovimTestHelper;
  let nvim: NeovimClient;
  let buffer: NvimBuffer;

  before(() => {
    helper = new NeovimTestHelper();
  });

  beforeEach(async () => {
    nvim = await helper.startNvim();
    buffer = (await nvim.createBuffer(false, true)) as NvimBuffer;
  });

  afterEach(() => {
    helper.stopNvim();
  });

  it("strWidthInBytes", async () => {
    const symbols = ["", "a", "⚙️", "⏳", "⚠️", "👀", "✅"];
    const expectedWidths = [0, 1, 6, 3, 6, 4, 3];
    for (let idx = 0; idx < symbols.length; idx += 1) {
      assert.equal(
        strWidthInBytes(symbols[idx]),
        expectedWidths[idx],
        symbols[idx],
      );
    }

    await buffer.setLines(symbols, {
      start: 0,
      end: -1,
      strictIndexing: false,
    });

    await nvim.lua(
      `function getLineWidth(lineIdx) return #(vim.api.nvim_buf_get_lines(${buffer.id}, lineIdx, lineIdx + 1, false)[1]) end`,
    );

    for (let idx = 0; idx < symbols.length; idx += 1) {
      assert.equal(
        await nvim.lua(`return getLineWidth(${idx})`),
        expectedWidths[idx],
        `len("${symbols[idx]}")`,
      );
    }
  });

  it("calculatePosition", () => {
    assert.deepStrictEqual(
      calculatePosition(pos(0, 0), Buffer.from(""), 0),
      { row: 0, col: 0 },
      "empty string",
    );

    assert.deepStrictEqual(
      calculatePosition(pos(1, 5), Buffer.from(""), 0),
      { row: 1, col: 5 },
      "empty string from non-0 pos",
    );

    assert.deepStrictEqual(
      calculatePosition(pos(1, 5), Buffer.from("abc"), 2),
      { row: 1, col: 7 },
      "move within the same string",
    );

    assert.deepStrictEqual(
      calculatePosition(pos(1, 5), Buffer.from("⚙️"), 6),
      { row: 1, col: 11 },
      "move within the same string, unicode",
    );
    assert.deepStrictEqual(
      calculatePosition(pos(1, 5), Buffer.from(`abc\n`), 4),
      { row: 2, col: 0 },
      "move to a new line",
    );

    assert.deepStrictEqual(
      calculatePosition(pos(1, 5), Buffer.from("⚙️\n"), 7),
      { row: 2, col: 0 },
      "move to a new line after unicode",
    );

    assert.deepStrictEqual(
      calculatePosition(pos(1, 5), Buffer.from("⚙️\nabc"), 10),
      { row: 2, col: 3 },
      "move to a new line and then a few characters after",
    );
  });

  it("replacing a single line", async () => {
    await buffer.setLines(["abcdef"], {
      start: 0,
      end: -1,
      strictIndexing: false,
    });

    await buffer.setOption("modifiable", false);
    await replaceBetweenPositions({
      buffer,
      startPos: pos(0, 0),
      endPos: pos(0, 3),
      lines: ["1"] as Line[],
    });

    {
      const lines = await buffer.getLines({
        start: 0,
        end: -1,
        strictIndexing: false,
      });
      assert.equal(lines.join("\n"), "1def", "replacing a single line string");
    }
  });

  it("replacing unicode", async () => {
    const str = "⚙️";
    await buffer.setLines([str], {
      start: 0,
      end: -1,
      strictIndexing: false,
    });

    await buffer.setOption("modifiable", false);
    await replaceBetweenPositions({
      buffer,
      startPos: pos(0, 0),
      endPos: pos(0, strWidthInBytes(str)),
      lines: ["✅"] as Line[],
    });

    {
      const lines = await buffer.getLines({
        start: 0,
        end: -1,
        strictIndexing: false,
      });
      assert.equal(lines.join("\n"), "✅", "replacing unicode");
    }
  });

  it("replacing across multiple lines", async () => {
    await buffer.setLines(["abcdef", "hijklm"], {
      start: 0,
      end: -1,
      strictIndexing: false,
    });

    await buffer.setOption("modifiable", false);
    await replaceBetweenPositions({
      buffer,
      startPos: pos(0, 3),
      endPos: pos(1, 3),
      lines: ["1", "2"] as Line[],
    });

    {
      const lines = await buffer.getLines({
        start: 0,
        end: -1,
        strictIndexing: false,
      });
      assert.equal(
        lines.join("\n"),
        `abc1\n2klm`,
        "replacing with a shorter string shrinks the rest of the string",
      );
    }
  });
});

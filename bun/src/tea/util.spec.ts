/* eslint-disable @typescript-eslint/no-floating-promises */
import type { Nvim } from "bunvim";
import { NeovimTestHelper } from "../../test/preamble.ts";
import * as assert from "node:assert";
import { describe, it, beforeAll, beforeEach, afterEach } from "bun:test";
import {
  calculatePosition,
  replaceBetweenPositions,
  strWidthInBytes,
} from "./util.ts";
import { pos } from "./view.ts";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";

describe.only("tea/util.spec.ts", () => {
  let helper: NeovimTestHelper;
  let nvim: Nvim;
  let buffer: NvimBuffer;

  beforeAll(() => {
    helper = new NeovimTestHelper();
  });

  beforeEach(async () => {
    nvim = await helper.startNvim();
    buffer = await NvimBuffer.create(false, true);
  });

  afterEach(() => {
    helper.stopNvim();
  });

  it("strWidthInBytes", async () => {
    const symbols = ["", "a", "⚙️", "⏳", "⚠️", "👀", "✅"] as Line[];
    const expectedWidths = [0, 1, 6, 3, 6, 4, 3];
    for (let idx = 0; idx < symbols.length; idx += 1) {
      assert.equal(
        strWidthInBytes(symbols[idx]),
        expectedWidths[idx],
        symbols[idx],
      );
    }

    await buffer.setLines({
      start: 0,
      end: -1,
      lines: symbols,
    });

    await nvim.call("nvim_exec_lua", [
      `function getLineWidth(lineIdx) return #(vim.api.nvim_buf_get_lines(${buffer.id}, lineIdx, lineIdx + 1, false)[1]) end`,
      [],
    ]);

    for (let idx = 0; idx < symbols.length; idx += 1) {
      assert.equal(
        await nvim.call("nvim_exec_lua", [`return getLineWidth(${idx})`, []]),
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
    await buffer.setLines({
      start: 0,
      end: -1,
      lines: ["abcdef"] as Line[],
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
      });
      assert.equal(lines.join("\n"), "1def", "replacing a single line string");
    }
  });

  it("replacing unicode", async () => {
    const str = "⚙️";
    await buffer.setLines({
      lines: [str] as Line[],
      start: 0,
      end: -1,
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
      });
      assert.equal(lines.join("\n"), "✅", "replacing unicode");
    }
  });

  it("replacing across multiple lines", async () => {
    await buffer.setLines({
      lines: ["abcdef", "hijklm"] as Line[],
      start: 0,
      end: -1,
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
      });
      assert.equal(
        lines.join("\n"),
        `abc1\n2klm`,
        "replacing with a shorter string shrinks the rest of the string",
      );
    }
  });
});

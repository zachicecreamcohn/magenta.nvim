/* eslint-disable @typescript-eslint/no-floating-promises */
import type { NeovimClient, Buffer as NvimBuffer } from "neovim";
import { NeovimTestHelper } from "../../test/preamble.ts";
import * as assert from "node:assert";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import { replaceBetweenPositions } from "./util.ts";
import { Line } from "../chat/part.ts";

describe("tea/util.spec.ts", () => {
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

  it("replacing a single line", async () => {
    await buffer.setLines(["abcdef"], {
      start: 0,
      end: -1,
      strictIndexing: false,
    });

    await buffer.setOption("modifiable", false);
    await replaceBetweenPositions({
      buffer,
      startPos: { row: 0, col: 0 },
      endPos: { row: 0, col: 3 },
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
      startPos: { row: 0, col: 0 },
      endPos: { row: 0, col: Buffer.byteLength(str, "utf8") },
      lines: ["✅"] as Line[],
    });

    {
      const lines = await buffer.getLines({
        start: 0,
        end: -1,
        strictIndexing: false,
      });
      assert.equal(lines.join("\n"), "✅", "replacing a single line string");
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
      startPos: { row: 0, col: 3 },
      endPos: { row: 1, col: 3 },
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

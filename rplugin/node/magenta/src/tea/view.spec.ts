import type { NeovimClient, Buffer } from "neovim";
import { NeovimTestHelper } from "../../test/preamble.js";
import { d, mountView } from "./view.js";
import { setExtMark } from "../utils/extmarks.js";
import * as assert from "assert";
import { test } from "node:test";

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

  await test.it("basic rendering", async () => {
    const buffer = (await nvim.createBuffer(false, true)) as Buffer;
    await buffer.setLines([" "], { start: 0, end: 0, strictIndexing: false });
    const namespace = await nvim.createNamespace("test");

    const startMark = await setExtMark({
      nvim,
      buffer,
      namespace,
      row: 0,
      col: 0,
    });
    const endMark = await setExtMark({
      nvim,
      buffer,
      namespace,
      row: 0,
      col: 1,
    });

    await buffer.setOption("modifiable", false);

    const view = () => d`hello, world!`;
    await mountView({
      view,
      props: {},
      mount: {
        nvim,
        buffer,
        namespace,
        startMark,
        endMark,
      },
    });

    const lines = await buffer.getLines({
      start: 0,
      end: 1,
      strictIndexing: false,
    });

    assert.equal(lines[0], " hello, world!");
  });
});

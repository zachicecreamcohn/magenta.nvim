import { extractMountTree, withNvimClient } from "../../test/preamble.ts";
import { d, mountView, pos } from "./view.ts";
import { describe, expect, it } from "bun:test";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";

describe("tea/render.spec.ts", () => {
  it("rendering empty string", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = () => d`1${""}2`;
      const mountedView = await mountView({
        view,
        props: {},
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0,
        end: 1,
      });

      expect(lines[0]).toEqual("12" as Line);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });

  it("rendering multi-line interpolation", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const multiLineValue = `first line
second line
third line`;
      const view = () => d`before${multiLineValue}after`;
      const mountedView = await mountView({
        view,
        props: {},
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0,
        end: 4,
      });

      expect(lines).toEqual([
        "beforefirst line",
        "second line",
        "third lineafter",
      ] as Line[]);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });

  it("rendering multi-line template with interpolation", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

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
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0,
        end: 5,
      });

      expect(lines).toEqual([
        "",
        "      Hello",
        "        world",
        "      Goodbye",
        "    ",
      ] as Line[]);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });

  it("rendering nested interpolation", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const inner = d`(inner)`;
      const view = () => d`outer${inner}end`;
      const mountedView = await mountView({
        view,
        props: {},
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0,
        end: 1,
      });

      expect(lines[0]).toEqual("outer(inner)end" as Line);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });

  it("rendering empty array", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = ({ arr }: { arr: string[] }) =>
        d`${arr.map((c) => d`${c}`)}`;
      const mountedView = await mountView({
        view,
        props: { arr: [] },
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0,
        end: 1,
      });

      expect(lines[0]).toEqual("" as Line);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });

  it("rendering array", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = ({ arr }: { arr: string[] }) =>
        d`${arr.map((c) => d`${c}`)}`;
      const mountedView = await mountView({
        view,
        props: { arr: ["1", "\n", "2"] },
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0,
        end: 2,
      });

      expect(lines).toEqual(["1", "2"] as Line[]);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });
});

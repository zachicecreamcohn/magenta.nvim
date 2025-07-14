import { extractMountTree, withNvimClient } from "../test/preamble.ts";
import {
  d,
  mountView,
  pos,
  withExtmark,
  withError,
  withWarning,
} from "./view.ts";
import { describe, expect, it } from "vitest";
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

  it("rendering with basic highlights", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = () =>
        d`${withError(d`Error text`)} and ${withWarning(d`Warning text`)}`;
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

      expect(lines[0]).toEqual("Error text and Warning text" as Line);

      // Check that extmarks were created
      const mountedNode = mountedView._getMountedNode();
      expect(mountedNode.type).toBe("node");
      if (mountedNode.type === "node") {
        // Should have extmarks on error and warning nodes
        const errorNode = mountedNode.children[0];
        const warningNode = mountedNode.children[2];

        expect(errorNode.extmarkOptions).toEqual({ hl_group: "ErrorMsg" });
        expect(errorNode.extmarkId).toBeDefined();
        expect(errorNode.extmarkId).not.toBe(-1);

        expect(warningNode.extmarkOptions).toEqual({ hl_group: "WarningMsg" });
        expect(warningNode.extmarkId).toBeDefined();
        expect(warningNode.extmarkId).not.toBe(-1);
      }
    });
  });

  it("rendering with custom extmark options", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = () =>
        d`${withExtmark(d`Highlighted text`, {
          hl_group: "String",
          priority: 200,
          sign_text: "!!",
          sign_hl_group: "ErrorMsg",
        })}`;

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

      expect(lines[0]).toEqual("Highlighted text" as Line);

      // Check that extmark was created with correct options
      const mountedNode = mountedView._getMountedNode();
      expect(mountedNode.type).toBe("node");
      if (mountedNode.type === "node") {
        const highlightedNode = mountedNode.children[0];
        expect(highlightedNode.extmarkOptions).toEqual({
          hl_group: "String",
          priority: 200,
          sign_text: "!!",
          sign_hl_group: "ErrorMsg",
        });
        expect(highlightedNode.extmarkId).toBeDefined();
        expect(highlightedNode.extmarkId).not.toBe(-1);
      }
    });
  });

  it("rendering nested highlights", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = () => withError(d`Error: ${withWarning(d`warning`)} inside`);
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

      expect(lines[0]).toEqual("Error: warning inside" as Line);

      // Check that both parent and child extmarks were created
      const mountedNode = mountedView._getMountedNode();
      expect(mountedNode.extmarkOptions).toEqual({ hl_group: "ErrorMsg" });
      expect(mountedNode.extmarkId).toBeDefined();
      expect(mountedNode.extmarkId).not.toBe(-1);

      if (mountedNode.type === "node") {
        const warningNode = mountedNode.children[1];
        expect(warningNode.extmarkOptions).toEqual({ hl_group: "WarningMsg" });
        expect(warningNode.extmarkId).toBeDefined();
        expect(warningNode.extmarkId).not.toBe(-1);
      }
    });
  });

  it("rendering empty content with highlights should not create extmarks", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = () => d`${withError(d``)}end`;
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

      expect(lines[0]).toEqual("end" as Line);

      // Empty content should not create extmarks
      const mountedNode = mountedView._getMountedNode();
      if (mountedNode.type === "node") {
        const emptyNode = mountedNode.children[0];
        expect(emptyNode.extmarkId).toBeUndefined();
      }
    });
  });
});

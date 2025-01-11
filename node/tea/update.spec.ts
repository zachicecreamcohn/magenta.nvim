import { d, mountView, pos } from "./view.ts";
import { describe, expect, it } from "bun:test";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";
import { extractMountTree, withNvimClient } from "../test/preamble.ts";

describe("tea/update.spec.ts", () => {
  it("updates to and from empty string", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);
      const view = (props: { prop: string }) => d`1${props.prop}3`;
      const mountedView = await mountView({
        view,
        props: { prop: "" },
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(lines[0]).toEqual("13" as Line);
      }

      await mountedView.render({ prop: "2" });

      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(lines[0]).toEqual("123" as Line);
      }

      await mountedView.render({ prop: "" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(lines[0]).toEqual("13" as Line);
      }

      await mountedView.render({ prop: "\n" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 2,
        });

        expect(lines).toEqual(["1", "3"] as Line[]);
      }

      await mountedView.render({ prop: "" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 2,
        });

        expect(lines).toEqual(["13"] as Line[]);
      }
    });
  });

  it("updates to multiple items in the same line", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = (props: { prop1: string; prop2: string }) =>
        d`${props.prop1}${props.prop2}`;
      const mountedView = await mountView({
        view,
        props: { prop1: "", prop2: "" },
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(
          lines[0],
          "should handle multiple empty interpolations in a row",
        ).toEqual("" as Line);
      }

      await mountedView.render({ prop1: "1", prop2: "2" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(
          lines[0],
          "should handle going from empty to segments on the same line",
        ).toEqual("12" as Line);
      }

      await mountedView.render({ prop1: "11", prop2: "22" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(
          lines[0],
          "should handle growing multiple segments on the same line",
        ).toEqual("1122" as Line);
      }

      await mountedView.render({ prop1: "1", prop2: "2" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(
          lines[0],
          "should handle shrinking multiple segments on the same line",
        ).toEqual("12" as Line);
      }

      await mountedView.render({ prop1: "1", prop2: "2" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(
          lines[0],
          "should handle shrinking multiple segments on the same line",
        ).toEqual("12" as Line);
      }

      await mountedView.render({ prop1: "1\n111", prop2: "22" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 2,
        });

        expect(lines).toEqual(["1", "11122"] as Line[]);
      }

      await mountedView.render({ prop1: "\n1\n1\n", prop2: "\n2\n2" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 6,
        });

        expect(lines, "should handle updating a prop on a moving line").toEqual(
          ["", "1", "1", "", "2", "2"] as Line[],
        );
      }
    });
  });

  it("keeping track of edit distance", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = (props: { prop1: string; prop2: string }) =>
        d`${props.prop1}${props.prop2}`;
      const mountedView = await mountView({
        view,
        props: { prop1: "", prop2: "" },
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      await mountedView.render({ prop1: "1\n111", prop2: "22" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: -1,
        });

        expect(lines).toEqual(["1", "11122"] as Line[]);
      }

      await mountedView.render({ prop1: "1\n11", prop2: "22" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 6,
        });

        expect(
          lines,
          "should handle shifting back a second interpolation by dropping columns",
        ).toEqual(["1", "1122"] as Line[]);
      }

      await mountedView.render({ prop1: "11", prop2: "22" });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 6,
        });

        expect(
          lines,
          "should handle shifting back a second interpolation by dropping rows and columns",
        ).toEqual(["1122"] as Line[]);
      }
    });
  });

  it("conditional renders", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const childView = (props: { prop: boolean }) =>
        d`${props.prop ? "Success" : "Error"}`;

      const parentView = (props: { items: boolean[] }) =>
        d`${props.items.map((i) => childView({ prop: i }))}`;

      const mountedView = await mountView({
        view: parentView,
        props: { items: [true, false] },
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      await mountedView.render({ items: [true, true] });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: -1,
        });

        expect(lines).toEqual(["SuccessSuccess"] as Line[]);
      }

      await mountedView.render({ items: [false, false, true] });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: -1,
        });

        expect(lines).toEqual(["ErrorErrorSuccess"] as Line[]);
      }
    });
  });

  it("array nodes", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = (props: { items: string[] }) =>
        d`${props.items.map((s) => d`${s}`)}`;

      const mountedView = await mountView<{ items: string[] }>({
        view,
        props: { items: [] },
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(
          lines[0],
          "should handle multiple empty interpolations in a row",
        ).toEqual("" as Line);
      }

      await mountedView.render({ items: ["1", "2"] });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(
          lines[0],
          "should handle going from empty to segments on the same line",
        ).toEqual("12" as Line);
      }

      await mountedView.render({ items: [] });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(lines[0], "should handle shortened array").toEqual("" as Line);
      }

      await mountedView.render({ items: ["1\n1\n1\n", "2\n2"] });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: -1,
        });

        expect(lines, "should handle multiline array items").toEqual([
          "1",
          "1",
          "1",
          "2",
          "2",
        ] as Line[]);
      }

      await mountedView.render({ items: ["1\n1\n11", "22\n2"] });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: -1,
        });

        expect(lines, "should handle multiline array updates").toEqual([
          "1",
          "1",
          "1122",
          "2",
        ] as Line[]);
      }
    });
  });

  it("nodes after array nodes", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = (props: { items: string[] }) =>
        d`${props.items.map((s) => d`${s}`)}${d`end`}`;

      const mountedView = await mountView<{ items: string[] }>({
        view,
        props: { items: [] },
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      {
        const lines = await buffer.getLines({
          start: 0,
          end: 1,
        });

        expect(
          lines[0],
          "should handle multiple empty interpolations in a row",
        ).toEqual("end" as Line);
      }

      await mountedView.render({ items: ["\n", "\n"] });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: -1,
        });

        expect(
          lines,
          "should handle going from empty to segments on the same line",
        ).toEqual(["", "", "end"] as Line[]);
      }

      await mountedView.render({ items: [] });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: -1,
        });

        expect(lines, "should handle array dropping lines").toEqual([
          "end",
        ] as Line[]);
      }

      expect(extractMountTree(mountedView._getMountedNode())).toEqual({
        type: "node",
        startPos: { row: 0, col: 0 },
        endPos: { row: 0, col: 3 },
        children: [
          {
            type: "array",
            startPos: { row: 0, col: 0 },
            endPos: { row: 0, col: 0 },
            children: [],
          },
          {
            type: "node",
            startPos: { row: 0, col: 0 },
            endPos: { row: 0, col: 3 },
            children: [
              {
                type: "string",
                startPos: { row: 0, col: 0 },
                endPos: { row: 0, col: 3 },
                content: "end",
              },
            ],
          },
        ],
      });

      await mountedView.render({ items: ["\n", "\n123"] });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: -1,
        });

        expect(lines, "should handle array dropping lines and columns").toEqual(
          ["", "", "123end"] as Line[],
        );
      }

      await mountedView.render({ items: [] });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: -1,
        });

        expect(lines, "should handle array dropping lines").toEqual([
          "end",
        ] as Line[]);
      }

      expect(extractMountTree(mountedView._getMountedNode())).toEqual({
        type: "node",
        startPos: { row: 0, col: 0 },
        endPos: { row: 0, col: 3 },
        children: [
          {
            type: "array",
            startPos: { row: 0, col: 0 },
            endPos: { row: 0, col: 0 },
            children: [],
          },
          {
            type: "node",
            startPos: { row: 0, col: 0 },
            endPos: { row: 0, col: 3 },
            children: [
              {
                type: "string",
                startPos: { row: 0, col: 0 },
                endPos: { row: 0, col: 3 },
                content: "end",
              },
            ],
          },
        ],
      });
    });
  });

  it("message w parts", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      type Message = { role: string; parts: string[] };
      const view = (props: { messages: Message[] }) =>
        d`${props.messages.map(
          (m) => d`###${m.role}:
${m.parts.map((p) => d`${p}\n`)}`,
        )}`;

      const mountedView = await mountView<{ messages: Message[] }>({
        view,
        props: { messages: [{ role: "user", parts: ["Success"] }] },
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      await mountedView.render({
        messages: [
          { role: "user", parts: ["Success"] },
          { role: "assistant", parts: ["test"] },
        ],
      });
      {
        const lines = await buffer.getLines({
          start: 0,
          end: -1,
        });

        expect(lines, "should handle multiline array updates").toEqual([
          "###user:",
          "Success",
          "###assistant:",
          "test",
          "",
        ] as Line[]);
      }
    });
  });
});

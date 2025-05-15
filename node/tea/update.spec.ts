import { describe, expect, it } from "vitest";
import {
  updateAccumulatedEdit,
  remapCurrentToNextPos,
  type AccumulatedEdit,
  type NextPosition,
  type NextRow,
  type CurrentPosition,
} from "./update.ts";
import { type Position0Indexed } from "../nvim/window.ts";
import { d, mountView, pos } from "./view.ts";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";
import { extractMountTree, withNvimClient } from "../test/preamble.ts";

describe("updateAccumulatedEdit", () => {
  it("handles the streaming block to edit transition case", () => {
    // Initial state matching the failing test case
    const accumulatedEdit: AccumulatedEdit = {
      deltaRow: 0,
      deltaCol: 8,
      lastEditRow: 0 as NextRow,
    };

    const oldPos = {
      startPos: createPos(0, 17) as CurrentPosition,
      endPos: createPos(0, 17) as CurrentPosition,
    };

    const remappedOldPos = {
      startPos: createPos(0, 25) as NextPosition,
      endPos: createPos(0, 25) as NextPosition,
    };

    const newPos = {
      startPos: createPos(0, 25) as NextPosition,
      endPos: createPos(3, 0) as NextPosition,
    };

    updateAccumulatedEdit(accumulatedEdit, oldPos, remappedOldPos, newPos);

    expect(accumulatedEdit).toEqual({
      deltaRow: 3,
      deltaCol: -17, // newPos.endPos.col - oldPos.endPos.col
      lastEditRow: 3,
    });
  });

  it("increments deltaCol when current node is inline with edit so far", () => {
    const accumulatedEdit: AccumulatedEdit = {
      deltaRow: 0,
      deltaCol: 5,
      lastEditRow: 2 as NextRow,
    };

    const oldPos = {
      startPos: createPos(2, 10) as CurrentPosition,
      endPos: createPos(2, 15) as CurrentPosition,
    };

    const remappedOldPos = {
      startPos: createPos(2, 15) as NextPosition,
      endPos: createPos(2, 20) as NextPosition,
    };

    const newPos = {
      startPos: createPos(2, 15) as NextPosition,
      endPos: createPos(2, 25) as NextPosition,
    };

    updateAccumulatedEdit(accumulatedEdit, oldPos, remappedOldPos, newPos);

    expect(accumulatedEdit).toEqual({
      deltaRow: 0,
      deltaCol: 10, // original 5 + (25 - 20)
      lastEditRow: 2,
    });
  });

  it("increments deltaCol when node used to be multiple lines but now is one line", () => {
    const accumulatedEdit: AccumulatedEdit = {
      deltaRow: -2, // Already lost 2 rows
      deltaCol: 3,
      lastEditRow: 5 as NextRow,
    };

    const oldPos = {
      startPos: createPos(5, 10) as CurrentPosition,
      endPos: createPos(7, 5) as CurrentPosition,
    };

    const remappedOldPos = {
      startPos: createPos(3, 13) as NextPosition,
      endPos: createPos(5, 5) as NextPosition,
    };

    const newPos = {
      startPos: createPos(3, 13) as NextPosition,
      endPos: createPos(3, 20) as NextPosition,
    };

    updateAccumulatedEdit(accumulatedEdit, oldPos, remappedOldPos, newPos);

    expect(accumulatedEdit).toEqual({
      deltaRow: -4, // Lost 2 more rows
      deltaCol: 15, // newPos.endPos.col - remappedOldPos.endPos.col + original
      lastEditRow: 3,
    });
  });

  it("resets deltaCol when node used to be multiple lines and remains multiple lines", () => {
    const accumulatedEdit: AccumulatedEdit = {
      deltaRow: 0,
      deltaCol: 10,
      lastEditRow: 2 as NextRow,
    };

    const oldPos = {
      startPos: createPos(2, 15) as CurrentPosition,
      endPos: createPos(5, 8) as CurrentPosition,
    };

    const remappedOldPos = {
      startPos: createPos(2, 25) as NextPosition,
      endPos: createPos(5, 8) as NextPosition,
    };

    const newPos = {
      startPos: createPos(2, 25) as NextPosition,
      endPos: createPos(6, 12) as NextPosition,
    };

    updateAccumulatedEdit(accumulatedEdit, oldPos, remappedOldPos, newPos);

    expect(accumulatedEdit).toEqual({
      deltaRow: 1, // Gained 1 row
      deltaCol: 4, // 12 - 8
      lastEditRow: 6,
    });
  });
});

describe("remapCurrentToNextPos", () => {
  it("handles the streaming block to edit transition case", () => {
    const accumulatedEdit: AccumulatedEdit = {
      deltaRow: 3,
      deltaCol: -17,
      lastEditRow: 3 as NextRow,
    };

    const currentPos = {
      startPos: createPos(0, 17) as unknown as CurrentPosition,
      endPos: createPos(1, 21) as unknown as CurrentPosition,
    };

    const remappedPos = remapCurrentToNextPos(currentPos, accumulatedEdit);

    expect(remappedPos).toEqual({
      startPos: {
        row: 3,
        col: 0,
      },
      endPos: {
        row: 4,
        col: 21,
      },
    });
  });

  it("updates start and end when node is on same line as lastEditRow", () => {
    const accumulatedEdit: AccumulatedEdit = {
      deltaRow: 0,
      deltaCol: 5,
      lastEditRow: 3 as NextRow,
    };

    const currentPos = {
      startPos: createPos(3, 10) as unknown as CurrentPosition,
      endPos: createPos(3, 20) as unknown as CurrentPosition,
    };

    const remappedPos = remapCurrentToNextPos(currentPos, accumulatedEdit);

    expect(remappedPos).toEqual({
      startPos: {
        row: 3,
        col: 15, // 10 + 5
      },
      endPos: {
        row: 3,
        col: 25, // 20 + 5
      },
    });
  });

  it("shifts only start column when node spans multiple lines with start on lastEditRow", () => {
    const accumulatedEdit: AccumulatedEdit = {
      deltaRow: 2,
      deltaCol: 7,
      lastEditRow: 7 as NextRow,
    };

    const currentPos = {
      startPos: createPos(5, 10) as unknown as CurrentPosition,
      endPos: createPos(8, 15) as unknown as CurrentPosition,
    };

    const remappedPos = remapCurrentToNextPos(currentPos, accumulatedEdit);

    expect(remappedPos).toEqual({
      startPos: {
        row: 7, // 5 + 2
        col: 17, // 10 + 7
      },
      endPos: {
        row: 10, // 8 + 2
        col: 15, // unchanged because not on lastEditRow
      },
    });
  });

  it("only updates row when node is past the edit row", () => {
    const accumulatedEdit: AccumulatedEdit = {
      deltaRow: 3,
      deltaCol: 10,
      lastEditRow: 4 as NextRow,
    };

    const currentPos = {
      startPos: createPos(5, 8) as unknown as CurrentPosition,
      endPos: createPos(7, 12) as unknown as CurrentPosition,
    };

    const remappedPos = remapCurrentToNextPos(currentPos, accumulatedEdit);

    expect(remappedPos).toEqual({
      startPos: {
        row: 8, // 5 + 3
        col: 8, // unchanged because past lastEditRow
      },
      endPos: {
        row: 10, // 7 + 3
        col: 12, // unchanged because past lastEditRow
      },
    });
  });
});

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

  it(
    "reproduces streaming block to edit transition",
    { timeout: 0 },
    async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);
        await buffer.setOption("modifiable", false);

        type Props = {
          role: string;
          streamingBlock: string | null;
          edits: boolean;
          awaitingResponse?: boolean;
        };

        // This mimics the Message view structure from message.ts
        const view = (props: Props) => {
          const fileEdits = [];
          if (props.edits) {
            fileEdits.push(d`  edit. \n`);
          }

          return d`\
${props.streamingBlock ? d`edit ${props.streamingBlock}` : ""}${
            fileEdits.length
              ? d`
Edits:
${fileEdits}`
              : ""
          }${props.awaitingResponse ? d`\nAwaiting response ⠂` : ""}`;
        };

        const mountedView = await mountView<Props>({
          view,
          props: {
            role: "assistant",
            streamingBlock: "streaming...",
            edits: false,
            awaitingResponse: true,
          },
          mount: {
            nvim,
            buffer,
            startPos: pos(0, 0),
            endPos: pos(0, 0),
          },
        });

        await mountedView.render({
          role: "assistant",
          streamingBlock: "Processing insert...",
          edits: true,
          awaitingResponse: true,
        });

        {
          const lines = await buffer.getLines({ start: 0, end: -1 });
          expect(lines).toEqual([
            "edit Processing insert...",
            "Edits:",
            "  edit. ",
            "",
            "Awaiting response ⠂",
          ] as Line[]);
        }

        // Final state - no streaming block, only edits
        await mountedView.render({
          role: "assistant",
          streamingBlock: null,
          edits: true,
          awaitingResponse: false,
        });

        {
          const lines = await buffer.getLines({ start: 0, end: -1 });
          expect(lines).toEqual(["", "Edits:", "  edit. ", ""] as Line[]);
        }
      });
    },
  );

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

// Helper to create fake positions for testing
function createPos(row: number, col: number): Position0Indexed {
  return { row, col } as Position0Indexed;
}

import { describe, expect, it } from "vitest";
import type { Position0Indexed } from "../nvim/window.ts";
import { sliceDisplayBufferSelection } from "./reflect-anchor.ts";

const pos = (row: number, col: number) => ({ row, col }) as Position0Indexed;

describe("sliceDisplayBufferSelection", () => {
  it("charwise within one line", () => {
    expect(
      sliceDisplayBufferSelection(["hello world"], {
        start: pos(3, 6),
        end: pos(3, 10),
        linewise: false,
      }),
    ).toBe("world");
  });

  it("charwise across lines", () => {
    expect(
      sliceDisplayBufferSelection(["one two", "three four"], {
        start: pos(0, 4),
        end: pos(1, 4),
        linewise: false,
      }),
    ).toBe("two\nthree");
  });

  it("linewise", () => {
    expect(
      sliceDisplayBufferSelection(["one two", "three"], {
        start: pos(0, 0),
        end: pos(1, 2147483646),
        linewise: true,
      }),
    ).toBe("one two\nthree");
  });

  it("clamps an end past the line (v$)", () => {
    expect(
      sliceDisplayBufferSelection(["abc"], {
        start: pos(0, 1),
        end: pos(0, 3),
        linewise: false,
      }),
    ).toBe("bc");
  });

  it("includes the whole multibyte last character", () => {
    // "é" is 2 bytes, "日" is 3 bytes
    const line = "aé日b";
    expect(
      sliceDisplayBufferSelection([line], {
        start: pos(0, 1),
        end: pos(0, 3),
        linewise: false,
      }),
    ).toBe("é日");
  });
});

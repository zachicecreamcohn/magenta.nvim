import { describe, expect, it } from "vitest";
import type { ByteIdx, Position0Indexed, Row0Indexed } from "../nvim/window.ts";
import { isRangeWithinNode } from "./bindings.ts";

const pos = (row: number, col: number): Position0Indexed => ({
  row: row as Row0Indexed,
  col: col as ByteIdx,
});
// Block text "abc\ndef" at rows 2-3; endPos is exclusive (after "f").
const node = { startPos: pos(2, 0), endPos: pos(3, 3) };

describe("isRangeWithinNode", () => {
  it("accepts a selection ending on the block's last character", () => {
    expect(isRangeWithinNode({ start: pos(3, 0), end: pos(3, 2) }, node)).toBe(
      true,
    );
  });
  it("accepts a selection starting exactly at startPos", () => {
    expect(isRangeWithinNode({ start: pos(2, 0), end: pos(2, 1) }, node)).toBe(
      true,
    );
  });
  it("rejects a selection one character past the end", () => {
    expect(isRangeWithinNode({ start: pos(3, 0), end: pos(3, 3) }, node)).toBe(
      false,
    );
  });
  it("rejects a selection starting before the block", () => {
    expect(isRangeWithinNode({ start: pos(1, 5), end: pos(2, 1) }, node)).toBe(
      false,
    );
  });
});

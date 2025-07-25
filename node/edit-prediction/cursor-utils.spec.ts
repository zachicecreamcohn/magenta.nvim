import { test, expect } from "vitest";
import { selectBestPredictionLocation, type MatchRange } from "./cursor-utils";
import type { Position0Indexed, Row0Indexed, ByteIdx } from "../nvim/window";

// Helper function to create Position0Indexed with proper type casting
function makePos(row: number, col: number): Position0Indexed {
  return {
    row: row as Row0Indexed,
    col: col as ByteIdx,
  };
}

test("selects match that contains cursor", () => {
  const matchRanges: MatchRange[] = [
    {
      contextPosStart: 0,
      contextPosEnd: 4,
      startPos: makePos(0, 0),
      endPos: makePos(0, 4),
    },
    {
      contextPosStart: 10,
      contextPosEnd: 14,
      startPos: makePos(1, 0),
      endPos: makePos(1, 4),
    },
  ];

  // Cursor is inside the first match
  const cursorPos = makePos(0, 2);
  const result = selectBestPredictionLocation(matchRanges, cursorPos);

  expect(result).toBe(matchRanges[0]);
});

test("selects match that touches cursor at start position", () => {
  const matchRanges: MatchRange[] = [
    {
      contextPosStart: 0,
      contextPosEnd: 4,
      startPos: makePos(0, 0),
      endPos: makePos(0, 4),
    },
    {
      contextPosStart: 10,
      contextPosEnd: 14,
      startPos: makePos(1, 0),
      endPos: makePos(1, 4),
    },
  ];

  // Cursor is at the start of first match
  const cursorPos = makePos(0, 0);
  const result = selectBestPredictionLocation(matchRanges, cursorPos);

  expect(result).toBe(matchRanges[0]);
});

test("selects match that touches cursor at end position", () => {
  const matchRanges: MatchRange[] = [
    {
      contextPosStart: 0,
      contextPosEnd: 4,
      startPos: makePos(0, 0),
      endPos: makePos(0, 4),
    },
    {
      contextPosStart: 10,
      contextPosEnd: 14,
      startPos: makePos(1, 0),
      endPos: makePos(1, 4),
    },
  ];

  // Cursor is at the end of first match
  const cursorPos = makePos(0, 4);
  const result = selectBestPredictionLocation(matchRanges, cursorPos);

  expect(result).toBe(matchRanges[0]);
});

test("selects first match after cursor when no match contains cursor", () => {
  const matchRanges: MatchRange[] = [
    {
      contextPosStart: 0,
      contextPosEnd: 4,
      startPos: makePos(0, 0),
      endPos: makePos(0, 4),
    },
    {
      contextPosStart: 10,
      contextPosEnd: 14,
      startPos: makePos(1, 0),
      endPos: makePos(1, 4),
    },
    {
      contextPosStart: 20,
      contextPosEnd: 24,
      startPos: makePos(2, 0),
      endPos: makePos(2, 4),
    },
  ];

  // Cursor is between first and second match
  const cursorPos = makePos(0, 10);
  const result = selectBestPredictionLocation(matchRanges, cursorPos);

  expect(result).toBe(matchRanges[1]);
});

test("selects last match when cursor is after all matches", () => {
  const matchRanges: MatchRange[] = [
    {
      contextPosStart: 0,
      contextPosEnd: 4,
      startPos: makePos(0, 0),
      endPos: makePos(0, 4),
    },
    {
      contextPosStart: 10,
      contextPosEnd: 14,
      startPos: makePos(1, 0),
      endPos: makePos(1, 4),
    },
    {
      contextPosStart: 20,
      contextPosEnd: 24,
      startPos: makePos(2, 0),
      endPos: makePos(2, 4),
    },
  ];

  // Cursor is after all matches
  const cursorPos = makePos(3, 0);
  const result = selectBestPredictionLocation(matchRanges, cursorPos);

  expect(result).toBe(matchRanges[2]);
});

test("handles single match range", () => {
  const matchRanges: MatchRange[] = [
    {
      contextPosStart: 0,
      contextPosEnd: 4,
      startPos: makePos(0, 0),
      endPos: makePos(0, 4),
    },
  ];

  const cursorPos = makePos(1, 0);
  const result = selectBestPredictionLocation(matchRanges, cursorPos);

  expect(result).toBe(matchRanges[0]);
});

test("throws error when no match ranges provided", () => {
  const matchRanges: MatchRange[] = [];
  const cursorPos = makePos(0, 0);

  expect(() => selectBestPredictionLocation(matchRanges, cursorPos)).toThrow(
    "No match candidates provided",
  );
});

test("handles multi-line matches correctly", () => {
  const matchRanges: MatchRange[] = [
    {
      contextPosStart: 0,
      contextPosEnd: 10,
      startPos: makePos(0, 5),
      endPos: makePos(2, 3),
    },
    {
      contextPosStart: 20,
      contextPosEnd: 25,
      startPos: makePos(3, 0),
      endPos: makePos(3, 5),
    },
  ];

  // Cursor is inside the multi-line match
  const cursorPos = makePos(1, 2);
  const result = selectBestPredictionLocation(matchRanges, cursorPos);

  expect(result).toBe(matchRanges[0]);
});

test("prefers match containing cursor over earlier matches", () => {
  const matchRanges: MatchRange[] = [
    {
      contextPosStart: 0,
      contextPosEnd: 4,
      startPos: makePos(0, 0),
      endPos: makePos(0, 4),
    },
    {
      contextPosStart: 10,
      contextPosEnd: 14,
      startPos: makePos(1, 0),
      endPos: makePos(1, 4),
    },
    {
      contextPosStart: 20,
      contextPosEnd: 24,
      startPos: makePos(2, 0),
      endPos: makePos(2, 4),
    },
  ];

  // Cursor is inside the second match, even though first match comes first
  const cursorPos = makePos(1, 2);
  const result = selectBestPredictionLocation(matchRanges, cursorPos);

  expect(result).toBe(matchRanges[1]);
});

test("correctly compares positions across different rows", () => {
  const matchRanges: MatchRange[] = [
    {
      contextPosStart: 0,
      contextPosEnd: 4,
      startPos: makePos(0, 10),
      endPos: makePos(0, 14),
    },
    {
      contextPosStart: 10,
      contextPosEnd: 14,
      startPos: makePos(1, 5),
      endPos: makePos(1, 9),
    },
  ];

  // Cursor is at row 1, col 0 (earlier in row 1 than second match)
  const cursorPos = makePos(1, 0);
  const result = selectBestPredictionLocation(matchRanges, cursorPos);

  // Should select the second match since it's the first match after cursor
  expect(result).toBe(matchRanges[1]);
});

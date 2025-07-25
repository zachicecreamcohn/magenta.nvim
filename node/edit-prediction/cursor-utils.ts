import type { Position0Indexed } from "../nvim/window";

export type MatchRange = {
  contextPosStart: number;
  contextPosEnd: number;
  startPos: Position0Indexed;
  endPos: Position0Indexed;
};

function comparePositions(a: Position0Indexed, b: Position0Indexed): number {
  if (a.row !== b.row) {
    return a.row - b.row;
  }
  return a.col - b.col;
}

export function selectBestPredictionLocation(
  matchRanges: MatchRange[],
  cursorPos: Position0Indexed,
): MatchRange {
  if (matchRanges.length === 0) {
    throw new Error("No match candidates provided");
  }

  // Sort matchRanges in ascending order by startPos
  const sortedRanges = [...matchRanges].sort((a, b) =>
    comparePositions(a.startPos, b.startPos),
  );

  // First pass: find matches that contain or touch the cursor
  for (const match of sortedRanges) {
    const { startPos, endPos } = match;

    const cursorTouchingMatch =
      comparePositions(cursorPos, startPos) >= 0 &&
      comparePositions(cursorPos, endPos) <= 0;

    if (cursorTouchingMatch) {
      return match;
    }
  }

  for (const match of sortedRanges) {
    const { startPos } = match;
    if (comparePositions(startPos, cursorPos) > 0) {
      return match;
    }
  }

  // If no match past cursor, choose the last match (closest before cursor)
  return sortedRanges[sortedRanges.length - 1];
}

import * as diff from "diff";

export type DiffOperation =
  | { type: "delete"; startPos: number; endPos: number } // character positions in 'find' parameter of tool input
  | { type: "insert"; text: string; insertAfterPos: number }; // character position in 'find' parameter of tool input

export type EditPredictionDiff = DiffOperation[];

export function calculateDiff(
  originalText: string,
  newText: string,
): EditPredictionDiff {
  const changes = diff.diffWordsWithSpace(originalText, newText);
  const operations: EditPredictionDiff = [];
  let originalPosition = 0; // Position in the original text

  for (const change of changes) {
    if (change.removed) {
      operations.push({
        type: "delete",
        startPos: originalPosition,
        endPos: originalPosition + change.value.length,
      });
      originalPosition += change.value.length;
    } else if (change.added) {
      operations.push({
        type: "insert",
        text: change.value,
        insertAfterPos: originalPosition,
      });
      // Don't advance originalPosition for insertions since they don't exist in original
    } else {
      // Unchanged text - advance position in original
      originalPosition += change.value.length;
    }
  }

  return operations;
}

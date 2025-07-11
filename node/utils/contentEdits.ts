/**
 * Utility functions for manipulating file content as strings
 */

/**
 * Apply an insert operation to a string
 * @param content The original content string
 * @param insertAfter The string after which to insert new content
 * @param newContent The content to insert
 * @returns Result object with either the modified string or an error
 */
export function applyInsert(
  content: string,
  insertAfter: string,
  newContent: string,
): { status: "ok"; content: string } | { status: "error"; error: string } {
  // Special case: If insertAfter is empty, append to the end
  if (insertAfter === "") {
    return {
      status: "ok",
      content: content + newContent,
    };
  }

  const insertIndex = content.indexOf(insertAfter);
  if (insertIndex === -1) {
    return {
      status: "error",
      error: `Unable to find insert location "${insertAfter}"`,
    };
  }

  const insertLocation = insertIndex + insertAfter.length;
  return {
    status: "ok",
    content:
      content.slice(0, insertLocation) +
      newContent +
      content.slice(insertLocation),
  };
}

/**
 * Normalize a line by trimming whitespace and removing trailing semicolons and commas
 */
export function normalizeLine(line: string): string {
  return line.trim().replace(/[;,]$/, "");
}

/**
 * Find a subsequence of lines in content that matches the find pattern using forgiving matching
 * @param contentLines Array of content lines
 * @param findLines Array of find pattern lines
 * @returns Object with start and end indices if found, "multiple" if multiple matches, null if no matches
 */
export function findForgivingMatch(
  contentLines: string[],
  findLines: string[],
): { start: number; end: number } | "multiple" | null {
  if (findLines.length === 0) {
    return null;
  }

  // Normalize both content and find lines
  const normalizedContent = contentLines.map(normalizeLine);
  const normalizedFind = findLines.map(normalizeLine);

  let foundMatch: { start: number; end: number } | null = null;

  // Try to find the subsequence
  for (let i = 0; i <= normalizedContent.length - normalizedFind.length; i++) {
    let match = true;
    for (let j = 0; j < normalizedFind.length; j++) {
      if (normalizedContent[i + j] !== normalizedFind[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      if (foundMatch !== null) {
        // Multiple matches found
        return "multiple";
      }
      foundMatch = { start: i, end: i + normalizedFind.length };
    }
  }

  return foundMatch;
}

/**
 * Apply a replace operation to a string
 * @param content The original content string
 * @param find The string to find and replace
 * @param replace The replacement string
 * @returns Result object with either the modified string or an error
 */
export function applyReplace(
  content: string,
  find: string,
  replace: string,
): { status: "ok"; content: string } | { status: "error"; error: string } {
  // Special case: if find is empty, replace the entire content
  if (find === "") {
    return {
      status: "ok",
      content: replace,
    };
  }

  // First, try exact matching (current behavior)
  const replaceStart = content.indexOf(find);
  if (replaceStart !== -1) {
    const replaceEnd = replaceStart + find.length;
    return {
      status: "ok",
      content:
        content.slice(0, replaceStart) + replace + content.slice(replaceEnd),
    };
  }

  // Fallback to forgiving matching
  const contentLines = content.split("\n");
  const findLines = find.split("\n");

  const match = findForgivingMatch(contentLines, findLines);
  if (match === null) {
    return {
      status: "error",
      error: `Unable to find text in content. Try to re-read the file and make sure you match the latest content updates exactly.`,
    };
  }

  if (match === "multiple") {
    return {
      status: "error",
      error: `Multiple matches found for the find parameter. Please provide more specific find parameter to uniquely identify the replace location.`,
    };
  }

  // Replace the matched lines with the replacement
  const replaceLines = replace.split("\n");
  const newLines = [
    ...contentLines.slice(0, match.start),
    ...replaceLines,
    ...contentLines.slice(match.end),
  ];

  return {
    status: "ok",
    content: newLines.join("\n"),
  };
}

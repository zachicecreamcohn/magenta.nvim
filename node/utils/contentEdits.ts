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
      error: `Unable to find insert location "${insertAfter}" in content`,
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

  const replaceStart = content.indexOf(find);
  if (replaceStart === -1) {
    return {
      status: "error",
      error: `Unable to find text "${find}" in content`,
    };
  }

  const replaceEnd = replaceStart + find.length;
  return {
    status: "ok",
    content:
      content.slice(0, replaceStart) + replace + content.slice(replaceEnd),
  };
}

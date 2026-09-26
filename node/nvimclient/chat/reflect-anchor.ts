import type { DisplayBufferText } from "@magenta/server";
import type { VisualRange } from "../tea/bindings.ts";

/** Slices the visually selected text out of the display buffer lines that the
 * selection spans (`lines[0]` is row `start.row`). Columns are byte indices;
 * `end.col` is the start byte of the last selected character, as reported by
 * `getpos("'>")`, and may exceed the line length (e.g. `v$`). */
export function sliceDisplayBufferSelection(
  lines: string[],
  range: VisualRange,
): DisplayBufferText {
  const rowCount = range.end.row - range.start.row + 1;
  const selected = lines.slice(0, rowCount).map((line, i) => {
    if (range.linewise) return line;
    const bytes = Buffer.from(line, "utf8");
    const from = i === 0 ? range.start.col : 0;
    const to =
      i === rowCount - 1 ? endOfCharAt(bytes, range.end.col) : bytes.length;
    return bytes.subarray(from, to).toString("utf8");
  });
  return selected.join("\n") as DisplayBufferText;
}

function endOfCharAt(bytes: Buffer, col: number): number {
  if (col >= bytes.length) return bytes.length;
  let end = col + 1;
  // skip UTF-8 continuation bytes
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
  return end;
}

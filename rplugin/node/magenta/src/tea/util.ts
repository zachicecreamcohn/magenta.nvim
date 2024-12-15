import { Buffer } from "neovim";
import { Position } from "./view.ts";
import { Line } from "../chat/part.ts";
import { context } from "../context.ts";

export async function replaceBetweenPositions({
  buffer,
  startPos,
  endPos,
  lines,
}: {
  buffer: Buffer;
  startPos: Position;
  endPos: Position;
  lines: Line[];
}) {
  await buffer.setOption("modifiable", true);
  await context.nvim.call("nvim_buf_set_text", [
    buffer.id,
    startPos.row,
    startPos.col,
    endPos.row,
    endPos.col,
    lines,
  ]);
  await buffer.setOption("modifiable", true);
}

export function calculatePosition(
  startPos: Position,
  text: string,
  indexInText: number,
): Position {
  let { row, col } = startPos;
  let currentIndex = 0;

  while (currentIndex < indexInText) {
    if (text[currentIndex] === "\n") {
      row++;
      col = 0;
    } else {
      col++;
    }
    currentIndex++;
  }

  return { row, col };
}

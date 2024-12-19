import { Buffer as NvimBuffer } from "neovim";
import { Position } from "./view.ts";
import { Line } from "../chat/part.ts";
import { context } from "../context.ts";

export async function replaceBetweenPositions({
  buffer,
  startPos,
  endPos,
  lines,
}: {
  buffer: NvimBuffer;
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

export async function logBuffer(buffer: NvimBuffer) {
  const lines = await buffer.getLines({
    start: 0,
    end: -1,
    strictIndexing: false,
  });
  context.logger.log("buffer:\n" + lines.join("\n") + "\nend");
}

export function strWidthInBytes(str: string) {
  return Buffer.byteLength(str, "utf8");
}

import { Buffer as NvimBuffer } from "neovim";
import { ByteIdx, Position } from "./view.ts";
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
  try {
    await context.nvim.call("nvim_buf_set_text", [
      buffer.id,
      startPos.row,
      startPos.col,
      endPos.row,
      endPos.col,
      lines,
    ]);
  } catch (e) {
    console.error(
      `Unable to replaceBetweenPositions ${JSON.stringify({ startPos, endPos })}: ${e as string}`,
    );
    throw e;
  }
  await buffer.setOption("modifiable", true);
}

export function calculatePosition(
  startPos: Position,
  buf: Buffer,
  indexInText: number,
): Position {
  let { row, col } = startPos;
  let currentIndex = 0;

  while (currentIndex < indexInText) {
    // 10 == '\n' in hex
    if (buf[currentIndex] == 10) {
      row++;
      col = 0 as ByteIdx;
    } else {
      col++;
    }
    currentIndex++;
  }

  context.logger.trace(
    `${JSON.stringify(startPos)} + ${buf.toString()}[${indexInText}] = ${JSON.stringify({ row, col })}`,
  );
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
  return Buffer.from(str, "utf8").byteLength;
}

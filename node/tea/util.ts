import type { Nvim } from "../nvim/nvim-node";
import type { Line, NvimBuffer } from "../nvim/buffer.ts";
import type {
  PositionString,
  ByteIdx,
  Position0Indexed,
  StringIdx,
} from "../nvim/window.ts";

export async function replaceBetweenPositions({
  buffer,
  startPos,
  endPos,
  lines,
  context,
}: {
  buffer: NvimBuffer;
  startPos: Position0Indexed;
  endPos: Position0Indexed;
  lines: Line[];
  context: { nvim: Nvim };
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
    const err = new Error(
      `Unable to replaceBetweenPositions ${JSON.stringify({ startPos, endPos })}: ${e as string}`,
    );
    context.nvim.logger?.error(err.message);
    throw e;
  }
  await buffer.setOption("modifiable", false);
}

export function calculatePosition(
  startPos: Position0Indexed,
  buf: Buffer,
  indexInText: ByteIdx,
): Position0Indexed {
  let { row, col } = startPos;
  let currentIndex: ByteIdx = 0 as ByteIdx;

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

  return { row, col };
}

export function calculateStringPosition(
  startPos: PositionString,
  content: string,
  indexInText: StringIdx,
): PositionString {
  let { row, col } = startPos;
  let currentIndex = 0 as StringIdx;

  while (currentIndex < indexInText) {
    // 10 == '\n' in hex
    if (content[currentIndex] == "\n") {
      row++;
      col = 0 as StringIdx;
    } else {
      col++;
    }
    currentIndex++;
  }

  return { row, col };
}

export async function logBuffer(buffer: NvimBuffer, context: { nvim: Nvim }) {
  const lines = await buffer.getLines({
    start: 0,
    end: -1,
  });
  context.nvim.logger?.info("buffer:\n" + lines.join("\n") + "\nend");
}

export function strWidthInBytes(str: string) {
  return Buffer.from(str, "utf8").byteLength;
}

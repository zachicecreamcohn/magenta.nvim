import { Buffer, Neovim } from "neovim";
import { Line } from "../part";

export type Mark = number & { __mark: true };

export function setExtMark({
  nvim,
  buffer,
  namespace,
  row,
  col,
}: {
  nvim: Neovim;
  buffer: Buffer;
  namespace: number;
  row: number;
  col: number;
}): Promise<Mark> {
  return nvim.call(`nvim_buf_set_extmark`, [
    buffer.id,
    namespace,
    row,
    col,
    {},
  ]) as Promise<Mark>;
}

export function getExtMark({
  nvim,
  buffer,
  namespace,
  markId,
}: {
  nvim: Neovim;
  buffer: Buffer;
  namespace: number;
  markId: Mark;
}): Promise<[number, number]> {
  return nvim.call(`nvim_buf_get_extmark_by_id`, [
    buffer.id,
    namespace,
    markId,
    {},
  ]) as Promise<[number, number]>;
}
export async function createMarkedSpacesOnNewLine({
  nvim,
  buffer,
  namespace,
  row,
  col,
}: {
  nvim: Neovim;
  buffer: Buffer;
  namespace: number;
  row: number;
  col: number;
}): Promise<{ startMark: Mark; endMark: Mark }> {
  await buffer.setOption("modifiable", true);
  await nvim.call("nvim_buf_set_text", [
    buffer.id,
    row,
    col,
    row,
    col,
    ["", ""],
  ]);
  await buffer.setOption("modifiable", false);

  return createMarkedSpaces({
    nvim,
    buffer,
    namespace,
    row: row + 1,
    col: 0,
  });
}

export async function createMarkedSpaces({
  nvim,
  buffer,
  namespace,
  row,
  col,
}: {
  nvim: Neovim;
  buffer: Buffer;
  namespace: number;
  row: number;
  col: number;
}): Promise<{ startMark: Mark; endMark: Mark }> {
  await buffer.setOption("modifiable", true);

  try {
    // Insert two spaces
    await nvim.call("nvim_buf_set_text", [
      buffer.id,
      row,
      col,
      row,
      col,
      ["  "],
    ]);

    const startMark = await setExtMark({
      nvim,
      buffer,
      namespace,
      row,
      col,
    });

    const endMark = await setExtMark({
      nvim,
      buffer,
      namespace,
      row,
      col: col + 1,
    });

    return { startMark, endMark };
  } finally {
    await buffer.setOption("modifiable", false);
  }
}

export async function insertBeforeMark({
  nvim,
  buffer,
  markId,
  lines,
  namespace,
}: {
  nvim: Neovim;
  buffer: Buffer;
  markId: Mark;
  lines: Line[];
  namespace: number;
}) {
  const [row, col] = await getExtMark({ nvim, buffer, markId, namespace });

  await buffer.setOption("modifiable", true);
  await nvim.call("nvim_buf_set_text", [buffer.id, row, col, row, col, lines]);
  await buffer.setOption("modifiable", false);
}

export async function replaceBetweenMarks({
  nvim,
  buffer,
  startMark,
  endMark,
  lines,
  namespace,
}: {
  nvim: Neovim;
  buffer: Buffer;
  startMark: Mark;
  endMark: Mark;
  lines: Line[];
  namespace: number;
}) {
  const [startRow, startCol] = await getExtMark({
    nvim,
    buffer,
    markId: startMark,
    namespace,
  });
  const [endRow, endCol] = await getExtMark({
    nvim,
    buffer,
    markId: endMark,
    namespace,
  });

  await buffer.setOption("modifiable", true);
  await nvim.call("nvim_buf_set_text", [
    buffer.id,
    startRow,
    startCol + 1, // insert after the starting mark, which should be a space
    endRow,
    endCol,
    lines,
  ]);
  await buffer.setOption("modifiable", false);
}

import { Buffer, Neovim } from "neovim";
import { Line } from "../part.js";

export type Mark = number & { __mark: true };
export type MarkOpts = { details: { is_start: boolean } };
export type FullMark = [Mark, number, number, MarkOpts];

export function sortMarks(marks: FullMark[]): FullMark[] {
  return [...marks].sort((a, b) => {
    // Compare rows first
    const rowDiff = a[1] - b[1];
    if (rowDiff !== 0) return rowDiff;

    // If rows are equal, compare columns
    const colDiff = a[2] - b[2];
    if (colDiff !== 0) return colDiff;

    // finally, compare markIds
    return a[0] - b[0];
  });
}

export async function getAllMarks({
  nvim,
  buffer,
  namespace,
  start,
  end,
}: {
  nvim: Neovim;
  buffer: Buffer;
  namespace: number;
  start?: [number, number]; // Optional start position [row, col]
  end?: [number, number]; // Optional end position [row, col]
}): Promise<FullMark[]> {
  const marks = (await nvim.call("nvim_buf_get_extmarks", [
    buffer.id,
    namespace,
    start || [0, 0],
    end || [-1, -1],
    { details: true },
  ])) as FullMark[];

  return sortMarks(marks);
}

export function setExtMark({
  nvim,
  buffer,
  namespace,
  row,
  col,
  is_start,
}: {
  nvim: Neovim;
  buffer: Buffer;
  namespace: number;
  row: number;
  col: number;
  is_start: boolean;
}): Promise<Mark> {
  return nvim.call(`nvim_buf_set_extmark`, [
    buffer.id,
    namespace,
    row,
    col,
    { details: { is_start } },
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
      is_start: true,
    });

    const endMark = await setExtMark({
      nvim,
      buffer,
      namespace,
      row,
      col: col + 1,
      is_start: false,
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

  const marksInRange = await getAllMarks({
    nvim,
    buffer,
    namespace,
    start: [startRow, startCol],
    end: [endRow, endCol],
  });
  // Replace the text
  await nvim.call("nvim_buf_set_text", [
    buffer.id,
    startRow,
    startCol,
    endRow,
    endCol,
    lines,
  ]);

  const insertedText = lines.join("\n");
  const endPosition = calculatePosition(
    [startRow, startCol],
    insertedText,
    insertedText.length,
  );

  const remainingMarks = await getAllMarks({
    nvim,
    buffer,
    namespace,
    start: [startRow, startCol],
    end: endPosition,
  });
  const remainingIds = new Set(remainingMarks.map((m) => m[0]));

  for (const [id, , , opts] of marksInRange) {
    if (!remainingIds.has(id)) {
      await setExtMark({
        nvim,
        buffer,
        namespace,
        row: opts.details.is_start ? startRow : endPosition[0],
        col: opts.details.is_start ? startCol : endPosition[1],
        is_start: opts.details.is_start,
      });
    }
  }

  console.log(
    `after replacing "${JSON.stringify(lines)} between mark ${startMark} at ${startRow}, ${startCol} and ${endMark} at ${endRow}, ${endCol}"`,
  );
  console.log(JSON.stringify(await getAllMarks({ nvim, buffer, namespace })));
  await buffer.setOption("modifiable", false);
}

/** Given a starting mark and a piece of text to insert, figure out where the ending mark should go
 */
export const calculatePosition = (
  startPos: [number, number],
  text: string,
  indexInText: number,
): [number, number] => {
  let [row, col] = startPos;
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

  return [row, col];
};

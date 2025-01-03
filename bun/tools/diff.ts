import { WIDTH } from "../sidebar.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Dispatch } from "../tea/tea.ts";
import { diffthis, getAllWindows } from "../nvim/nvim.ts";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";
import { type WindowId } from "../nvim/window.ts";
import type { Nvim } from "bunvim";
import type { ToolRequest, ToolRequestId } from "./toolManager.ts";

type Msg = {
  type: "diff-error";
  filePath: string;
  requestId: ToolRequestId;
  message: string;
};

/** Helper to bring up an editing interface for the given file path.
 */
export async function displayDiffs({
  filePath,
  diffId,
  edits,
  dispatch,
  context,
}: {
  filePath: string;
  /** used to uniquely identify the scratch buffer. This is useful to figure out which
   * buffers are still open for editing. Also helpful if you simultaneously open two diffs of the same
   * file.
   */
  diffId: string;
  edits: (ToolRequest<"replace"> | ToolRequest<"insert">)[];
  dispatch: Dispatch<Msg>;
  context: { nvim: Nvim };
}) {
  const { nvim } = context;
  nvim.logger?.debug(
    `Attempting to displayDiff for edits ${JSON.stringify(edits, null, 2)}`,
  );

  // first, check to see if any windows *other than* the magenta plugin windows are open, and close them.
  const windows = await getAllWindows(context.nvim);
  const magentaWindows = [];
  for (const window of windows) {
    if (await window.getVar("magenta")) {
      // save these so we can reset their width later
      magentaWindows.push(window);
      continue;
    }

    // Close other windows
    await window.close();
  }

  // next, bring up the target buffer and the new content in a side-by-side diff
  const fileBuffer = await NvimBuffer.bufadd(filePath, context.nvim);
  const fileWindowId = (await nvim.call("nvim_open_win", [
    fileBuffer.id,
    true,
    {
      win: -1, // global split
      split: "right",
      width: WIDTH,
      style: "minimal",
    },
  ])) as WindowId;

  await diffthis(context.nvim);

  const lines = await fileBuffer.getLines({
    start: 0,
    end: -1,
  });
  let content: string = lines.join("\n");

  for (const edit of edits) {
    switch (edit.name) {
      case "insert": {
        const insertLocation =
          content.indexOf(edit.input.insertAfter) +
          edit.input.insertAfter.length;
        content =
          content.slice(0, insertLocation) +
          edit.input.content +
          content.slice(insertLocation);
        break;
      }

      case "replace": {
        const replaceStart = content.indexOf(edit.input.startLine);
        const replaceEnd =
          content.indexOf(edit.input.endLine, replaceStart - 1) +
          edit.input.endLine.length;

        if (replaceStart == -1) {
          dispatch({
            type: "diff-error",
            filePath,
            requestId: edit.id,
            message: `Unable to find startLine "${edit.input.startLine}" in file ${filePath}`,
          });
          continue;
        }

        if (replaceEnd == -1) {
          dispatch({
            type: "diff-error",
            filePath,
            requestId: edit.id,
            message: `Unable to find endLine "${edit.input.endLine}" in file ${filePath}`,
          });
          continue;
        }

        content =
          content.slice(0, replaceStart) +
          edit.input.replace +
          content.slice(replaceEnd);

        break;
      }

      default:
        assertUnreachable(edit);
    }
  }

  const scratchBuffer = await NvimBuffer.create(false, true, context.nvim);

  await scratchBuffer.setOption("bufhidden", "wipe");
  await scratchBuffer.setLines({
    start: 0,
    end: -1,
    lines: content.split("\n") as Line[],
  });

  await scratchBuffer.setName(`${filePath}_${diffId}_diff`);
  await nvim.call("nvim_open_win", [
    scratchBuffer.id,
    true,
    {
      win: fileWindowId, // global split
      split: "left",
      width: WIDTH,
      style: "minimal",
    },
  ]);

  await diffthis(context.nvim);

  // now that both diff buffers are open, adjust the magenta window width again
  for (const window of magentaWindows) {
    await window.setWidth(WIDTH);
  }
}

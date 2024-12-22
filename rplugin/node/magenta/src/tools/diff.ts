import { context } from "../context.ts";
import { Buffer } from "neovim";
import { WIDTH } from "../sidebar.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { Dispatch } from "../tea/tea.ts";
import { ReplaceToolRequest } from "./replace.ts";
import { InsertToolUseRequest } from "./insert.ts";

type Msg = {
  type: "error";
  message: string;
};

/** Helper to bring up an editing interface for the given file path.
 */
export async function displayDiffs(
  filePath: string,
  edits: (ReplaceToolRequest | InsertToolUseRequest)[],
  dispatch: Dispatch<Msg>,
) {
  const { nvim, logger } = context;
  logger.trace(
    `Attempting to displayDiff for edits ${JSON.stringify(edits, null, 2)}`,
  );

  // first, check to see if any windows *other than* the magenta plugin windows are open, and close them.
  const windows = await nvim.windows;
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
  await nvim.command(`vsplit ${filePath}`);
  await nvim.lua('vim.cmd.wincmd("L")');

  // now that the buffer is open, adjust the magenta window width again
  for (const window of magentaWindows) {
    window.width = WIDTH;
  }

  // move the buffer all the way to the right
  const fileBuffer = await nvim.buffer;
  await nvim.command("diffthis");

  const lines = await fileBuffer.getLines({
    start: 0,
    end: -1,
    strictIndexing: false,
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
        const replaceStart = content.indexOf(edit.input.match);
        const replaceEnd = replaceStart + edit.input.match.length;

        if (replaceStart == -1) {
          dispatch({
            type: "error",
            message: `Unable to find match parameter ${edit.input.match} in file ${filePath}`,
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

  const scratchBuffer = (await nvim.createBuffer(false, true)) as Buffer;
  await scratchBuffer.setLines(content.split("\n"), {
    start: 0,
    end: -1,
    strictIndexing: false,
  });

  await nvim.command("vsplit");
  await nvim.command(`b ${scratchBuffer.id}`);
  await nvim.command("diffthis");
}

import { context } from "../context.ts";
import { Buffer } from "neovim";
import { WIDTH } from "../sidebar.ts";

type Edit = {
  type: "insert-after";
  insertAfter: string;
  content: string;
};

/** Helper to bring up an editing interface for the given file path.
 */
export async function displayDiffs(filePath: string, edits: Edit[]) {
  const { nvim } = context;

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
    const insertLocation =
      content.indexOf(edit.insertAfter) + edit.insertAfter.length;
    content =
      content.slice(0, insertLocation) +
      edit.content +
      content.slice(insertLocation);
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

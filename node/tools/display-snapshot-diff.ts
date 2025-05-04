import { WIDTH } from "../sidebar.ts";
import { diffthis, getAllWindows } from "../nvim/nvim.ts";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";
import { type WindowId } from "../nvim/window.ts";
import type { Nvim } from "nvim-node";
import type { MessageId } from "../chat/message.ts";
import type { FilePath, FileSnapshots } from "./file-snapshots.ts";

export async function displaySnapshotDiff({
  filePath,
  messageId,
  nvim,
  fileSnapshots,
}: {
  filePath: FilePath;
  messageId: MessageId;
  nvim: Nvim;
  fileSnapshots: FileSnapshots;
}) {
  nvim.logger?.debug(
    `Attempting to displayDiff for file ${filePath} with messageId ${messageId}`,
  );

  // Get the snapshot for this file and message
  const snapshot = fileSnapshots.getSnapshot(filePath, messageId);
  if (!snapshot) {
    // No need to call dispatchError as this may be used in contexts outside of a tool request
    nvim.logger?.error(
      `No snapshot found for file ${filePath} with messageId ${messageId}`,
    );
    return;
  }

  // first, check to see if any windows *other than* the magenta plugin windows are open, and close them.
  const windows = await getAllWindows(nvim);
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
  const fileBuffer = await NvimBuffer.bufadd(filePath, nvim);
  const fileWindowId = (await nvim.call("nvim_open_win", [
    fileBuffer.id,
    true,
    {
      win: -1, // global split
      split: "right",
      width: WIDTH,
    },
  ])) as WindowId;

  await diffthis(nvim);

  // Create a scratch buffer for the snapshot content
  const scratchBuffer = await NvimBuffer.create(false, true, nvim);

  await scratchBuffer.setOption("bufhidden", "wipe");
  await scratchBuffer.setLines({
    start: 0,
    end: -1,
    lines: snapshot.content.split("\n") as Line[],
  });

  await scratchBuffer.setName(`${filePath}_${messageId}_snapshot`);
  await nvim.call("nvim_open_win", [
    scratchBuffer.id,
    true,
    {
      win: fileWindowId, // global split
      split: "left",
      width: WIDTH,
    },
  ]);

  await diffthis(nvim);

  // now that both diff buffers are open, adjust the magenta window width again
  for (const window of magentaWindows) {
    await window.setWidth(WIDTH);
  }
}

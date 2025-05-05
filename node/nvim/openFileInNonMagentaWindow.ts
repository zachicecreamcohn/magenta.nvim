import type { Nvim } from "nvim-node";
import { getAllWindows, getcwd } from "../nvim/nvim";
import { NvimBuffer } from "../nvim/buffer";
import type { WindowId } from "../nvim/window";
import { WIDTH } from "../sidebar";
import type { MagentaOptions } from "../options";
import {
  resolveFilePath,
  type AbsFilePath,
  type UnresolvedFilePath,
} from "../utils/files";

export async function openFileInNonMagentaWindow(
  filePath: UnresolvedFilePath | AbsFilePath,
  context: { nvim: Nvim; options: MagentaOptions },
): Promise<void> {
  try {
    const windows = await getAllWindows(context.nvim);
    const nonMagentaWindows = [];
    const magentaWindows = [];

    // Find all non-magenta windows and magenta windows
    for (const window of windows) {
      const isMagenta = await window.getVar("magenta");
      if (!isMagenta) {
        nonMagentaWindows.push(window);
      } else {
        magentaWindows.push(window);
      }
    }

    let targetWindowId: WindowId | null = null;

    // Determine which window to use
    if (nonMagentaWindows.length === 1) {
      // If there's only one non-magenta window, use it
      targetWindowId = nonMagentaWindows[0].id;
    } else if (nonMagentaWindows.length > 1) {
      // If there are multiple non-magenta windows, use the first one
      targetWindowId = nonMagentaWindows[0].id;
    }

    const absFilePath = resolveFilePath(await getcwd(context.nvim), filePath);
    // Open the buffer in the target window or create a new window if needed
    const fileBuffer = await NvimBuffer.bufadd(absFilePath, context.nvim);

    if (targetWindowId) {
      // Open in the existing window
      await context.nvim.call("nvim_win_set_buf", [
        targetWindowId,
        fileBuffer.id,
      ]);
    } else if (nonMagentaWindows.length === 0 && magentaWindows.length > 0) {
      // Find the magenta display window by checking for magenta_display_window variable
      let magentaDisplayWindow = null;
      for (const window of magentaWindows) {
        const isDisplayWindow = await window.getVar("magenta_display_window");
        if (isDisplayWindow) {
          magentaDisplayWindow = window;
          break;
        }
      }

      // If found, open on the opposite side from where the sidebar is configured
      if (magentaDisplayWindow) {
        // Use the configured sidebarPosition from options
        const sidebarPosition = context.options.sidebarPosition;
        // Open on the opposite side
        const newWindowSide = sidebarPosition === "left" ? "right" : "left";

        // Open a new window on the appropriate side
        await context.nvim.call("nvim_open_win", [
          fileBuffer.id,
          true, // Enter the window
          {
            win: -1, // Global split
            split: newWindowSide,
            width: WIDTH,
            height: 0, // Uses default height
          },
        ]);
      } else {
        // No magenta display window found, fall back to default split
        await context.nvim.call("nvim_command", [`split ${absFilePath}`]);
      }
    } else {
      // No suitable window found, create a new one
      await context.nvim.call("nvim_command", [`split ${absFilePath}`]);
    }
  } catch (error) {
    context.nvim.logger?.error(
      `Error opening file ${filePath}: ${(error as Error).message}`,
    );
  }
}

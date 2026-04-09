import { describe, expect, it } from "vitest";
import type { BufNr } from "./nvim/buffer.ts";
import type { WindowId } from "./nvim/window.ts";
import { withDriver } from "./test/preamble.ts";
import { pollUntil } from "./utils/async.ts";

describe("node/buf-enter.test.ts", () => {
  describe("non-magenta buffer in magenta window", () => {
    it("should eject a non-magenta buffer from the display window and restore the magenta buffer", async () => {
      await withDriver({}, async (driver) => {
        // Open a file first so we have a non-magenta window, then show sidebar
        await driver.editFile("poem.txt");
        const poemBufId = (await driver.nvim.call(
          "nvim_get_current_buf",
          [],
        )) as BufNr;

        await driver.showSidebar();
        const { displayWindow, inputWindow } = driver.getVisibleState();
        const expectedDisplayBufId = driver.getDisplayBuffer().id;

        // Switch to the display window, then open the poem buffer there.
        // This triggers BufEnter for a non-magenta buffer in a magenta window.
        await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
        await driver.nvim.call("nvim_win_set_buf", [
          displayWindow.id,
          poemBufId,
        ]);

        // Wait for the handler to restore the magenta buffer in the display window
        await pollUntil(async () => {
          const currentBufId = (await driver.nvim.call("nvim_win_get_buf", [
            displayWindow.id,
          ])) as BufNr;
          if (currentBufId !== expectedDisplayBufId) {
            throw new Error(
              `Display window still has buffer ${currentBufId}, expected ${expectedDisplayBufId}`,
            );
          }
        });

        // Verify the poem.txt was moved to a non-magenta window
        const windows = (await driver.nvim.call(
          "nvim_list_wins",
          [],
        )) as WindowId[];
        let poemFoundInNonMagentaWindow = false;
        for (const winId of windows) {
          if (winId === displayWindow.id || winId === inputWindow.id) continue;
          const bufId = (await driver.nvim.call("nvim_win_get_buf", [
            winId,
          ])) as BufNr;
          if (bufId === poemBufId) {
            poemFoundInNonMagentaWindow = true;
            break;
          }
        }
        expect(poemFoundInNonMagentaWindow).toBe(true);
      });
    });

    it("should eject a non-magenta buffer from the input window", async () => {
      await withDriver({}, async (driver) => {
        await driver.editFile("poem.txt");
        const poemBufId = (await driver.nvim.call(
          "nvim_get_current_buf",
          [],
        )) as BufNr;

        await driver.showSidebar();
        const { inputWindow } = driver.getVisibleState();
        const expectedInputBufId = driver.getInputBuffer().id;

        // Switch to the input window, then open poem there
        await driver.nvim.call("nvim_set_current_win", [inputWindow.id]);
        await driver.nvim.call("nvim_win_set_buf", [inputWindow.id, poemBufId]);

        // Wait for the handler to restore the magenta input buffer
        await pollUntil(async () => {
          const currentBufId = (await driver.nvim.call("nvim_win_get_buf", [
            inputWindow.id,
          ])) as BufNr;
          if (currentBufId !== expectedInputBufId) {
            throw new Error(
              `Input window still has buffer ${currentBufId}, expected ${expectedInputBufId}`,
            );
          }
        });
      });
    });
  });

  it("should create a new window when ejecting a buffer with only magenta windows visible", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { displayWindow, inputWindow } = driver.getVisibleState();
      const expectedDisplayBufId = driver.getDisplayBuffer().id;

      // Close all non-magenta windows so only magenta windows remain
      const allWindows = (await driver.nvim.call(
        "nvim_list_wins",
        [],
      )) as WindowId[];
      for (const winId of allWindows) {
        if (winId === displayWindow.id || winId === inputWindow.id) continue;
        await driver.nvim.call("nvim_win_close", [winId, true]);
      }
      await driver.assertWindowCount(2);

      // Open a file in the display window — the only place nvim can put it
      await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
      await driver.command("edit poem.txt");

      // Wait for the handler to restore the magenta buffer in the display window
      await pollUntil(async () => {
        const currentBufId = (await driver.nvim.call("nvim_win_get_buf", [
          displayWindow.id,
        ])) as BufNr;
        if (currentBufId !== expectedDisplayBufId) {
          throw new Error(
            `Display window has buffer ${currentBufId}, expected magenta buffer ${expectedDisplayBufId}`,
          );
        }
      });

      // A new non-magenta window should have been created with poem.txt
      await driver.assertWindowCount(
        3,
        "Expected a new non-magenta window to be created for poem.txt",
      );
      const windowsAfter = (await driver.nvim.call(
        "nvim_list_wins",
        [],
      )) as WindowId[];

      // Find the new window and verify it has poem.txt
      let poemWindowFound = false;
      for (const winId of windowsAfter) {
        if (winId === displayWindow.id || winId === inputWindow.id) continue;
        const bufId = await driver.nvim.call("nvim_win_get_buf", [winId]);
        const bufName = (await driver.nvim.call("nvim_buf_get_name", [
          bufId,
        ])) as string;
        if (bufName.includes("poem.txt")) {
          poemWindowFound = true;
        }
      }
      expect(poemWindowFound).toBe(true);
    });
  });

  describe("magenta buffer in non-magenta window", () => {
    it("should switch sidebar to the correct thread when a magenta display buffer is opened in a code window", async () => {
      await withDriver({}, async (driver) => {
        // Open a file first so there's a non-magenta window
        await driver.editFile("poem.txt");
        const codeWinId = (await driver.nvim.call(
          "nvim_get_current_win",
          [],
        )) as WindowId;

        await driver.showSidebar();
        const { displayWindow } = driver.getVisibleState();

        const thread1Id = driver.getThreadId(0);
        await driver.magenta.command("new-thread");
        await driver.awaitThreadCount(2);
        const thread2Id = driver.getThreadId(1);

        await driver.awaitChatState({
          state: "thread-selected",
          id: thread2Id,
        });

        // Get thread 1's display buffer
        const thread1Buffers =
          driver.magenta.bufferManager.getThreadBuffers(thread1Id);
        expect(thread1Buffers).toBeDefined();
        const thread1DisplayBufId = thread1Buffers!.displayBuffer.id;

        // Switch to the code window, then open thread 1's display buffer there
        await driver.nvim.call("nvim_set_current_win", [codeWinId]);

        // Open thread 1's display buffer in the code window (current window).
        // This triggers BufEnter for a magenta buffer in a non-magenta window.
        await driver.nvim.call("nvim_win_set_buf", [
          codeWinId,
          thread1DisplayBufId,
        ]);

        // Wait for the sidebar to switch to thread 1
        await driver.awaitChatState({
          state: "thread-selected",
          id: thread1Id,
        });

        // The code window should no longer have the magenta buffer
        await pollUntil(async () => {
          const codeBufId = (await driver.nvim.call("nvim_win_get_buf", [
            codeWinId,
          ])) as BufNr;
          if (codeBufId === thread1DisplayBufId) {
            throw new Error("Code window still has the magenta buffer");
          }
        });

        // The display window should now show thread 1's buffer
        await pollUntil(async () => {
          const displayBufId = (await driver.nvim.call("nvim_win_get_buf", [
            displayWindow.id,
          ])) as BufNr;
          if (displayBufId !== thread1DisplayBufId) {
            throw new Error(
              `Display window has buffer ${displayBufId}, expected thread 1's buffer ${thread1DisplayBufId}`,
            );
          }
        });
      });
    });
  });
});

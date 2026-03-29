import fs from "node:fs";
import * as os from "node:os";
import type {
  ProviderMessage,
  ProviderMessageContent,
  Row0Indexed,
  ToolName,
  ToolRequestId,
} from "@magenta/core";
import {
  type HomeDir,
  pollUntil,
  resolveFilePath,
  type UnresolvedFilePath,
} from "@magenta/core";
import { describe, expect, it } from "vitest";
import type { Line } from "../nvim/buffer.ts";
import { getAllWindows, getcwd } from "../nvim/nvim.ts";
import { withDriver } from "../test/preamble.ts";
import type { DiffUpdate } from "./context-manager.ts";

it("returns diff when file is edited in a buffer", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager = driver.magenta.chat.getActiveThread().contextManager;

    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "poem.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    // Add file to context using the helper method
    await driver.addContextFiles("poem.txt");

    // First, edit the file to track the buffer
    await driver.editFile("poem.txt");
    await contextManager.getContextUpdate();

    const window = await driver.findWindow(async (w) => {
      const buffer = await w.buffer();
      const bufName = await buffer.getName();
      return bufName.indexOf("poem.txt") > -1;
    });
    const buffer = await window.buffer();
    await buffer.setLines({
      start: 0 as Row0Indexed,
      end: 1 as Row0Indexed,
      lines: ["Edited moonlight dances through the trees," as Line],
    });

    // Get context updates after the edit
    const updates = await contextManager.getContextUpdate();
    const update = updates[absFilePath];
    // Check that it's a diff update
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status === "ok") {
      expect(update.update.value.type).toBe("diff");
      expect(update.absFilePath).toBe(absFilePath);
      // Check that the diff contains the change
      expect((update.update.value as DiffUpdate).patch).toContain(
        "Edited moonlight",
      );
      expect((update.update.value as DiffUpdate).patch).toContain(
        "Moonlight whispers",
      );
    }
  });
});

it("returns error when both buffer and disk change after agentView set", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    const contextManager = driver.magenta.chat.getActiveThread().contextManager;

    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "poem.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    await driver.addContextFiles("poem.txt");
    await driver.editFile("poem.txt");

    // Initial read to establish agentView and buffer tracking
    await contextManager.getContextUpdate();

    // Edit the buffer (without saving)
    const window = await driver.findWindow(async (w) => {
      const buffer = await w.buffer();
      const bufName = await buffer.getName();
      return bufName.indexOf("poem.txt") > -1;
    });
    const buffer = await window.buffer();
    await buffer.setLines({
      start: 0 as Row0Indexed,
      end: 1 as Row0Indexed,
      lines: ["Buffer edit" as Line],
    });

    // Also modify the file on disk directly
    const filePath = `${cwd}/poem.txt`;
    fs.writeFileSync(filePath, "Disk edit\n");

    // Context update should return an error for this file
    const updates = await contextManager.getContextUpdate();
    const update = updates[absFilePath];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("error");
    if (update.update.status === "error") {
      expect(update.update.error).toContain("Both");
    }
  });
});

describe("key bindings", () => {
  it("'dd' key correctly removes the middle file when three files are in context", async () => {
    await withDriver({}, async (driver) => {
      // Open context sidebar
      await driver.showSidebar();

      await driver.addContextFiles("poem 3.txt", "poem2.txt", "poem.txt");

      // Press dd on the middle file to remove it
      await driver.triggerDisplayBufferKeyOnContent(`- \`poem2.txt\``, "dd");

      // Wait for the file to be removed from context
      await pollUntil(async () => {
        const content = await driver.getDisplayBufferText();
        if (content.includes(`- \`poem2.txt\``)) {
          throw new Error("Context file not yet removed");
        }
        if (
          !content.includes(`- \`poem 3.txt\``) ||
          !content.includes(`- \`poem.txt\``)
        ) {
          throw new Error("Other context files should still be present");
        }
      });
    });
  });

  it("'Enter' key opens file in existing non-magenta window", async () => {
    await withDriver({}, async (driver) => {
      const normalWindow = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return name === "";
      });

      // Open context sidebar
      await driver.showSidebar();

      // Add file to context using the helper method
      await driver.addContextFiles("poem.txt");

      await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");

      await driver.assertWindowCount(
        3,
        "3 windows - display, input and non-magenta window with the buffer open",
      );

      // Verify file is opened in the non-magenta window
      await pollUntil(async () => {
        const winBuffer = await normalWindow.buffer();
        const bufferName = await winBuffer.getName();
        if (!bufferName.includes("poem.txt")) {
          throw new Error(
            `Expected buffer name to contain poem.txt, got ${bufferName}`,
          );
        }
      });
    });
  });

  it("'Enter' key opens file with multiple non-magenta windows", async () => {
    await withDriver({}, async (driver) => {
      await driver.nvim.call("nvim_command", ["new second_window"]);

      await driver.showSidebar();

      // Add file to context using the helper method
      await driver.addContextFiles("poem.txt");

      await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");
      await driver.assertWindowCount(4);

      const poemWindow = await driver.findWindow(async (w) => {
        const buffer = await w.buffer();
        const name = await buffer.getName();
        return name.indexOf("poem.txt") > -1;
      });

      const isMagenta = await poemWindow.getVar("magenta");
      expect(isMagenta, "we opened in a non-magenta window").toBeFalsy();
    });
  });

  it("'Enter' key opens file when sidebar is on the left", async () => {
    await withDriver(
      { options: { sidebarPosition: "left" } },
      async (driver) => {
        const initialWindow = (await getAllWindows(driver.nvim))[0];
        await driver.showSidebar();
        await driver.nvim.call("nvim_win_close", [initialWindow.id, true]);
        expect(
          (await getAllWindows(driver.nvim)).length,
          "now only magenta windows open",
        ).toBe(2);

        await driver.addContextFiles("poem.txt");

        const displayWindow = driver.getVisibleState().displayWindow;

        // Get position of the file line to click on
        await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");

        await driver.assertWindowCount(3, "Enter should open a new window");

        const fileWindow = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return name.includes("poem.txt");
        });
        expect(fileWindow).toBeDefined();

        // Verify window position is on the right (col index 1 is higher for windows on the right)
        const fileWinPos = await fileWindow.getPosition();
        const displayWinPos = await displayWindow.getPosition();
        expect(fileWinPos[1]).toBeGreaterThan(displayWinPos[1]);
      },
    );
  });

  it("'Enter' key opens file when sidebar is on the right", async () => {
    await withDriver(
      { options: { sidebarPosition: "right" } },
      async (driver) => {
        const initialWindow = (await getAllWindows(driver.nvim))[0];
        await driver.showSidebar();
        await driver.nvim.call("nvim_win_close", [initialWindow.id, true]);
        expect(
          (await getAllWindows(driver.nvim)).length,
          "now only magenta windows open",
        ).toBe(2);

        await driver.addContextFiles("poem.txt");

        const displayWindow = driver.getVisibleState().displayWindow;

        // Get position of the file line to click on
        await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");

        await driver.assertWindowCount(3, "Enter should open a new window");

        const fileWindow = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return name.includes("poem.txt");
        });
        expect(fileWindow).toBeDefined();

        // Verify window position is on the left (col index 1 is lower for windows on the left)
        const fileWinPos = await fileWindow.getPosition();
        const displayWinPos = await displayWindow.getPosition();
        expect(fileWinPos[1]).toBeLessThan(displayWinPos[1]);
      },
    );
  });
});

it("context-files end-to-end", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.addContextFiles("poem.txt");

    await driver.assertDisplayBufferContains(`\
# context:
- \`poem.txt\``);

    await driver.inputMagentaText("check out this file");
    await driver.send();
    const request = await driver.mockAnthropic.awaitPendingUserRequest();
    expect(request.messages).toMatchSnapshot();
  });
});

it("handles file deletion during buffer tracking", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager = driver.magenta.chat.getActiveThread().contextManager;

    const cwd = await getcwd(driver.nvim);
    const tempFilePath = resolveFilePath(
      cwd,
      "temp-tracked.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    // Create a temporary file
    await fs.promises.writeFile(tempFilePath, "tracked content");

    // Add file to context using the helper method
    await driver.addContextFiles("temp-tracked.txt");

    // Open the file in a buffer to start tracking it
    await driver.editFile("temp-tracked.txt");

    // Get initial context update to establish buffer tracking
    const firstUpdates = await contextManager.getContextUpdate();
    expect(firstUpdates[tempFilePath]).toBeDefined();

    // Delete the file while it's being tracked
    await fs.promises.unlink(tempFilePath);

    // Get context updates after deletion
    const secondUpdates = await contextManager.getContextUpdate();

    // File should be removed from context and file-deleted update should be returned
    expect(contextManager.files[tempFilePath]).toBeUndefined();
    expect(secondUpdates[tempFilePath]).toBeDefined();
    expect(secondUpdates[tempFilePath].update.status).toBe("ok");
    if (secondUpdates[tempFilePath].update.status === "ok") {
      expect(secondUpdates[tempFilePath].update.value.type).toBe(
        "file-deleted",
      );
    }
  });
});

it("issuing a getFile request adds the file to the context but doesn't send its contents twice", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager = driver.magenta.chat.getActiveThread().contextManager;

    // Verify context is empty initially
    expect(contextManager.files).toEqual({});

    // Issue a getFile request for a binary file
    await driver.inputMagentaText(`Please analyze the image test.jpg`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "I'll analyze the image",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "img_request" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "test.jpg" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`✅ \`test.jpg\``);

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    const providerMessages = toolResultRequest.getProviderMessages();

    const flattenedMessages = providerMessages.flatMap((msg) =>
      msg.content.map(
        (content) =>
          `${msg.role};${content.type};${content.type === "text" ? content.text : ""}`,
      ),
    );

    expect(flattenedMessages).toEqual([
      "user;text;Please analyze the image test.jpg",
      "user;system_reminder;",
      "assistant;text;I'll analyze the image",
      "assistant;tool_use;",
      "user;tool_result;",
      "user;system_reminder;",
    ]);

    // Verify the tool result contains the file content exactly once
    // Now the file should be in context
    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "test.jpg" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );
    expect(contextManager.files[absFilePath]).toBeDefined();
    expect(contextManager.files[absFilePath].fileTypeInfo.category).toBe(
      "image",
    );
  });
});

it("autoContext loads on startup and after new-thread", async () => {
  const testOptions = {
    autoContext: [`test-auto-context.md`],
  };

  await withDriver({ options: testOptions }, async (driver) => {
    // Show sidebar and verify autoContext is loaded
    await driver.showSidebar();
    await driver.assertDisplayBufferContains(
      `# context:\n- \`test-auto-context.md\``,
    );

    // Create new thread and verify autoContext is loaded
    await driver.magenta.command("new-thread");
    await driver.assertDisplayBufferContains(
      `# context:\n- \`test-auto-context.md\``,
    );

    // Check that the content is included in messages when sending
    await driver.inputMagentaText("hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    expect(request.messages).toContainEqual(
      expect.objectContaining<ProviderMessage>({
        role: "user",

        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("test-auto-context.md"),
          }),
        ]) as ProviderMessageContent[],
      }),
    );
  });
});

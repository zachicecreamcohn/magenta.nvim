import { describe, expect, it } from "vitest";
import { TMP_DIR, withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async";
import { getAllWindows } from "../nvim/nvim";

describe("context-manager.spec.ts", () => {
  const testFilePath = `${TMP_DIR}/poem.txt`;

  describe("key bindings", () => {
    it("'dd' key correctly removes the middle file when three files are in context", async () => {
      await withDriver({}, async (driver) => {
        // Open context sidebar
        await driver.showSidebar();

        const poemFile = `${TMP_DIR}/poem.txt`;
        const poem3file = `${TMP_DIR}/poem 3.txt`;
        const contextFile = "context.md";

        await driver.nvim.call("nvim_command", [
          `Magenta context-files '${poem3file}' '${contextFile}' '${poemFile}'`,
        ]);

        // Wait for sidebar to update
        await driver.wait(250);

        await driver.assertDisplayBufferContains(
          `\
# context:
- \`${poem3file}\`
- \`${contextFile}\`
- \`${poemFile}\``,
        );

        const middleFilePos = await driver.assertDisplayBufferContains(
          `- \`${contextFile}\``,
        );

        // Press dd on the middle file to remove it
        await driver.triggerDisplayBufferKey(middleFilePos, "dd");

        // Wait for update
        await driver.wait(250);
        await driver.assertDisplayBufferContains(
          `\
# context:
- \`${poem3file}\`
- \`${poemFile}\``,
        );
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

        // Add file to context using the context-files command
        await driver.nvim.call("nvim_command", [
          `Magenta context-files '${testFilePath}'`,
        ]);

        const pos = await driver.assertDisplayBufferContains(
          `\`${testFilePath}\``,
        );

        await driver.triggerDisplayBufferKey(pos, "<CR>");

        // Wait for update
        await driver.wait(250);

        {
          const windows = await getAllWindows(driver.nvim);
          expect(
            windows.length,
            "3 windows - display, input and non-magenta window with the buffer open",
          ).toBe(3);
        }

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
        const firstWindow = (await getAllWindows(driver.nvim))[0];

        await driver.showSidebar();

        // Add file to context using the context-files command
        await driver.nvim.call("nvim_command", [
          `Magenta context-files '${testFilePath}'`,
        ]);

        const pos = await driver.assertDisplayBufferContains(
          `\`${testFilePath}\``,
        );

        await driver.triggerDisplayBufferKey(pos, "<CR>");

        await driver.wait(250);

        {
          const windows = await getAllWindows(driver.nvim);
          expect(windows.length, "There are 4 windows total").toBe(4);
        }

        const firstWindowBuffer = await firstWindow.buffer();
        const firstWindowBufferName = await firstWindowBuffer.getName();
        expect(
          firstWindowBufferName,
          "the file is opened in the first window",
        ).toContain("poem.txt");
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

          await driver.nvim.call("nvim_command", [
            `Magenta context-files '${testFilePath}'`,
          ]);

          const displayWindow = driver.getVisibleState().displayWindow;

          // Get position of the file line to click on
          const pos = await driver.assertDisplayBufferContains(
            `\`${testFilePath}\``,
          );

          await driver.triggerDisplayBufferKey(pos, "<CR>");
          await driver.wait(250);

          const windowsAfter = await getAllWindows(driver.nvim);
          expect(windowsAfter.length, "Enter should open a new window").toEqual(
            3,
          );

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

          await driver.nvim.call("nvim_command", [
            `Magenta context-files '${testFilePath}'`,
          ]);

          const displayWindow = driver.getVisibleState().displayWindow;

          // Get position of the file line to click on
          const pos = await driver.assertDisplayBufferContains(
            `\`${testFilePath}\``,
          );

          await driver.triggerDisplayBufferKey(pos, "<CR>");
          await driver.wait(250);

          const windowsAfter = await getAllWindows(driver.nvim);
          expect(windowsAfter.length, "Enter should open a new window").toEqual(
            3,
          );

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
      await driver.nvim.call("nvim_command", [
        `Magenta context-files './${TMP_DIR}/poem.txt'`,
      ]);

      await driver.assertDisplayBufferContains(`\
# context:
- \`${TMP_DIR}/poem.txt\``);

      await driver.inputMagentaText("check out this file");
      await driver.send();
      await pollUntil(() => {
        if (driver.mockAnthropic.requests.length != 1) {
          throw new Error(`Expected a message to be pending.`);
        }
      });
      const request =
        driver.mockAnthropic.requests[driver.mockAnthropic.requests.length - 1];
      expect(request.messages).toEqual([
        {
          content: [
            {
              type: "text",
              text: `\
Here are the contents of file \`${TMP_DIR}/poem.txt\`:
\`\`\`
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.

\`\`\``,
            },
          ],
          role: "user",
        },
        {
          content: [
            {
              text: "check out this file",
              type: "text",
            },
          ],
          role: "user",
        },
      ]);
    });
  });

  it("context-files multiple, weird path names", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.nvim.call("nvim_command", [
        `Magenta context-files './${TMP_DIR}/poem.txt' './${TMP_DIR}/poem 3.txt'`,
      ]);

      await driver.assertDisplayBufferContains(`\
# context:
- \`${TMP_DIR}/poem.txt\`
- \`${TMP_DIR}/poem 3.txt\``);

      await driver.inputMagentaText("check out this file");
      await driver.send();
      await pollUntil(() => {
        if (driver.mockAnthropic.requests.length != 1) {
          throw new Error(`Expected a message to be pending.`);
        }
      });
      const request =
        driver.mockAnthropic.requests[driver.mockAnthropic.requests.length - 1];
      expect(request.messages).toEqual([
        {
          content: [
            {
              type: "text",
              text: `\
Here are the contents of file \`${TMP_DIR}/poem 3.txt\`:
\`\`\`
poem3

\`\`\``,
            },
          ],
          role: "user",
        },
        {
          content: [
            {
              type: "text",
              text: `\
Here are the contents of file \`${TMP_DIR}/poem.txt\`:
\`\`\`
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.

\`\`\``,
            },
          ],
          role: "user",
        },
        {
          content: [
            {
              text: "check out this file",
              type: "text",
            },
          ],
          role: "user",
        },
      ]);
    });
  });

  it("context message insert position", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`hello`);
      await driver.send();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "sup?",
        toolRequests: [],
      });

      await driver.nvim.call("nvim_command", [
        `Magenta context-files './${TMP_DIR}/poem.txt'`,
      ]);

      await driver.inputMagentaText("check out this file");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      expect(request.messages).toEqual([
        {
          content: [
            {
              text: "hello",
              type: "text",
            },
          ],
          role: "user",
        },
        {
          content: [
            {
              text: "sup?",
              type: "text",
            },
          ],
          role: "assistant",
        },
        {
          content: [
            {
              type: "text",
              text: `\
Here are the contents of file \`${TMP_DIR}/poem.txt\`:
\`\`\`
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.

\`\`\``,
            },
          ],
          role: "user",
        },
        {
          content: [
            {
              text: "check out this file",
              type: "text",
            },
          ],
          role: "user",
        },
      ]);
    });
  });

  it("autoContext loads on startup and after clear", async () => {
    const testOptions = {
      autoContext: [`${TMP_DIR}/test-auto-context.md`],
    };

    await withDriver({ options: testOptions }, async (driver) => {
      // Show sidebar and verify autoContext is loaded
      await driver.showSidebar();
      await driver.assertDisplayBufferContains(
        `# context:\n- \`${TMP_DIR}/test-auto-context.md\``,
      );

      // Clear thread and verify autoContext is reloaded
      await driver.clear();
      await driver.assertDisplayBufferContains(
        `# context:\n- \`${TMP_DIR}/test-auto-context.md\``,
      );

      // Check that the content is included in messages when sending
      await driver.inputMagentaText("hello");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      // Check that file content is included in the request
      const fileContent = request.messages.find(
        (msg) =>
          msg.role === "user" &&
          typeof msg.content === "object" &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
          (msg.content[0] as any).text.includes("test-auto-context.md"),
      );
      expect(fileContent).toBeTruthy();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const text = (fileContent?.content[0] as any).text;
      expect(text).toContain("This is test auto-context content");
      expect(text).toContain("Multiple lines");
      expect(text).toContain("for testing");
    });
  });
});

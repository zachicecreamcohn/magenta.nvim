import { describe, expect, it } from "bun:test";
import { withDriver } from "./test/preamble";
import { pollUntil } from "./utils/async";
import type { Position0Indexed } from "./nvim/window";

describe("bun/magenta.spec.ts", () => {
  it("clear command should work", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`hello`);
      await driver.send();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "sup?",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContent(`\
# user:
hello

# assistant:
sup?

Stopped (end_turn)`);

      await driver.clear();
      await driver.assertDisplayBufferContent(`Stopped (end_turn)`);
      await driver.inputMagentaText(`hello again`);
      await driver.send();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "huh?",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContent(`\
# user:
hello again

# assistant:
huh?

Stopped (end_turn)`);
    });
  });

  it("abort command should work", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`hello`);
      await driver.send();
      await driver.assertDisplayBufferContent(`\
# user:
hello

Awaiting response ⠁`);

      await pollUntil(() => {
        if (driver.mockAnthropic.requests.length != 1) {
          throw new Error(`Expected a message to be pending.`);
        }
      });
      const request =
        driver.mockAnthropic.requests[driver.mockAnthropic.requests.length - 1];
      expect(request.defer.resolved).toBe(false);

      await driver.abort();
      expect(request.defer.resolved).toBe(true);
    });
  });

  it("can set provider", async () => {
    await withDriver(async (driver) => {
      {
        const state = driver.magenta.chatApp.getState();
        if (state.status != "running") {
          throw new Error(`Expected state to be running`);
        }

        expect(state.model.activeProvider).toBe("anthropic");
      }
      await driver.showSidebar();
      const displayState = driver.getVisibleState();
      {
        const winbar = await displayState.inputWindow.getOption("winbar");
        expect(winbar).toBe(`Magenta Input (anthropic)`);
      }
      await driver.nvim.call("nvim_command", ["Magenta provider openai"]);
      {
        const state = driver.magenta.chatApp.getState();
        if (state.status != "running") {
          throw new Error(`Expected state to be running`);
        }

        expect(state.model.activeProvider).toBe("openai");
      }
      {
        const winbar = await displayState.inputWindow.getOption("winbar");
        expect(winbar).toBe(`Magenta Input (openai)`);
      }
    });
  });

  it("paste-selection command", async () => {
    await withDriver(async (driver) => {
      await driver.editFile("bun/test/fixtures/poem.txt");
      await driver.selectRange(
        { row: 0, col: 5 } as Position0Indexed,
        { row: 2, col: 10 } as Position0Indexed,
      );

      await driver.pasteSelection();
      await driver.assertInputBufferContains(`
Here is a snippet from the file \`bun/test/fixtures/poem.txt\`
\`\`\`txt
ight whispers through the trees,
Silver shadows dance with ease.
Stars above
\`\`\`
`);
    });
  });

  it("context-files end-to-end", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.nvim.call("nvim_command", [
        "Magenta context-files './bun/test/fixtures/poem.txt'",
      ]);

      await driver.assertDisplayBufferContains(`\
# context:
file: \`./bun/test/fixtures/poem.txt\``);

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
          content: `\
Here are the contents of file \`bun/test/fixtures/poem.txt\`:
\`\`\`
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.

\`\`\``,
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
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.nvim.call("nvim_command", [
        "Magenta context-files './bun/test/fixtures/poem.txt' './bun/test/fixtures/poem 3.txt'",
      ]);

      await driver.assertDisplayBufferContains(`\
# context:
file: \`./bun/test/fixtures/poem.txt\`
file: \`./bun/test/fixtures/poem 3.txt\``);

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
          content: `\
Here are the contents of file \`bun/test/fixtures/poem 3.txt\`:
\`\`\`
poem3

\`\`\``,
          role: "user",
        },
        {
          content: `\
Here are the contents of file \`bun/test/fixtures/poem.txt\`:
\`\`\`
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.

\`\`\``,
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
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`hello`);
      await driver.send();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "sup?",
        toolRequests: [],
      });

      await driver.nvim.call("nvim_command", [
        "Magenta context-files './bun/test/fixtures/poem.txt'",
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
          content: `\
Here are the contents of file \`bun/test/fixtures/poem.txt\`:
\`\`\`
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.

\`\`\``,
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
});

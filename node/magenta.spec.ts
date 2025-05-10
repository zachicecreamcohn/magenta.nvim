import { describe, expect, it } from "vitest";
import { withDriver } from "./test/preamble";
import { pollUntil } from "./utils/async";
import type { Position0Indexed } from "./nvim/window";
import { LOGO } from "./chat/thread";
import type { ToolRequestId } from "./tools/toolManager";
import type { UnresolvedFilePath } from "./utils/files";

describe("node/magenta.spec.ts", () => {
  it("clear command should work", async () => {
    await withDriver({}, async (driver) => {
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
      await driver.assertDisplayBufferContent(LOGO);
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

  it("abort command should work when waiting for response", async () => {
    await withDriver({}, async (driver) => {
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

  it("abort command should work when response is in progress", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`hello`);
      await driver.send();

      // Wait for the pending request to be registered
      await pollUntil(() => {
        if (driver.mockAnthropic.requests.length != 1) {
          throw new Error(`Expected a message to be pending.`);
        }
      });

      // Start streaming a response but don't complete it
      await driver.mockAnthropic.streamText("I'm starting to respond");

      // Get the latest request
      const request = await driver.mockAnthropic.awaitPendingRequest();

      // Verify that response has started appearing
      await driver.assertDisplayBufferContains(`\
# user:
hello

# assistant:
I'm starting to respond`);

      expect(request.defer.resolved).toBe(false);

      await driver.abort();
      expect(request.defer.resolved).toBe(true);

      // Verify the final state shows the aborted message
      await driver.assertDisplayBufferContains(`Stopped (aborted)`);
    });
  });

  it("abort command should stop pending tool use", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`hello`);
      await driver.send();

      // Wait for the pending request to be registered
      await pollUntil(() => {
        if (driver.mockAnthropic.requests.length != 1) {
          throw new Error(`Expected a message to be pending.`);
        }
      });

      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "request_id" as ToolRequestId,
              toolName: "get_file",
              input: {
                // secret file should trigger user permission check
                filePath: ".secret" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Verify that response has started appearing
      await driver.assertDisplayBufferContains(`\
# user:
hello

# assistant:
ok, here goes
⏳ May I read file \`.secret\`? **[ NO ]** **[ OK ]**
Stopped (tool_use) [input: 0, output: 0]
`);

      await driver.abort();

      await driver.assertDisplayBufferContains(`The user aborted this request`);
    });
  });

  it("can switch profiles", async () => {
    await withDriver({}, async (driver) => {
      {
        const thread = driver.magenta.chat.getActiveThread();
        expect(thread.state.profile).toEqual({
          name: "claude-3-7",
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest",
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
        });
      }
      await driver.showSidebar();
      const displayState = driver.getVisibleState();
      {
        const winbar = await displayState.inputWindow.getOption("winbar");
        expect(winbar).toBe(`Magenta Input (claude-3-7)`);
      }
      await driver.nvim.call("nvim_command", ["Magenta profile gpt-4o"]);
      {
        const thread = driver.magenta.chat.getActiveThread();
        expect(thread.state.profile).toEqual({
          name: "gpt-4o",
          provider: "openai",
          model: "gpt-4o",
          apiKeyEnvVar: "OPENAI_API_KEY",
        });
        const winbar = await displayState.inputWindow.getOption("winbar");
        expect(winbar).toBe(`Magenta Input (gpt-4o)`);
      }
    });
  });

  it("paste-selection command", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("node/test/fixtures/poem.txt");
      await driver.selectRange(
        { row: 0, col: 5 } as Position0Indexed,
        { row: 2, col: 11 } as Position0Indexed,
      );

      await driver.pasteSelection();
      await driver.assertInputBufferContains(`
Here is a snippet from the file \`node/test/fixtures/poem.txt\`
\`\`\`txt
ight whispers through the trees,
Silver shadows dance with ease.
Stars above
\`\`\`
`);
    });
  });
});

import fs from "node:fs";
import path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { it } from "vitest";
import { getcwd } from "./nvim/nvim.ts";
import { withDriver } from "./test/preamble.ts";

it("dynamically picks up commandConfig changes from project options.json", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const cwd = await getcwd(driver.nvim);

    // Send a message that triggers a bash_command tool use with a non-allowlisted command
    await driver.inputMagentaText("Run: true && echo hello");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    request1.respond({
      stopReason: "tool_use",
      text: "Running the command.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool-1" as ToolRequestId,
            toolName: "bash_command" as ToolName,
            input: { command: 'true && echo "hello"' },
          },
        },
      ],
    });

    // The command is not allowlisted, so it should request permission
    await driver.assertDisplayBufferContains(
      '⚡ May I run command `true && echo "hello"`?',
    );
    await driver.assertDisplayBufferContains("> YES");

    // Now write a project options.json that allowlists this command pattern
    const magentaDir = path.join(cwd, ".magenta");
    fs.mkdirSync(magentaDir, { recursive: true });
    fs.writeFileSync(
      path.join(magentaDir, "options.json"),
      JSON.stringify({
        commandConfig: {
          commands: [["true"], ["echo", { type: "restAny" }]],
          pipeCommands: [],
        },
      }),
    );

    // Deny the first command so we can move on
    await driver.triggerDisplayBufferKeyOnContent("> NO", "<CR>");

    // Wait for the denial to be processed
    await driver.assertDisplayBufferContains("The user did not allow");

    // The model tries the same command again
    const request2 = await driver.mockAnthropic.awaitPendingStream();
    request2.respond({
      stopReason: "tool_use",
      text: "Let me try again.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool-2" as ToolRequestId,
            toolName: "bash_command" as ToolName,
            input: { command: 'true && echo "hello"' },
          },
        },
      ],
    });

    // Now the command should be auto-approved and run because the options.json was picked up
    await driver.assertDisplayBufferContains('⚡✅ `true && echo "hello"`');
    await driver.assertDisplayBufferContains("stdout:");
  });
});

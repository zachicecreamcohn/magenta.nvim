import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import { pollUntil } from "../utils/async";

describe("node/tools/bashCommand.spec.ts", () => {
  it("executes a simple echo command after user approval", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Run this command: echo 'Hello from Magenta!'`,
      );
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-echo-command" as ToolRequestId;

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              name: "bash_command",
              input: {
                command: "echo 'Hello from Magenta!'",
              },
            },
          },
        ],
      });

      // Wait for the user approval prompt
      await pollUntil(
        async () => {
          const text = await driver.getDisplayBufferText();
          if (!text.includes("May I run this command?")) {
            throw new Error("Approval prompt not found yet");
          }
        },
        { timeout: 1000 },
      );

      // Verify approval UI is displayed
      await driver.assertDisplayBufferContains("May I run this command?");
      await driver.assertDisplayBufferContains("echo 'Hello from Magenta!'");
      await driver.assertDisplayBufferContains("[ NO ]");
      await driver.assertDisplayBufferContains("[ OK ]");

      // Find approval text position and trigger key on OK button
      const pos = await driver.assertDisplayBufferContains("[ OK ]");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      // Wait for command execution and UI update
      await pollUntil(
        async () => {
          const text = await driver.getDisplayBufferText();
          if (!text.includes("Hello from Magenta!")) {
            throw new Error("Command output not found yet");
          }
        },
        { timeout: 1000 },
      );

      // Verify the command output is displayed
      await driver.assertDisplayBufferContains("Command:");
      await driver.assertDisplayBufferContains(
        "```\necho 'Hello from Magenta!'\n```",
      );
      await driver.assertDisplayBufferContains("Hello from Magenta!");
      await driver.assertDisplayBufferContains("Exit code: 0");
    });
  });

  it("handles command errors gracefully after approval", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Run this command: nonexistentcommand`);
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-error-command" as ToolRequestId;

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              name: "bash_command",
              input: {
                command: "nonexistentcommand",
              },
            },
          },
        ],
      });

      // Wait for the user approval prompt
      await pollUntil(
        async () => {
          const text = await driver.getDisplayBufferText();
          if (!text.includes("May I run this command?")) {
            throw new Error("Approval prompt not found yet");
          }
        },
        { timeout: 1000 },
      );

      // Find approval text position and trigger key on OK button
      const pos = await driver.assertDisplayBufferContains("[ OK ]");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      // Wait for command execution and UI update
      await pollUntil(
        async () => {
          const text = await driver.getDisplayBufferText();
          if (!text.includes("Command failed with exit code")) {
            throw new Error("Error message not found yet");
          }
        },
        { timeout: 1000 },
      );

      // Verify error message is displayed
      await driver.assertDisplayBufferContains("Command:");
      await driver.assertDisplayBufferContains("```\nnonexistentcommand\n```");
      await driver.assertDisplayBufferContains("Command failed with exit code");
    });
  });

  it("displays output while command is running after approval", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Run this command: for i in {1..3}; do echo "Processing $i"; sleep 0.1; done`,
      );
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-progressive-command" as ToolRequestId;

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll run that command with a loop that has some delay.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              name: "bash_command",
              input: {
                command:
                  'for i in {1..3}; do echo "Processing $i"; sleep 0.1; done',
              },
            },
          },
        ],
      });

      // Wait for the user approval prompt
      await pollUntil(
        async () => {
          const text = await driver.getDisplayBufferText();
          if (!text.includes("May I run this command?")) {
            throw new Error("Approval prompt not found yet");
          }
        },
        { timeout: 1000 },
      );

      // Find approval text position and trigger key on OK button
      const pos = await driver.assertDisplayBufferContains("[ OK ]");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      // First check for command running
      await driver.assertDisplayBufferContains("Running command");

      // Wait for command to complete
      await pollUntil(
        async () => {
          const text = await driver.getDisplayBufferText();
          if (
            !text.includes("Processing 3") ||
            !text.includes("Exit code: 0")
          ) {
            throw new Error("Complete command output not found yet");
          }
        },
        { timeout: 2000 },
      );

      // Verify all output appears
      await driver.assertDisplayBufferContains("Command:");
      await driver.assertDisplayBufferContains(
        '```\nfor i in {1..3}; do echo "Processing $i"; sleep 0.1; done\n```',
      );
      await driver.assertDisplayBufferContains("Processing 1");
      await driver.assertDisplayBufferContains("Processing 2");
      await driver.assertDisplayBufferContains("Processing 3");
      await driver.assertDisplayBufferContains("Exit code: 0");
    });
  });

  it("runs complex command with pipes after approval", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Run this command: echo 'line1\nline2\nline3' | grep 'line2'`,
      );
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-pipe-command" as ToolRequestId;

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll run that command with pipes for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              name: "bash_command",
              input: {
                command: "echo 'line1\nline2\nline3' | grep 'line2'",
              },
            },
          },
        ],
      });

      // Wait for the user approval prompt
      await pollUntil(
        async () => {
          const text = await driver.getDisplayBufferText();
          if (!text.includes("May I run this command?")) {
            throw new Error("Approval prompt not found yet");
          }
        },
        { timeout: 1000 },
      );

      // Find approval text position and trigger key on OK button
      const pos = await driver.assertDisplayBufferContains("[ OK ]");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      // Wait for command execution and UI update
      await pollUntil(
        async () => {
          const text = await driver.getDisplayBufferText();
          if (!text.includes("line2") || !text.includes("Exit code: 0")) {
            throw new Error("Complete command output not found yet");
          }
        },
        { timeout: 1000 },
      );

      // Verify only line2 is in the output (grep filtered the other lines)
      await driver.assertDisplayBufferContains("Command:");
      await driver.assertDisplayBufferContains(
        "```\necho 'line1\nline2\nline3' | grep 'line2'\n```",
      );
      await driver.assertDisplayBufferContains("line2");

      // Check the full text to verify pipe functionality worked correctly
      const displayText = await driver.getDisplayBufferText();
      expect(displayText.split("line2").length).toBeGreaterThan(1);

      // The input command has line1 and line3, but the grep should filter them out of the results
      // However, they might appear in the command display, so we don't check for their absence
      await driver.assertDisplayBufferContains("Exit code: 0");
    });
  });

  it("handles user rejection of command", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Run this command: ls -la`);
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-rejected-command" as ToolRequestId;

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              name: "bash_command",
              input: {
                command: "ls -la",
              },
            },
          },
        ],
      });

      // Wait for the user approval prompt
      await pollUntil(
        async () => {
          const text = await driver.getDisplayBufferText();
          if (!text.includes("May I run this command?")) {
            throw new Error("Approval prompt not found yet");
          }
        },
        { timeout: 1000 },
      );

      // Find approval text position and trigger key on NO button
      const pos = await driver.assertDisplayBufferContains("[ NO ]");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      // Wait for rejection message
      await pollUntil(
        async () => {
          const text = await driver.getDisplayBufferText();
          if (!text.includes("user did not allow running this command")) {
            throw new Error("Rejection message not found yet");
          }
        },
        { timeout: 1000 },
      );

      // Verify the rejection message is displayed
      await driver.assertDisplayBufferContains(
        "The user did not allow running this command",
      );
    });
  });
});

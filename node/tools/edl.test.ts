import { test, expect, describe } from "vitest";
import { withDriver, assertToolResultContainsText } from "../test/preamble.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolRequestId, ToolName } from "./types.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { MockProvider } from "../providers/mock.ts";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;

describe("edl tool", () => {
  test("can execute a successful script", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("run edl script");
        await driver.send();

        const filePath = path.join(dirs.tmpDir, "test.txt");
        const script = `file \`${filePath}\`
select_one /hello/
replace <<END
goodbye
END`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll run an EDL script",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains(
          "📝✅ edl: 1 mutations in 1 file",
        );

        const resultStream = await driver.mockAnthropic.awaitPendingStream();
        const toolResultMessage = MockProvider.findLastToolResultMessage(
          resultStream.messages,
        );
        expect(toolResultMessage).toBeDefined();

        const content = toolResultMessage!.content as ContentBlockParam[];
        const toolResult = content.find(
          (c): c is ToolResultBlockParam => c.type === "tool_result",
        );
        expect(toolResult).toBeDefined();
        expect(toolResult!.is_error).toBeFalsy();
        assertToolResultContainsText(toolResult!, "Mutations:");

        const fileContent = await fs.readFile(filePath, "utf-8");
        expect(fileContent).toBe("goodbye world\n");
      },
    );
  });

  test("returns error on parse error", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("run edl script");
      await driver.send();

      const script = `file \`test.txt\`
invalid_command`;

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "tool_use",
        text: "I'll run an EDL script",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tool_1" as ToolRequestId,
              toolName: "edl" as ToolName,
              input: { script },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("📝❌ edl script");

      const resultStream = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        resultStream.messages,
      );
      expect(toolResultMessage).toBeDefined();

      const content = toolResultMessage!.content as ContentBlockParam[];
      const toolResult = content.find(
        (c): c is ToolResultBlockParam => c.type === "tool_result",
      );
      expect(toolResult).toBeDefined();
      expect(toolResult!.is_error).toBe(true);
      expect(toolResult!.content).toContain("Parse error");
    });
  });

  test("returns error on execution error", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("run edl script");
        await driver.send();

        const filePath = path.join(dirs.tmpDir, "test.txt");
        const script = `file \`${filePath}\`
select_one /nonexistent pattern that does not exist/`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll run an EDL script",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("📝❌ edl script");

        const resultStream = await driver.mockAnthropic.awaitPendingStream();
        const toolResultMessage = MockProvider.findLastToolResultMessage(
          resultStream.messages,
        );
        expect(toolResultMessage).toBeDefined();

        const content = toolResultMessage!.content as ContentBlockParam[];
        const toolResult = content.find(
          (c): c is ToolResultBlockParam => c.type === "tool_result",
        );
        expect(toolResult).toBeDefined();
        expect(toolResult!.is_error).toBe(true);
        expect(toolResult!.content).toContain("Error:");
      },
    );
  });

  test("shows mutation summary in display", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("run edl script");
        await driver.send();

        const filePath = path.join(dirs.tmpDir, "test.txt");
        const script = `file \`${filePath}\`
select_one /hello/
replace <<END
goodbye
END`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll run an EDL script",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        // Summary should show mutation count
        await driver.assertDisplayBufferContains(
          "📝✅ edl: 1 mutations in 1 file",
        );

        // Preview should show per-file stats
        await driver.assertDisplayBufferContains("1 replace");
        await driver.assertDisplayBufferContains("Final selection: 1 range");
      },
    );
  });

  test("toggles between preview and detail view", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("run edl script");
        await driver.send();

        const filePath = path.join(dirs.tmpDir, "test.txt");
        const script = `file \`${filePath}\`
select_one /hello/
replace <<END
goodbye
END`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll run an EDL script",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("📝✅ edl:");

        // Toggle to detail view
        const previewPos =
          await driver.assertDisplayBufferContains("1 replace");
        await driver.triggerDisplayBufferKey(previewPos, "<CR>");

        // Detail should show full trace output
        await driver.assertDisplayBufferContains("Trace:");
        await driver.assertDisplayBufferContains("Mutations:");
      },
    );
  });
});

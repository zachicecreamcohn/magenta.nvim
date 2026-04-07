import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { describe, expect, test } from "vitest";
import type { Line } from "../nvim/buffer.ts";
import { getAllBuffers } from "../nvim/nvim.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { withDriver } from "../test/preamble.ts";

describe("edl tool", () => {
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
narrow /hello/
replace "goodbye"`;

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
          "✅ edl: 1 mutations in 1 file",
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
narrow /hello/
replace "goodbye"`;

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

        await driver.assertDisplayBufferContains("✅ edl:");

        // Toggle to detail view
        await driver.triggerDisplayBufferKeyOnContent("1 replace", "<CR>");

        // Detail should show full trace output
        await driver.assertDisplayBufferContains("Trace:");
        await driver.assertDisplayBufferContains("Mutations:");
      },
    );
  });

  test("preview shows abridged script for long scripts", async () => {
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
        const longLine = "a".repeat(100);
        const extraLines = Array.from(
          { length: 12 },
          (_, i) => `# comment line ${i} ${longLine}`,
        ).join("\n");
        const script = `file \`${filePath}\`
${extraLines}
narrow /hello/
replace "goodbye"`;

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

        await driver.assertDisplayBufferContains("✅ edl:");

        // Preview should show truncated lines (ending with ...)
        await driver.assertDisplayBufferContains("aaa...");

        // Preview should show the "more lines" indicator
        await driver.assertDisplayBufferContains("more lines)");

        // Preview should NOT show the full long line
        await driver.assertDisplayBufferDoesNotContain(longLine);
      },
    );
  });

  test("detail view shows full unabridged script", async () => {
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
narrow /hello/
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

        await driver.assertDisplayBufferContains("✅ edl:");

        // Preview should show the script
        await driver.assertDisplayBufferContains("narrow /hello/");

        // Toggle input to expanded view (shows full script)
        await driver.triggerDisplayBufferKeyOnContent("narrow /hello/", "<CR>");

        // Expanded input should show full script
        await driver.assertDisplayBufferContains("narrow /hello/");
        await driver.assertDisplayBufferContains("replace <<END");

        // Toggle result to expanded view to see trace output
        await driver.triggerDisplayBufferKeyOnContent("1 replace", "<CR>");
        await driver.assertDisplayBufferContains("Trace:");
        await driver.assertDisplayBufferContains("Mutations:");
      },
    );
  });
});

describe("edl tool buffer integration", () => {
  test("edl writes to nvim buffer when file is open", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.editFile("test.txt");
        await driver.showSidebar();

        const filePath = path.join(dirs.tmpDir, "test.txt");

        await driver.inputMagentaText("edit the file");
        await driver.send();

        const script = `file \`${filePath}\`
narrow /hello/
replace "goodbye"`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "editing",
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

        await driver.assertDisplayBufferContains("✅ edl:");

        // Verify the nvim buffer was updated (not just disk)
        const buffers = await getAllBuffers(driver.nvim);
        let testBuffer;
        for (const buf of buffers) {
          const name = await buf.getName();
          if (name.includes("test.txt")) {
            testBuffer = buf;
            break;
          }
        }
        expect(testBuffer).toBeDefined();
        if (!testBuffer) throw new Error("testBuffer undefined");

        const lines = await testBuffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
        expect(lines.join("\n")).toBe("goodbye world");

        // Verify disk was also saved (nvim adds trailing newline on save)
        const diskContent = await fs.readFile(filePath, "utf-8");
        expect(diskContent).toBe("goodbye world\n");
      },
    );
  });

  test("edl reads from disk even when buffer has unsaved changes", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(
            path.join(tmpDir, "test.txt"),
            "original content\n",
          );
        },
      },
      async (driver, dirs) => {
        await driver.editFile("test.txt");
        await driver.showSidebar();

        const filePath = path.join(dirs.tmpDir, "test.txt");

        // Modify buffer without saving so buffer and disk differ
        const buffers = await getAllBuffers(driver.nvim);
        let testBuffer;
        for (const buf of buffers) {
          const name = await buf.getName();
          if (name.includes("test.txt")) {
            testBuffer = buf;
            break;
          }
        }
        expect(testBuffer).toBeDefined();
        if (!testBuffer) throw new Error("expected testBuffer to be defined");

        await testBuffer.setLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: ["buffer only content" as Line],
        });

        // Disk still has original content
        const diskContent = await fs.readFile(filePath, "utf-8");
        expect(diskContent).toBe("original content\n");

        // Run EDL that searches for content on disk (not in buffer)
        await driver.inputMagentaText("edit the file");
        await driver.send();

        const script = `file \`${filePath}\`
narrow /original/
replace "disk-based"`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "editing",
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

        // EDL should succeed because it reads from disk where "original" exists
        await driver.assertDisplayBufferContains(
          "✅ edl: 1 mutations in 1 file",
        );

        // Verify disk was updated
        const updatedDisk = await fs.readFile(filePath, "utf-8");
        expect(updatedDisk).toBe("disk-based content\n");
      },
    );
  });
});

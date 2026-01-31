import { test, expect, describe } from "vitest";
import { withDriver, assertToolResultContainsText } from "../test/preamble.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolRequestId, ToolName } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { MockProvider } from "../providers/mock.ts";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;

describe("listDirectory", () => {
  test("can list files in cwd", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("list the files in the current directory");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "tool_use",
        text: "I'll list the directory",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tool_1" as ToolRequestId,
              toolName: "list_directory" as ToolName,
              input: { dirPath: "." as UnresolvedFilePath },
            },
          },
        ],
      });

      // Wait for tool to complete
      await driver.assertDisplayBufferContains("📁✅ list_directory");

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
      assertToolResultContainsText(toolResult!, "poem.txt");
    });
  });

  test("cannot list directory outside cwd without permission", async () => {
    await withDriver(
      {
        setupExtraDirs: async (baseDir) => {
          const outsideDir = path.join(baseDir, "outside");
          await fs.mkdir(outsideDir, { recursive: true });
          await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("list files");
        await driver.send();

        const outsidePath = path.join(dirs.baseDir, "outside");

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll list the directory",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "list_directory" as ToolName,
                input: { dirPath: outsidePath as UnresolvedFilePath },
              },
            },
          ],
        });

        // Wait for tool to complete (with error)
        await driver.assertDisplayBufferContains("📁❌ list_directory");

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
      },
    );
  });

  test("can list directory outside cwd with filePermissions from ~/.magenta/options.json", async () => {
    // We need to know the baseDir path to write it into options.json,
    // but setupHome runs before we have access to dirs.
    // Solution: use a well-known path pattern
    let outsidePath: string;

    await withDriver(
      {
        setupExtraDirs: async (baseDir) => {
          outsidePath = path.join(baseDir, "outside");
          await fs.mkdir(outsidePath, { recursive: true });
          await fs.writeFile(
            path.join(outsidePath, "allowed-file.txt"),
            "allowed content",
          );

          // Write the options.json here since we now have the path
          const homeDir = path.join(baseDir, "home");
          const magentaDir = path.join(homeDir, ".magenta");
          await fs.mkdir(magentaDir, { recursive: true });
          await fs.writeFile(
            path.join(magentaDir, "options.json"),
            JSON.stringify({
              filePermissions: [{ path: outsidePath, read: true }],
            }),
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText("list files");
        await driver.send();

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll list the directory",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "list_directory" as ToolName,
                input: { dirPath: outsidePath as UnresolvedFilePath },
              },
            },
          ],
        });

        // Wait for tool to complete
        await driver.assertDisplayBufferContains("📁✅ list_directory");

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
        assertToolResultContainsText(toolResult!, "allowed-file.txt");
      },
    );
  });

  test("can list directory using tilde path with filePermissions", async () => {
    let configPath: string;

    await withDriver(
      {
        setupHome: async (homeDir) => {
          // Create ~/.config with some files
          const configDir = path.join(homeDir, ".config", "myapp");
          configPath = path.join(homeDir, ".config");
          await fs.mkdir(configDir, { recursive: true });
          await fs.writeFile(path.join(configDir, "config.json"), "{}");

          // Create ~/.magenta/options.json with permission for ~/.config
          const magentaDir = path.join(homeDir, ".magenta");
          await fs.mkdir(magentaDir, { recursive: true });
          await fs.writeFile(
            path.join(magentaDir, "options.json"),
            JSON.stringify({
              filePermissions: [{ path: "~/.config", read: true }],
            }),
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText("list config files");
        await driver.send();

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll list the config directory",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "list_directory" as ToolName,
                input: {
                  dirPath: configPath as UnresolvedFilePath,
                },
              },
            },
          ],
        });

        // Wait for tool to complete
        await driver.assertDisplayBufferContains("📁✅ list_directory");

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
        assertToolResultContainsText(toolResult!, "myapp/");
      },
    );
  });
});

describe("listDirectory gitignore", () => {
  test("respects gitignore in the directory", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          // Create a .gitignore in cwd
          await fs.writeFile(
            path.join(tmpDir, ".gitignore"),
            "ignored.txt\nbuild/\n",
          );
          // Create files that should be ignored
          await fs.writeFile(
            path.join(tmpDir, "ignored.txt"),
            "should be ignored",
          );
          await fs.mkdir(path.join(tmpDir, "build"), { recursive: true });
          await fs.writeFile(
            path.join(tmpDir, "build", "output.js"),
            "compiled",
          );
          // Create a file that should be visible
          await fs.writeFile(
            path.join(tmpDir, "visible.txt"),
            "should be visible",
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText("list files");
        await driver.send();

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll list the directory",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "list_directory" as ToolName,
                input: { dirPath: "." as UnresolvedFilePath },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("📁✅ list_directory");

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

        // Should include visible.txt but not ignored.txt or build/
        assertToolResultContainsText(toolResult!, "visible.txt");
        const resultText =
          (toolResult!.content as { type: string; text: string }[]).find(
            (c) => c.type === "text",
          )?.text ?? "";
        expect(resultText).not.toContain("ignored.txt");
        expect(resultText).not.toContain("build/");
      },
    );
  });

  test("respects gitignore in parent directories", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          // Create a .gitignore in cwd that ignores files in subdir
          await fs.writeFile(
            path.join(tmpDir, ".gitignore"),
            "subdir/ignored.txt\n",
          );
          // Create subdirectory with files
          await fs.mkdir(path.join(tmpDir, "subdir"), { recursive: true });
          await fs.writeFile(
            path.join(tmpDir, "subdir", "ignored.txt"),
            "should be ignored",
          );
          await fs.writeFile(
            path.join(tmpDir, "subdir", "visible.txt"),
            "should be visible",
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText("list files");
        await driver.send();

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll list the directory",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "list_directory" as ToolName,
                input: { dirPath: "." as UnresolvedFilePath },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("📁✅ list_directory");

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

        // Should include subdir/visible.txt but not subdir/ignored.txt
        assertToolResultContainsText(toolResult!, "subdir/visible.txt");
        const resultText =
          (toolResult!.content as { type: string; text: string }[]).find(
            (c) => c.type === "text",
          )?.text ?? "";
        expect(resultText).not.toContain("subdir/ignored.txt");
      },
    );
  });

  test("combines gitignores from multiple layers", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          // Create root .gitignore
          await fs.writeFile(
            path.join(tmpDir, ".gitignore"),
            "root-ignored.txt\n",
          );
          // Create subdirectory with its own .gitignore
          await fs.mkdir(path.join(tmpDir, "subdir"), { recursive: true });
          await fs.writeFile(
            path.join(tmpDir, "subdir", ".gitignore"),
            "subdir-ignored.txt\n",
          );
          // Create files
          await fs.writeFile(
            path.join(tmpDir, "root-ignored.txt"),
            "ignored by root",
          );
          await fs.writeFile(
            path.join(tmpDir, "subdir", "subdir-ignored.txt"),
            "ignored by subdir",
          );
          await fs.writeFile(
            path.join(tmpDir, "subdir", "root-ignored.txt"),
            "also ignored by root",
          );
          await fs.writeFile(
            path.join(tmpDir, "subdir", "visible.txt"),
            "should be visible",
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText("list files");
        await driver.send();

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll list the directory",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "list_directory" as ToolName,
                input: { dirPath: "." as UnresolvedFilePath },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("📁✅ list_directory");

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

        // Should include subdir/visible.txt only
        assertToolResultContainsText(toolResult!, "subdir/visible.txt");
        const resultText =
          (toolResult!.content as { type: string; text: string }[]).find(
            (c) => c.type === "text",
          )?.text ?? "";
        expect(resultText).not.toContain("root-ignored.txt");
        expect(resultText).not.toContain("subdir-ignored.txt");
      },
    );
  });

  test("includes gitignored files when includeGitignored is true", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          // Create a .gitignore in cwd
          await fs.writeFile(path.join(tmpDir, ".gitignore"), "ignored.txt\n");
          // Create files
          await fs.writeFile(
            path.join(tmpDir, "ignored.txt"),
            "should be included with flag",
          );
          await fs.writeFile(
            path.join(tmpDir, "visible.txt"),
            "should be visible",
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText("list files");
        await driver.send();

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll list the directory with gitignored files",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "list_directory" as ToolName,
                input: {
                  dirPath: "." as UnresolvedFilePath,
                  includeGitignored: true,
                },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("📁✅ list_directory");

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

        // Should include both files when includeGitignored is true
        assertToolResultContainsText(toolResult!, "visible.txt");
        assertToolResultContainsText(toolResult!, "ignored.txt");
      },
    );
  });
});

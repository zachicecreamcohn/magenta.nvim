import { describe, expect, it } from "vitest";
import * as Replace from "./replace";
import { type VDOMNode } from "../tea/view";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import type { ToolName } from "./types";
import * as path from "path";
import { getcwd } from "../nvim/nvim";
import * as fs from "node:fs";
import type { UnresolvedFilePath } from "../utils/files";
import { MockProvider } from "../providers/mock";

describe("node/tools/replace.test.ts", () => {
  it("validate input", () => {
    const validInput = {
      filePath: "test.txt",
      find: "existing text",
      replace: "new text",
    };

    const result = Replace.validateInput(validInput);
    expect(result.status).toEqual("ok");
    if (result.status === "ok") {
      expect(result.value.filePath).toEqual("test.txt");
      expect(result.value.find).toEqual("existing text");
      expect(result.value.replace).toEqual("new text");
    }

    // Test with missing filePath
    const invalidInput1 = {
      find: "existing text",
      replace: "new text",
    };
    const result1 = Replace.validateInput(invalidInput1);
    expect(result1.status).toEqual("error");

    // Test with wrong type
    const invalidInput2 = {
      filePath: 123,
      find: "existing text",
      replace: "new text",
    };
    const result2 = Replace.validateInput(invalidInput2);
    expect(result2.status).toEqual("error");
  });

  it("renderStreamedBlock - with filePath", () => {
    // Define the content to find and replace
    const findText = `\
function oldFunction() {
  return false;
}`;

    const replaceText = `\
function newFunction() {
  return true;
}`;

    // Create the request object
    const request = {
      filePath: "example.js",
      find: findText,
      replace: replaceText,
    };

    // Convert to JSON and simulate a partial stream
    const streamed = JSON.stringify(request);

    const result = Replace.renderStreamedBlock(streamed);
    const resultStr = vdomToString(result);
    expect(resultStr).toContain("Replace [[ -3 / +3 ]]"); // 3 lines in both find and replace
    expect(resultStr).toContain("example.js");
    expect(resultStr).toContain("streaming");
  });

  it("renderStreamedBlock - without filePath", () => {
    // Create a request without filePath
    const request = {
      find: "old text",
      replace: "new text",
    };

    // Convert to JSON
    const streamed = JSON.stringify(request);

    const result = Replace.renderStreamedBlock(streamed);
    const resultStr = vdomToString(result);
    expect(resultStr).toContain("Preparing replace operation");
  });

  it("renderStreamedBlock - with multiline escaped content", () => {
    const findText = `\
const json = { "key": "value" };
const oldCode = "first line";
let thirdLine;`;

    const replaceText = `\
const json = { "key": "updated" };
const newCode = "first line";
let thirdLine;
let fourthLine;`;

    // Create the request object
    const request = {
      filePath: "test.js",
      find: findText,
      replace: replaceText,
    };

    // Convert to JSON
    const streamed = JSON.stringify(request);

    const result = Replace.renderStreamedBlock(streamed);
    const resultStr = vdomToString(result);
    // Should correctly count the newlines
    expect(resultStr).toContain("Replace [[ -3 / +4 ]]");
    expect(resultStr).toContain("test.js");
  });

  it("reproduce exact error from measure-selection-box.tsx", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const testFile = path.join(cwd, "measure-selection-box.tsx");

      const originalContent = `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";

export type Model = immer.Immutable<
  | {
      measureStats: MeasureStats;
      state: "typing";
      query: string;
      measures: MeasureSpec[];
    }
  | {
      measureStats: MeasureStats;
      state: "selected";
      measureId: MeasureId;
    }
>;`;

      fs.writeFileSync(testFile, originalContent, "utf-8");

      // Open the file in a buffer to trigger the unloaded buffer scenario
      await driver.nvim.call("nvim_command", [`edit ${testFile}`]);

      await driver.showSidebar();
      await driver.inputMagentaText(
        "Update imports in measure-selection-box.tsx",
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll update the imports",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "toolu_01Cj7KxmYJ1STqcHiuHFuWJi" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: testFile as UnresolvedFilePath,
                find: `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";`,
                replace: `import React from "react";
import { Dispatch } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Replace [[ -7 / +6 ]]");

      const fileContent = fs.readFileSync(testFile, "utf-8");
      expect(fileContent).toContain('import { Dispatch } from "../tea";');
      expect(fileContent).not.toContain('import * as immer from "immer";');
      expect(fileContent).not.toContain(
        'import { Update, View } from "../tea";',
      );
    });
  });
  it("reproduce exact error from measure-selection-box.tsx with buffer open", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const testFile = path.join(cwd, "measure-selection-box-buffer.tsx");

      const originalContent = `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";

export type Model = immer.Immutable<
  | {
      measureStats: MeasureStats;
      state: "typing";
      query: string;
      measures: MeasureSpec[];
    }
  | {
      measureStats: MeasureStats;
      state: "selected";
      measureId: MeasureId;
    }
>;`;

      fs.writeFileSync(testFile, originalContent, "utf-8");

      // Open the file in a buffer before running the replace
      await driver.command(`edit ${testFile}`);

      await driver.showSidebar();
      await driver.inputMagentaText(
        "Update imports in measure-selection-box-buffer.tsx",
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll update the imports",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "toolu_01Cj7KxmYJ1STqcHiuHFuWJi" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: testFile as UnresolvedFilePath,
                find: `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";`,
                replace: `import React from "react";
import { Dispatch } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Replace [[ -7 / +6 ]]");

      const fileContent = fs.readFileSync(testFile, "utf-8");
      expect(fileContent).toContain('import { Dispatch } from "../tea";');
      expect(fileContent).not.toContain('import * as immer from "immer";');
      expect(fileContent).not.toContain(
        'import { Update, View } from "../tea";',
      );
    });
  });

  it("replace on unloaded buffer", async () => {
    await withDriver({}, async (driver) => {
      // First, create a dummy buffer to avoid "cannot unload last buffer" error
      await driver.nvim.call("nvim_command", ["new"]);

      const cwd = await getcwd(driver.nvim);
      const testFile = path.join(cwd, "unloaded-buffer-replace.tsx");

      const originalContent = `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";

export const Component = () => {
  return <div>Hello</div>;
};`;

      fs.writeFileSync(testFile, originalContent, "utf-8");

      // Then open the file to create a buffer
      await driver.nvim.call("nvim_command", [`edit ${testFile}`]);

      // next, open the sidebar
      await driver.showSidebar();

      // First, the agent should read the file to know what content to replace
      await driver.inputMagentaText(
        "Read the file unloaded-buffer-replace.tsx and then update the imports",
      );
      await driver.send();

      const getFileRequest = await driver.mockAnthropic.awaitPendingStream();
      getFileRequest.respond({
        stopReason: "tool_use",
        text: "I'll read the file first to see the current imports",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "get_file_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: testFile as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`${testFile}\``);

      // Now unload the buffer to test replace on unloaded buffer
      // Get the buffer number
      const bufNr = (await driver.nvim.call("nvim_eval", [
        `bufnr('unloaded-buffer-replace.tsx')`,
      ])) as import("../nvim/buffer").BufNr;

      // Verify buffer is loaded initially
      const isLoadedInitially = await driver.nvim.call("nvim_buf_is_loaded", [
        bufNr,
      ]);
      expect(isLoadedInitially).toBe(true);

      // Unload the buffer using nvim_exec_lua
      await driver.nvim.call("nvim_exec_lua", [
        `vim.api.nvim_buf_call(${bufNr}, function() vim.cmd('bunload') end)`,
        [],
      ]);

      // Verify buffer is unloaded
      const isLoaded = await driver.nvim.call("nvim_buf_is_loaded", [bufNr]);
      expect(isLoaded).toBe(false);

      // Ensure sidebar is still visible after file operations
      await driver.showSidebar();

      // Now the agent can make the replace request on the unloaded buffer
      const replaceRequest = await driver.mockAnthropic.awaitPendingStream();
      replaceRequest.respond({
        stopReason: "tool_use",
        text: "Now I'll update the imports",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "replace_request" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: testFile as UnresolvedFilePath,
                find: `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";`,
                replace: `import React from "react";
import { Dispatch } from "../tea";`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Replace [[ -3 / +2 ]]");

      // Check that the tool result is properly returned
      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      );

      expect(toolResultMessage).toBeDefined();
      if (!toolResultMessage) {
        throw new Error("Expected tool result message");
      }
      expect(toolResultMessage.role).toBe("user");
      expect(Array.isArray(toolResultMessage.content)).toBe(true);

      const content = toolResultMessage.content;
      if (typeof content === "string") {
        throw new Error("Expected array content");
      }

      const toolResult = content.find((item) => item.type === "tool_result");

      expect(toolResult).toBeDefined();
      if (!toolResult || toolResult.type !== "tool_result") {
        throw new Error("Expected tool result");
      }

      // Verify the tool result indicates success (Anthropic format uses is_error)
      expect(toolResult.is_error).toBeFalsy();

      // Check that the file contents are properly updated
      const fileContent = fs.readFileSync(testFile, "utf-8");
      expect(fileContent).toContain('import { Dispatch } from "../tea";');
      expect(fileContent).not.toContain('import * as immer from "immer";');
      expect(fileContent).not.toContain(
        'import { Update, View } from "../tea";',
      );

      // Verify the full content is updated, not empty
      expect(fileContent.trim()).not.toBe("");
      expect(fileContent).toContain("export const Component = () => {");
      expect(fileContent).toContain("return <div>Hello</div>;");

      // Respond to complete the conversation
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've successfully updated the imports.",
      });
    });
  });
});

it("shows live-updating line counts during streaming", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Create a test file with content to replace
    const cwd = await getcwd(driver.nvim);
    const testFile = path.join(cwd, "streaming-replace.js");
    const originalContent = `\
function oldFunction() {
  const line1 = "old";
  const line2 = "old";
  const line3 = "old";
  return false;
}`;
    fs.writeFileSync(testFile, originalContent);

    await driver.inputMagentaText("Replace the function content");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Create the actual tool input that would be used
    const toolInput = {
      filePath: "streaming-replace.js",
      find: `\
function oldFunction() {
  const line1 = "old";
  const line2 = "old";
  const line3 = "old";
  return false;
}`,
      replace: `\
function newFunction() {
  const line1 = "new";
  const line2 = "new";
  const line3 = "new";
  const line4 = "extra";
  return true;
}`,
    };

    // Stringify it to get the exact JSON that would be streamed
    const fullJson = JSON.stringify(toolInput);

    // Stream the tool use with gradual JSON building to test line count updates
    const toolIndex = 0;
    stream.emitEvent({
      type: "content_block_start",
      index: toolIndex,
      content_block: {
        type: "tool_use",
        id: "streaming-replace-tool",
        name: "replace",
        input: {},
      },
    });

    // Stream in chunks to test live updating - each chunk is a delta, not accumulated content
    const chunk1 = fullJson.substring(0, 30); // Partial filePath
    const chunk2 = fullJson.substring(30, 80); // Complete filePath + start of find
    const chunk3 = fullJson.substring(80, 250); // More of find content, some of the replace

    stream.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk1,
      },
    });

    // At this point we only have partial filePath, should show preparing message
    await driver.assertDisplayBufferContains(
      "⏳ Preparing replace operation...",
    );

    stream.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk2,
      },
    });

    // Now we should have complete filePath and partial find/replace, can show line counts
    await driver.assertDisplayBufferContains("Replace [[ -2 / +1 ]]");

    stream.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk3,
      },
    });

    await driver.assertDisplayBufferContains("Replace [[ -6 / +3 ]]");
  });
});

it("replace requires approval for file outside cwd", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in file /tmp/outside.txt");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: "/tmp/outside.txt" as UnresolvedFilePath,
              find: "old content",
              replace: "new content",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I replace in file `/tmp/outside.txt`?",
    );
  });
});

it("replace requires approval for hidden file", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(path.join(cwd, ".hidden"), "old content", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in file .hidden");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: ".hidden" as UnresolvedFilePath,
              find: "old content",
              replace: "new content",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I replace in file `.hidden`?",
    );
  });
});

it("replace requires approval for skills directory file", async () => {
  await withDriver(
    {
      options: {
        skillsPaths: [".claude/skills"],
      },
      setupFiles: async (tmpDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create skills directory structure
        await fs.mkdir(path.join(tmpDir, ".claude/skills/my-skill"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(tmpDir, ".claude/skills/my-skill/skill.md"),
          "---\nname: my-skill\ndescription: A test skill\n---\n\n# Old content",
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Test that files in skills directory require confirmation for writes
      await driver.inputMagentaText(
        "Replace content in .claude/skills/my-skill/skill.md",
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "request_id" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath:
                  ".claude/skills/my-skill/skill.md" as UnresolvedFilePath,
                find: "# Old content",
                replace: "# New content",
              },
            },
          },
        ],
      });

      // Should require approval even though it's a skills file
      await driver.assertDisplayBufferContains(
        "✏️⏳ May I replace in file `.claude/skills/my-skill/skill.md`?",
      );
    },
  );
});

it("replace auto-approves regular files in cwd", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    const testFile = path.join(cwd, "regular-file.txt");
    fs.writeFileSync(testFile, "old content", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in regular-file.txt");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: "regular-file.txt" as UnresolvedFilePath,
              find: "old content",
              replace: "new content",
            },
          },
        },
      ],
    });

    // Should be automatically approved, not show approval dialog
    await driver.assertDisplayBufferContains(
      "✏️✅ Replace [[ -1 / +1 ]] in `regular-file.txt`",
    );

    const fileContent = fs.readFileSync(testFile, "utf-8");
    expect(fileContent).toBe("new content");
  });
});

it("replace approval dialog allows user to approve", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(path.join(cwd, ".secret"), "old secret", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in .secret");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: ".secret" as UnresolvedFilePath,
              find: "old secret",
              replace: "new secret",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I replace in file `.secret`?",
    );

    // Verify the box formatting is displayed correctly
    await driver.assertDisplayBufferContains(`\
┌────────────────┐
│ [ NO ] [ YES ] │
└────────────────┘`);

    const yesPos = await driver.assertDisplayBufferContains("[ YES ]");
    await driver.triggerDisplayBufferKey(yesPos, "<CR>");

    await driver.assertDisplayBufferContains(
      "✏️✅ Replace [[ -1 / +1 ]] in `.secret`",
    );

    const fileContent = fs.readFileSync(path.join(cwd, ".secret"), "utf-8");
    expect(fileContent).toBe("new secret");
  });
});

it("replace approval dialog allows user to reject", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(path.join(cwd, ".secret"), "old secret", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in .secret");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: ".secret" as UnresolvedFilePath,
              find: "old secret",
              replace: "new secret",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I replace in file `.secret`?",
    );

    const noPos = await driver.assertDisplayBufferContains("[ NO ]");
    await driver.triggerDisplayBufferKey(noPos, "<CR>");

    await driver.assertDisplayBufferContains(
      "✏️❌ Replace [[ -1 / +1 ]] in `.secret`",
    );

    // Verify file was not modified
    const fileContent = fs.readFileSync(path.join(cwd, ".secret"), "utf-8");
    expect(fileContent).toBe("old secret");
  });
});

it("replace approval dialog shows diff preview", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(
      path.join(cwd, ".config-file"),
      `\
line1
old line
line3`,
      "utf-8",
    );

    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in .config-file");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "replace-preview-test" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: ".config-file" as UnresolvedFilePath,
              find: "old line",
              replace: "new line",
            },
          },
        },
      ],
    });

    // Verify the approval dialog is shown
    await driver.assertDisplayBufferContains(
      "✏️⏳ May I replace in file `.config-file`?",
    );

    // Verify diff preview is shown with the change
    await driver.assertDisplayBufferContains("-old line");
    await driver.assertDisplayBufferContains("+new line");
  });
});

it("replace approval dialog can toggle to show full detail", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(
      path.join(cwd, ".detailed-file"),
      `\
first line
second line
third line
fourth line
fifth line`,
      "utf-8",
    );

    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in .detailed-file");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "replace-detail-test" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: ".detailed-file" as UnresolvedFilePath,
              find: `\
second line
third line`,
              replace: `\
SECOND LINE
THIRD LINE
EXTRA LINE`,
            },
          },
        },
      ],
    });

    // Verify the approval dialog is shown
    await driver.assertDisplayBufferContains(
      "✏️⏳ May I replace in file `.detailed-file`?",
    );

    // Verify preview is shown initially
    await driver.assertDisplayBufferContains("-second line");
    await driver.assertDisplayBufferContains("+SECOND LINE");

    // Toggle to show detail view by pressing Enter on the diff preview
    const previewPos = await driver.assertDisplayBufferContains("-second line");
    await driver.triggerDisplayBufferKey(previewPos, "<CR>");

    // After toggling, should show the full detail with filePath header
    await driver.assertDisplayBufferContains("filePath: `.detailed-file`");
    await driver.assertDisplayBufferContains("+EXTRA LINE");
  });
});

it("replace respects filePermissions from ~/.magenta/options.json for external directories", async () => {
  let outsidePath: string;

  await withDriver(
    {
      setupExtraDirs: async (baseDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create a directory outside cwd with a test file
        outsidePath = path.join(baseDir, "external-data");
        await fs.mkdir(outsidePath, { recursive: true });
        await fs.writeFile(
          path.join(outsidePath, "allowed-file.txt"),
          "old content to replace",
        );

        // Write ~/.magenta/options.json with filePermissions granting write access
        const homeDir = path.join(baseDir, "home");
        const magentaDir = path.join(homeDir, ".magenta");
        await fs.mkdir(magentaDir, { recursive: true });
        await fs.writeFile(
          path.join(magentaDir, "options.json"),
          JSON.stringify({
            filePermissions: [{ path: outsidePath, write: true }],
          }),
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Try to replace in a file from the external directory
      await driver.inputMagentaText(
        `Please replace content in ${outsidePath}/allowed-file.txt`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll replace that content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "external_file_request" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath:
                  `${outsidePath}/allowed-file.txt` as UnresolvedFilePath,
                find: "old content to replace",
                replace: "new content after replacement",
              },
            },
          },
        ],
      });

      // Should be automatically approved (no user approval dialog)
      await driver.assertDisplayBufferContains(
        `✏️✅ Replace [[ -1 / +1 ]] in \`${outsidePath}/allowed-file.txt\``,
      );

      // Verify the file was actually modified
      const fsSync = await import("fs");
      const fileContent = fsSync.readFileSync(
        `${outsidePath}/allowed-file.txt`,
        "utf-8",
      );
      expect(fileContent).toBe("new content after replacement");
    },
  );
});

it("replace requires approval for external directory without filePermissions", async () => {
  let outsidePath: string;

  await withDriver(
    {
      setupExtraDirs: async (baseDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create a directory outside cwd with a test file
        outsidePath = path.join(baseDir, "restricted-data");
        await fs.mkdir(outsidePath, { recursive: true });
        await fs.writeFile(
          path.join(outsidePath, "restricted-file.txt"),
          "original content",
        );

        // Create empty ~/.magenta/options.json (no filePermissions for this dir)
        const homeDir = path.join(baseDir, "home");
        const magentaDir = path.join(homeDir, ".magenta");
        await fs.mkdir(magentaDir, { recursive: true });
        await fs.writeFile(
          path.join(magentaDir, "options.json"),
          JSON.stringify({}),
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Try to replace in a file from the external directory
      await driver.inputMagentaText(
        `Please replace content in ${outsidePath}/restricted-file.txt`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll replace that content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "restricted_file_request" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath:
                  `${outsidePath}/restricted-file.txt` as UnresolvedFilePath,
                find: "original content",
                replace: "modified content",
              },
            },
          },
        ],
      });

      // Should require user approval since no filePermissions cover this path
      await driver.assertDisplayBufferContains(
        `✏️⏳ May I replace in file \`${outsidePath}/restricted-file.txt\`?`,
      );
    },
  );
});

it("replace respects tilde expansion in filePermissions paths", async () => {
  await withDriver(
    {
      setupHome: async (homeDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create a directory in home with a test file
        const docsDir = path.join(homeDir, "Documents");
        await fs.mkdir(docsDir, { recursive: true });
        await fs.writeFile(
          path.join(docsDir, "notes.txt"),
          "Old notes content",
        );

        // Write ~/.magenta/options.json with tilde-based path
        const magentaDir = path.join(homeDir, ".magenta");
        await fs.mkdir(magentaDir, { recursive: true });
        await fs.writeFile(
          path.join(magentaDir, "options.json"),
          JSON.stringify({
            filePermissions: [{ path: "~/Documents", write: true }],
          }),
        );
      },
    },
    async (driver, dirs) => {
      await driver.showSidebar();

      // Try to replace in a file using tilde path
      await driver.inputMagentaText(`Please replace in ~/Documents/notes.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll replace that content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tilde_file_request" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: "~/Documents/notes.txt" as UnresolvedFilePath,
                find: "Old notes content",
                replace: "New notes content",
              },
            },
          },
        ],
      });

      // Should be automatically approved via tilde-expanded filePermissions
      await driver.assertDisplayBufferContains(
        `✏️✅ Replace [[ -1 / +1 ]] in \`~/Documents/notes.txt\``,
      );

      // Verify the file was actually modified
      const fsSync = await import("fs");
      const fileContent = fsSync.readFileSync(
        path.join(dirs.homeDir, "Documents", "notes.txt"),
        "utf-8",
      );
      expect(fileContent).toBe("New notes content");
    },
  );
});

it("replace can modify files using tilde path with user approval", async () => {
  await withDriver(
    {
      setupHome: async (homeDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create a file in the home directory
        await fs.writeFile(
          path.join(homeDir, "home-file.txt"),
          "Original home content",
        );
      },
    },
    async (driver, dirs) => {
      await driver.showSidebar();

      // Try to replace in a file using tilde path (no filePermissions, so requires approval)
      await driver.inputMagentaText(`Please replace in ~/home-file.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll replace that content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tilde_approval_request" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: "~/home-file.txt" as UnresolvedFilePath,
                find: "Original home content",
                replace: "Modified home content",
              },
            },
          },
        ],
      });

      // Should require user approval since no filePermissions cover this path
      await driver.assertDisplayBufferContains(
        `✏️⏳ May I replace in file \`~/home-file.txt\`?`,
      );

      // Approve the request
      const yesPos = await driver.assertDisplayBufferContains("[ YES ]");
      await driver.triggerDisplayBufferKey(yesPos, "<CR>");

      // Should now show success
      await driver.assertDisplayBufferContains(
        `✏️✅ Replace [[ -1 / +1 ]] in \`~/home-file.txt\``,
      );

      // Verify the file was actually modified
      const fsSync = await import("fs");
      const fileContent = fsSync.readFileSync(
        path.join(dirs.homeDir, "home-file.txt"),
        "utf-8",
      );
      expect(fileContent).toBe("Modified home content");
    },
  );
});

function vdomToString(node: VDOMNode): string {
  if (typeof node === "string") {
    return node;
  }

  if (node.type === "string") {
    return node.content;
  }

  if (node.type === "node" && Array.isArray(node.children)) {
    return node.children.map((child) => vdomToString(child)).join("");
  }

  return "";
}

import { describe, expect, it } from "vitest";
import * as Insert from "./insert";
import { type VDOMNode } from "../tea/view";
import { withDriver } from "../test/preamble";
import fs from "node:fs";
import { getcwd } from "../nvim/nvim";
import path from "node:path";
import type { ToolRequestId } from "./toolManager";
import type { ToolName } from "./types";
import type { UnresolvedFilePath } from "../utils/files";

describe("node/tools/insert.test.ts", () => {
  it("validate input", () => {
    const validInput = {
      filePath: "test.txt",
      insertAfter: "existing text",
      content: "new content",
    };

    const result = Insert.validateInput(validInput);
    expect(result.status).toEqual("ok");
    if (result.status === "ok") {
      expect(result.value.filePath).toEqual("test.txt");
      expect(result.value.insertAfter).toEqual("existing text");
      expect(result.value.content).toEqual("new content");
    }

    // Test with missing filePath
    const invalidInput1 = {
      insertAfter: "existing text",
      content: "new content",
    };
    const result1 = Insert.validateInput(invalidInput1);
    expect(result1.status).toEqual("error");

    // Test with wrong type
    const invalidInput2 = {
      filePath: 123,
      insertAfter: "existing text",
      content: "new content",
    };
    const result2 = Insert.validateInput(invalidInput2);
    expect(result2.status).toEqual("error");
  });

  it("renderStreamedBlock - with filePath", () => {
    // Define the content as a normal multiline string
    const code = `\
const newCode = true;
function test() {
  return true;
}`;

    // Create the request object
    const request = {
      filePath: "example.js",
      insertAfter: "// comment",
      content: code,
    };

    // Convert to JSON and simulate a partial stream
    const streamed = JSON.stringify(request);

    const result = Insert.renderStreamedBlock(
      streamed.slice(0, streamed.length - 4),
    );
    const resultStr = vdomToString(result);
    expect(resultStr).toContain("Insert [[ +3 ]]"); // 3 lines in the content
    expect(resultStr).toContain("example.js");
    expect(resultStr).toContain("streaming...");
  });

  it("renderStreamedBlock - without filePath", () => {
    // Create a request without filePath
    const request = {
      insertAfter: "// comment",
      content: "const newCode = true;",
    };

    // Convert to JSON
    const streamed = JSON.stringify(request);

    const result = Insert.renderStreamedBlock(streamed);
    const resultStr = vdomToString(result);
    expect(resultStr).toContain("⏳ Insert...");
  });

  it("renderStreamedBlock - with escaped content", () => {
    const code = `\
const json = { "key": "value" };
const newLine = "first line"";
let secondLine;`;

    // Create the request object
    const request = {
      filePath: "test.js",
      insertAfter: "// comment",
      content: code,
    };

    // Convert to JSON
    const streamed = JSON.stringify(request);

    const result = Insert.renderStreamedBlock(streamed);
    const resultStr = vdomToString(result);
    // Should correctly count the 2 actual newlines, not the escaped \n in the string
    expect(resultStr).toContain("Insert [[ +3 ]]");
    expect(resultStr).toContain("test.js");
  });
});

it("shows live-updating line counts during streaming", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Create a test file to insert content into
    const cwd = await getcwd(driver.nvim);
    const testFile = path.join(cwd, "streaming-insert.js");
    const originalContent = `\
function existingFunction() {
  // Insert new code after this line
  return true;
}`;
    fs.writeFileSync(testFile, originalContent);

    await driver.inputMagentaText("Add new code to the function");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();

    // Create the actual tool input that would be used
    const toolInput = {
      filePath: "streaming-insert.js",
      insertAfter: `\
  // Insert new code after this line`,
      content: `\
  const newVar1 = 'hello';
  const newVar2 = 'world';
  const newVar3 = 'test';
  console.log(newVar1, newVar2, newVar3);
  console.log('Done!');`,
    };

    // Stringify it to get the exact JSON that would be streamed
    const fullJson = JSON.stringify(toolInput);

    // Stream the tool use with gradual JSON building
    const toolIndex = 0;
    request.emitEvent({
      type: "content_block_start",
      index: toolIndex,
      content_block: {
        type: "tool_use",
        id: "streaming-insert-tool",
        name: "insert",
        input: {},
      },
    });

    // Stream in chunks to test live updating - each chunk is a delta, not accumulated content
    const chunk1 = fullJson.substring(0, 30); // Partial filePath
    const chunk2 = fullJson.substring(30, 120); // Complete filePath + insertAfter
    const chunk3 = fullJson.substring(120); // Rest of content

    request.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk1,
      },
    });

    // At this point we only have partial filePath, should show preparing message
    await driver.assertDisplayBufferContains("⏳ Insert...");

    request.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk2,
      },
    });

    // Now we should have complete filePath and insertAfter, can show line counts
    await driver.assertDisplayBufferContains("Insert [[ +1 ]]");

    request.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk3,
      },
    });

    await driver.assertDisplayBufferContains("Insert [[ +5 ]]");
  });
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

it("insert requires approval for file outside cwd", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in file /tmp/outside.txt");
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
            toolName: "insert" as ToolName,
            input: {
              filePath: "/tmp/outside.txt" as UnresolvedFilePath,
              insertAfter: "",
              content: "new content",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I insert in file `/tmp/outside.txt`?",
    );
  });
});

it("insert requires approval for hidden file", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(
      path.join(cwd, ".hidden-insert"),
      "existing content",
      "utf-8",
    );

    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in file .hidden-insert");
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
            toolName: "insert" as ToolName,
            input: {
              filePath: ".hidden-insert" as UnresolvedFilePath,
              insertAfter: "existing content",
              content: "\nnew content",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I insert in file `.hidden-insert`?",
    );
  });
});

it("insert requires approval for skills directory file", async () => {
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
          "---\nname: my-skill\ndescription: A test skill\n---\n\n# Content",
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Test that files in skills directory require confirmation for writes
      await driver.inputMagentaText(
        "Insert content in .claude/skills/my-skill/skill.md",
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
              toolName: "insert" as ToolName,
              input: {
                filePath:
                  ".claude/skills/my-skill/skill.md" as UnresolvedFilePath,
                insertAfter: "# Content",
                content: "\nNew content",
              },
            },
          },
        ],
      });

      // Should require approval even though it's a skills file
      await driver.assertDisplayBufferContains(
        "✏️⏳ May I insert in file `.claude/skills/my-skill/skill.md`?",
      );
    },
  );
});

it("insert auto-approves regular files in cwd", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    const testFile = path.join(cwd, "regular-insert-file.txt");
    fs.writeFileSync(testFile, "existing content", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in regular-insert-file.txt");
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
            toolName: "insert" as ToolName,
            input: {
              filePath: "regular-insert-file.txt" as UnresolvedFilePath,
              insertAfter: "existing content",
              content: "\nnew content",
            },
          },
        },
      ],
    });

    // Should be automatically approved, not show approval dialog
    await driver.assertDisplayBufferContains(
      "✏️✅ Insert [[ +2 ]] in `regular-insert-file.txt`",
    );

    const fileContent = fs.readFileSync(testFile, "utf-8");
    expect(fileContent).toBe("existing content\nnew content");
  });
});

it("insert approval dialog allows user to approve", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(path.join(cwd, ".secret-insert"), "old secret", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in .secret-insert");
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
            toolName: "insert" as ToolName,
            input: {
              filePath: ".secret-insert" as UnresolvedFilePath,
              insertAfter: "old secret",
              content: "\nnew secret",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I insert in file `.secret-insert`?",
    );

    // Verify the box formatting is displayed correctly
    await driver.assertDisplayBufferContains(`\
┌────────────────┐
│ [ NO ] [ YES ] │
└────────────────┘`);

    const yesPos = await driver.assertDisplayBufferContains("[ YES ]");
    await driver.triggerDisplayBufferKey(yesPos, "<CR>");

    await driver.assertDisplayBufferContains(
      "✏️✅ Insert [[ +2 ]] in `.secret-insert`",
    );

    const fileContent = fs.readFileSync(
      path.join(cwd, ".secret-insert"),
      "utf-8",
    );
    expect(fileContent).toBe("old secret\nnew secret");
  });
});

it("insert approval dialog allows user to reject", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(path.join(cwd, ".secret-insert2"), "old secret", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in .secret-insert2");
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
            toolName: "insert" as ToolName,
            input: {
              filePath: ".secret-insert2" as UnresolvedFilePath,
              insertAfter: "old secret",
              content: "\nnew secret",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I insert in file `.secret-insert2`?",
    );

    const noPos = await driver.assertDisplayBufferContains("[ NO ]");
    await driver.triggerDisplayBufferKey(noPos, "<CR>");

    await driver.assertDisplayBufferContains(
      "✏️❌ Insert [[ +2 ]] in `.secret-insert2`",
    );

    // Verify file was not modified
    const fileContent = fs.readFileSync(
      path.join(cwd, ".secret-insert2"),
      "utf-8",
    );
    expect(fileContent).toBe("old secret");
  });
});

it("insert approval dialog shows content preview", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(
      path.join(cwd, ".config-insert"),
      "existing content",
      "utf-8",
    );

    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in .config-insert");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "insert-preview-test" as ToolRequestId,
            toolName: "insert" as ToolName,
            input: {
              filePath: ".config-insert" as UnresolvedFilePath,
              insertAfter: "existing content",
              content: "\nnew line 1\nnew line 2",
            },
          },
        },
      ],
    });

    // Verify the approval dialog is shown
    await driver.assertDisplayBufferContains(
      "✏️⏳ May I insert in file `.config-insert`?",
    );

    // Verify preview is shown with the content to be inserted
    await driver.assertDisplayBufferContains("new line 1");
    await driver.assertDisplayBufferContains("new line 2");
  });
});

it("insert approval dialog can toggle to show full detail", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(
      path.join(cwd, ".detailed-insert"),
      "marker text here",
      "utf-8",
    );

    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in .detailed-insert");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "insert-detail-test" as ToolRequestId,
            toolName: "insert" as ToolName,
            input: {
              filePath: ".detailed-insert" as UnresolvedFilePath,
              insertAfter: "marker text here",
              content: `\
\nfirst inserted line
second inserted line
third inserted line`,
            },
          },
        },
      ],
    });

    // Verify the approval dialog is shown
    await driver.assertDisplayBufferContains(
      "✏️⏳ May I insert in file `.detailed-insert`?",
    );

    // Verify preview is shown initially
    await driver.assertDisplayBufferContains("first inserted line");

    // Toggle to show detail view by pressing Enter on the preview
    const previewPos = await driver.assertDisplayBufferContains(
      "first inserted line",
    );
    await driver.triggerDisplayBufferKey(previewPos, "<CR>");

    // After toggling, should show the full detail with filePath and insertAfter
    await driver.assertDisplayBufferContains("filePath: `.detailed-insert`");
    await driver.assertDisplayBufferContains("insertAfter: `marker text here`");
    await driver.assertDisplayBufferContains("third inserted line");
  });
});

it("insert respects filePermissions from ~/.magenta/options.json for external directories", async () => {
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
          "existing content",
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

      // Try to insert in a file from the external directory
      await driver.inputMagentaText(
        `Please insert content in ${outsidePath}/allowed-file.txt`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll insert that content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "external_file_request" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath:
                  `${outsidePath}/allowed-file.txt` as UnresolvedFilePath,
                insertAfter: "existing content",
                content: "\nnew content after insertion",
              },
            },
          },
        ],
      });

      // Should be automatically approved (no user approval dialog)
      await driver.assertDisplayBufferContains(
        `✏️✅ Insert [[ +2 ]] in \`${outsidePath}/allowed-file.txt\``,
      );

      // Verify the file was actually modified
      const fileContent = fs.readFileSync(
        `${outsidePath}/allowed-file.txt`,
        "utf-8",
      );
      expect(fileContent).toBe("existing content\nnew content after insertion");
    },
  );
});

it("insert requires approval for external directory without filePermissions", async () => {
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

      // Try to insert in a file from the external directory
      await driver.inputMagentaText(
        `Please insert content in ${outsidePath}/restricted-file.txt`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll insert that content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "restricted_file_request" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath:
                  `${outsidePath}/restricted-file.txt` as UnresolvedFilePath,
                insertAfter: "original content",
                content: "\ninserted content",
              },
            },
          },
        ],
      });

      // Should require user approval since no filePermissions cover this path
      await driver.assertDisplayBufferContains(
        `✏️⏳ May I insert in file \`${outsidePath}/restricted-file.txt\`?`,
      );
    },
  );
});

it("insert respects tilde expansion in filePermissions paths", async () => {
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

      // Try to insert in a file using tilde path
      await driver.inputMagentaText(`Please insert in ~/Documents/notes.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll insert that content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tilde_file_request" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: "~/Documents/notes.txt" as UnresolvedFilePath,
                insertAfter: "Old notes content",
                content: "\nNew notes appended",
              },
            },
          },
        ],
      });

      // Should be automatically approved via tilde-expanded filePermissions
      await driver.assertDisplayBufferContains(
        `✏️✅ Insert [[ +2 ]] in \`~/Documents/notes.txt\``,
      );

      // Verify the file was actually modified
      const fileContent = fs.readFileSync(
        path.join(dirs.homeDir, "Documents", "notes.txt"),
        "utf-8",
      );
      expect(fileContent).toBe("Old notes content\nNew notes appended");
    },
  );
});

it("insert can modify files using tilde path with user approval", async () => {
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

      // Try to insert in a file using tilde path (no filePermissions, so requires approval)
      await driver.inputMagentaText(`Please insert in ~/home-file.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll insert that content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tilde_approval_request" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: "~/home-file.txt" as UnresolvedFilePath,
                insertAfter: "Original home content",
                content: "\nInserted home content",
              },
            },
          },
        ],
      });

      // Should require user approval since no filePermissions cover this path
      await driver.assertDisplayBufferContains(
        `✏️⏳ May I insert in file \`~/home-file.txt\`?`,
      );

      // Approve the request
      const yesPos = await driver.assertDisplayBufferContains("[ YES ]");
      await driver.triggerDisplayBufferKey(yesPos, "<CR>");

      // Should now show success
      await driver.assertDisplayBufferContains(
        `✏️✅ Insert [[ +2 ]] in \`~/home-file.txt\``,
      );

      // Verify the file was actually modified
      const fileContent = fs.readFileSync(
        path.join(dirs.homeDir, "home-file.txt"),
        "utf-8",
      );
      expect(fileContent).toBe("Original home content\nInserted home content");
    },
  );
});

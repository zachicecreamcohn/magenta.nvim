import { describe, expect, it } from "vitest";
import * as Insert from "./insert";
import { type VDOMNode } from "../tea/view";
import { withDriver } from "../test/preamble";
import fs from "node:fs";
import { getcwd } from "../nvim/nvim";
import path from "node:path";

describe("node/tools/insert.spec.ts", () => {
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

    const request = await driver.mockAnthropic.awaitPendingRequest();

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
    request.onStreamEvent({
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

    request.onStreamEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk1,
      },
    });

    // At this point we only have partial filePath, should show preparing message
    await driver.assertDisplayBufferContains("⏳ Insert...");

    request.onStreamEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk2,
      },
    });

    // Now we should have complete filePath and insertAfter, can show line counts
    await driver.assertDisplayBufferContains("Insert [[ +1 ]]");

    request.onStreamEvent({
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

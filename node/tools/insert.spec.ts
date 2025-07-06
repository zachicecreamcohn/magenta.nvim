import { describe, expect, it } from "vitest";
import * as Insert from "./insert";
import { type VDOMNode } from "../tea/view";

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

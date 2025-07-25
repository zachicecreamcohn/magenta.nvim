import { test, expect } from "vitest";
import { calculateDiff } from "./diff.ts";

// Helper function to apply diff operations and verify correctness
function applyDiffOperations(
  original: string,
  operations: ReturnType<typeof calculateDiff>,
): string {
  let result = original;
  const reversedOps = [...operations].reverse();

  for (const op of reversedOps) {
    if (op.type === "delete") {
      result = result.slice(0, op.startPos) + result.slice(op.endPos);
    } else if (op.type === "insert") {
      result =
        result.slice(0, op.insertAfterPos) +
        op.text +
        result.slice(op.insertAfterPos);
    }
  }

  return result;
}

// Helper to annotate diff operations with readable context
function annotateDiffOps(
  original: string,
  operations: ReturnType<typeof calculateDiff>,
) {
  return operations.map((op) => {
    if (op.type === "delete") {
      const deletedText = original.slice(op.startPos, op.endPos);
      return {
        ...op,
        deletedText,
      };
    } else {
      const insertAfterText = original.slice(
        Math.max(0, op.insertAfterPos - 5),
        op.insertAfterPos,
      );
      return {
        ...op,
        insertAfterText,
      };
    }
  });
}

test("calculateDiff handles function name change", () => {
  const original = `\
function calculateSum(a, b) {
  return a + b;
}`;
  const modified = `\
function computeTotal(a, b) {
  return a + b;
}`;

  const diffOps = calculateDiff(original, modified);
  const annotated = annotateDiffOps(original, diffOps);

  // Should replace only the first line containing the function signature
  expect(annotated).toEqual([
    {
      type: "delete",
      startPos: 9,
      endPos: 21,
      deletedText: "calculateSum",
    },
    {
      type: "insert",
      text: "computeTotal",
      insertAfterPos: 21,
      insertAfterText: "teSum",
    },
  ]);

  const result = applyDiffOperations(original, diffOps);
  expect(result).toBe(modified);
});

test("calculateDiff handles parameter addition", () => {
  const original = `\
function greet(name) {
  console.log(\`Hello \${name}\`);
}`;
  const modified = `\
function greet(name, greeting) {
  console.log(\`\${greeting} \${name}\`);
}`;

  const diffOps = calculateDiff(original, modified);
  const annotated = annotateDiffOps(original, diffOps);

  // Should replace both lines that changed (function signature and console.log)
  expect(annotated).toEqual([
    {
      type: "insert",
      text: ", greeting",
      insertAfterPos: 19,
      insertAfterText: "(name",
    },
    {
      type: "delete",
      startPos: 38,
      endPos: 43,
      deletedText: "Hello",
    },
    {
      type: "insert",
      text: "${greeting}",
      insertAfterPos: 43,
      insertAfterText: "Hello",
    },
  ]);

  const result = applyDiffOperations(original, diffOps);
  expect(result).toBe(modified);
});

test("calculateDiff handles variable renaming", () => {
  const original = `\
const userName = 'john';
console.log(userName);`;
  const modified = `\
const currentUser = 'john';
console.log(currentUser);`;

  const diffOps = calculateDiff(original, modified);
  const annotated = annotateDiffOps(original, diffOps);

  // Should replace the entire text since line-based diff sees this as one complete change
  expect(annotated).toEqual([
    {
      type: "delete",
      startPos: 6,
      endPos: 14,
      deletedText: "userName",
    },
    {
      type: "insert",
      text: "currentUser",
      insertAfterPos: 14,
      insertAfterText: "rName",
    },
    {
      type: "delete",
      startPos: 37,
      endPos: 45,
      deletedText: "userName",
    },
    {
      type: "insert",
      text: "currentUser",
      insertAfterPos: 45,
      insertAfterText: "rName",
    },
  ]);

  const result = applyDiffOperations(original, diffOps);
  expect(result).toBe(modified);
});

test("calculateDiff handles adding a new line", () => {
  const original = `\
if (condition) {
  doSomething();
}`;
  const modified = `\
if (condition) {
  doSomething();
  doSomethingElse();
}`;

  const diffOps = calculateDiff(original, modified);
  const annotated = annotateDiffOps(original, diffOps);

  // Should insert the new line with proper indentation
  expect(annotated).toEqual([
    {
      type: "insert",
      text: "  doSomethingElse();\n",
      insertAfterPos: 34,
      insertAfterText: "g();\n",
    },
  ]);

  const result = applyDiffOperations(original, diffOps);
  expect(result).toBe(modified);
});

test("calculateDiff handles indentation changes", () => {
  const original = `\
if (true) {
const x = 1;
}`;
  const modified = `\
if (true) {
  const x = 1;
}`;

  const diffOps = calculateDiff(original, modified);
  const annotated = annotateDiffOps(original, diffOps);

  // Should replace the line that needs indentation
  expect(annotated).toEqual([
    {
      type: "insert",
      text: "  ",
      insertAfterPos: 12,
      insertAfterText: "e) {\n",
    },
  ]);

  const result = applyDiffOperations(original, diffOps);
  expect(result).toBe(modified);
});

test("calculateDiff handles comment addition", () => {
  const original = `\
function add(a, b) {
  return a + b;
}`;
  const modified = `\
// Adds two numbers
function add(a, b) {
  return a + b;
}`;

  const diffOps = calculateDiff(original, modified);
  const annotated = annotateDiffOps(original, diffOps);

  // Should insert the comment at the beginning
  expect(annotated).toEqual([
    {
      type: "insert",
      text: "// Adds two numbers\n",
      insertAfterPos: 0,
      insertAfterText: "",
    },
  ]);

  const result = applyDiffOperations(original, diffOps);
  expect(result).toBe(modified);
});

test("calculateDiff handles method call change", () => {
  const original = "const result = data.filter(item => item.active);";
  const modified = "const result = data.map(item => item.value);";

  const diffOps = calculateDiff(original, modified);
  const annotated = annotateDiffOps(original, diffOps);

  // Should replace the entire line since it's a single line change
  expect(annotated).toEqual([
    {
      type: "delete",
      startPos: 20,
      endPos: 26,
      deletedText: "filter",
    },
    {
      type: "insert",
      text: "map",
      insertAfterPos: 26,
      insertAfterText: "ilter",
    },
    {
      type: "delete",
      startPos: 40,
      endPos: 46,
      deletedText: "active",
    },
    {
      type: "insert",
      text: "value",
      insertAfterPos: 46,
      insertAfterText: "ctive",
    },
  ]);

  const result = applyDiffOperations(original, diffOps);
  expect(result).toBe(modified);
});

test("calculateDiff handles multi-line function body change", () => {
  const original = `\
function processData(items) {
  const filtered = items.filter(item => item.valid);
  return filtered.map(item => item.data);
}`;
  const modified = `\
function processData(items) {
  const validated = items.filter(item => item.valid && item.active);
  const transformed = validated.map(item => ({ ...item.data, processed: true }));
  return transformed;
}`;

  const diffOps = calculateDiff(original, modified);
  const annotated = annotateDiffOps(original, diffOps);

  // Should replace the function body lines that changed
  expect(annotated).toEqual([
    {
      type: "delete",
      startPos: 38,
      endPos: 46,
      deletedText: "filtered",
    },
    {
      type: "insert",
      text: "validated",
      insertAfterPos: 46,
      insertAfterText: "tered",
    },
    {
      type: "insert",
      text: " && item.active",
      insertAfterPos: 80,
      insertAfterText: "valid",
    },
    {
      type: "delete",
      startPos: 85,
      endPos: 91,
      deletedText: "return",
    },
    {
      type: "insert",
      text: "const",
      insertAfterPos: 91,
      insertAfterText: "eturn",
    },
    {
      type: "delete",
      startPos: 92,
      endPos: 100,
      deletedText: "filtered",
    },
    {
      type: "insert",
      text: "transformed = validated",
      insertAfterPos: 100,
      insertAfterText: "tered",
    },
    {
      type: "insert",
      text: "({ ...",
      insertAfterPos: 113,
      insertAfterText: "m => ",
    },
    {
      type: "insert",
      text: ", processed: true }",
      insertAfterPos: 122,
      insertAfterText: ".data",
    },
    {
      type: "insert",
      text: ")",
      insertAfterPos: 123,
      insertAfterText: "data)",
    },
    {
      type: "insert",
      text: "  return transformed;\n",
      insertAfterPos: 125,
      insertAfterText: "ta);\n",
    },
  ]);

  const result = applyDiffOperations(original, diffOps);
  expect(result).toBe(modified);
});

test("calculateDiff handles import statement change", () => {
  const original = "import { useState, useEffect } from 'react';";
  const modified = "import { useState, useEffect, useCallback } from 'react';";

  const diffOps = calculateDiff(original, modified);
  const annotated = annotateDiffOps(original, diffOps);

  // Should replace the entire import line
  expect(annotated).toEqual([
    {
      type: "insert",
      text: ",",
      insertAfterPos: 28,
      insertAfterText: "ffect",
    },
    {
      type: "insert",
      text: "useCallback ",
      insertAfterPos: 29,
      insertAfterText: "fect ",
    },
  ]);

  const result = applyDiffOperations(original, diffOps);
  expect(result).toBe(modified);
});

test("calculateDiff handles object property addition", () => {
  const original = `\
const config = {
  host: 'localhost',
  port: 3000
};`;
  const modified = `\
const config = {
  host: 'localhost',
  port: 3000,
  secure: true
};`;

  const diffOps = calculateDiff(original, modified);
  const annotated = annotateDiffOps(original, diffOps);

  // Should replace the lines that changed (port line and closing brace)
  expect(annotated).toEqual([
    {
      type: "insert",
      text: ",",
      insertAfterPos: 50,
      insertAfterText: " 3000",
    },
    {
      type: "insert",
      text: "  secure: true\n",
      insertAfterPos: 51,
      insertAfterText: "3000\n",
    },
  ]);

  const result = applyDiffOperations(original, diffOps);
  expect(result).toBe(modified);
});

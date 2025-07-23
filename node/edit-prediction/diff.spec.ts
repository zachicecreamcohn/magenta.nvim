import { test, expect } from "vitest";
import { calculateDiff } from "./diff.ts";

test("calculateDiff handles simple text replacement", () => {
  const original = "The quick brown fox";
  const modified = "The slow brown fox";
  
  const diff = calculateDiff(original, modified);
  
  expect(diff).toEqual([
    { type: "delete", startPos: 4, endPos: 9 }, // "quick"
    { type: "insert", text: "slow", insertAfterPos: 9 },
  ]);
});

test("calculateDiff handles insertion at beginning", () => {
  const original = "world";
  const modified = "Hello world";
  
  const diff = calculateDiff(original, modified);
  
  expect(diff).toEqual([
    { type: "insert", text: "Hello ", insertAfterPos: 0 },
  ]);
});

test("calculateDiff handles insertion at end", () => {
  const original = "Hello";
  const modified = "Hello world";
  
  const diff = calculateDiff(original, modified);
  
  expect(diff).toEqual([
    { type: "insert", text: " world", insertAfterPos: 5 },
  ]);
});

test("calculateDiff handles deletion at beginning", () => {
  const original = "Hello world";
  const modified = "world";
  
  const diff = calculateDiff(original, modified);
  
  expect(diff).toEqual([
    { type: "delete", startPos: 0, endPos: 6 }, // "Hello "
  ]);
});

test("calculateDiff handles deletion at end", () => {
  const original = "Hello world";
  const modified = "Hello";
  
  const diff = calculateDiff(original, modified);
  
  expect(diff).toEqual([
    { type: "delete", startPos: 5, endPos: 11 }, // " world"
  ]);
});

test("calculateDiff handles multiple operations", () => {
  const original = "The quick brown fox jumps";
  const modified = "A slow red fox leaps high";
  
  const diff = calculateDiff(original, modified);
  
  // This will create multiple operations for the character-level differences
  expect(diff.length).toBeGreaterThan(0);
  
  // Verify the operations would transform original to modified
  let result = original;
  const reversedOps = [...diff].reverse();
  
  for (const op of reversedOps) {
    if (op.type === "delete") {
      result = result.slice(0, op.startPos) + result.slice(op.endPos);
    } else if (op.type === "insert") {
      result = result.slice(0, op.insertAfterPos) + op.text + result.slice(op.insertAfterPos);
    }
  }
  
  expect(result).toBe(modified);
});

test("calculateDiff handles identical text", () => {
  const original = "Hello world";
  const modified = "Hello world";
  
  const diff = calculateDiff(original, modified);
  
  expect(diff).toEqual([]);
});

test("calculateDiff handles empty strings", () => {
  const original = "";
  const modified = "Hello";
  
  const diff = calculateDiff(original, modified);
  
  expect(diff).toEqual([
    { type: "insert", text: "Hello", insertAfterPos: 0 },
  ]);
});

test("calculateDiff handles deletion to empty", () => {
  const original = "Hello";
  const modified = "";
  
  const diff = calculateDiff(original, modified);
  
  expect(diff).toEqual([
    { type: "delete", startPos: 0, endPos: 5 },
  ]);
});

test("calculateDiff handles multiline text", () => {
  const original = "Line 1\nLine 2\nLine 3";
  const modified = "Line 1\nModified Line 2\nLine 3";
  
  const diff = calculateDiff(original, modified);
  
  expect(diff).toEqual([
    { type: "insert", text: "Modified ", insertAfterPos: 7 }, // After "Line 1\n"
  ]);
});

test("calculateDiff character positions are correct", () => {
  const original = "abcdef";
  const modified = "aXYZef";
  
  const diff = calculateDiff(original, modified);
  
  expect(diff).toEqual([
    { type: "delete", startPos: 1, endPos: 4 }, // "bcd"
    { type: "insert", text: "XYZ", insertAfterPos: 4 },
  ]);
  
  // Verify positions: 'a' is at 0, 'bcd' is at 1-3, deletion ends at 4
  expect(original.slice(1, 4)).toBe("bcd");
});

test("calculateDiff with whitespace changes", () => {
  const original = "hello world";
  const modified = "hello  world"; // Extra space
  
  const diff = calculateDiff(original, modified);
  
  expect(diff).toEqual([
    { type: "insert", text: " ", insertAfterPos: 6 }, // Insert space after "hello "
  ]);
});
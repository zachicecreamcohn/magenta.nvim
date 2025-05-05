import { describe, it, expect } from "vitest";
import { stripThinking } from "./strip-thinking";

describe("stripThinking", () => {
  it("should remove basic thinking sections", () => {
    const input = "Hello <think>This should be removed</think> world!";
    const expected = "Hello  world!";
    expect(stripThinking(input)).toBe(expected);
  });

  it("should handle multiple thinking sections", () => {
    const input = "<think>First</think> middle <think>Last</think>";
    const expected = " middle ";
    expect(stripThinking(input)).toBe(expected);
  });

  it("should handle nested thinking sections", () => {
    const input =
      "Start <think>Outer <think>Inner</think> continues</think> End";
    const expected = "Start  End";
    expect(stripThinking(input)).toBe(expected);
  });

  it("should handle multiline thinking sections", () => {
    const input =
      "Before\n<think>\nThis is\nmulti-line\nthinking\n</think>\nAfter";
    const expected = "Before\n\nAfter";
    expect(stripThinking(input)).toBe(expected);
  });

  it("should return the original text if no thinking tags are present", () => {
    const input = "This has no thinking tags at all";
    expect(stripThinking(input)).toBe(input);
  });

  it("should handle malformed or incomplete thinking tags", () => {
    const input =
      "Text with <think>incomplete tag and <think>nested incomplete";
    // The regex won't match incomplete tags
    expect(stripThinking(input)).toBe(input);
  });

  it("should handle complex nested patterns", () => {
    const input =
      "Start <think>Level 1 <think>Level 2</think> more level 1 <think>another level 2</think> end level 1</think> End";
    const expected = "Start  End";
    expect(stripThinking(input)).toBe(expected);
  });
});

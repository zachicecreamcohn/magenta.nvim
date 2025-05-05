import { describe, it, expect } from "vitest";
import { processLlmOutput } from "./provider";
import type { MagentaOptions } from "../options";

describe("provider utilities", () => {
  describe("processLlmOutput", () => {
    it("should strip thinking sections when hide_thinking is true", () => {
      const testText =
        "Hello! <think>This is a thinking section that should be hidden</think> Here is the rest of my response.";
      const options: MagentaOptions = {
        profiles: [
          {
            name: "test",
            provider: "anthropic",
            model: "test-model",
          },
        ],
        activeProfile: "test",
        sidebarPosition: "left",
        commandAllowlist: [],
        autoContext: [],
        hide_thinking: true,
      };

      const result = processLlmOutput(testText, options);

      expect(result).not.toContain("<think>");
      expect(result).not.toContain("</think>");
      expect(result).not.toContain(
        "This is a thinking section that should be hidden",
      );
      expect(result).toBe("Hello!  Here is the rest of my response.");
    });

    it("should keep thinking sections when hide_thinking is false", () => {
      const testText =
        "Hello! <think>This is a thinking section that should be visible</think> Here is the rest of my response.";
      const options: MagentaOptions = {
        profiles: [
          {
            name: "test",
            provider: "anthropic",
            model: "test-model",
          },
        ],
        activeProfile: "test",
        sidebarPosition: "left",
        commandAllowlist: [],
        autoContext: [],
        hide_thinking: false,
      };

      const result = processLlmOutput(testText, options);

      expect(result).toContain("<think>");
      expect(result).toContain("</think>");
      expect(result).toContain(
        "This is a thinking section that should be visible",
      );
      expect(result).toBe(testText);
    });

    it("should handle nested thinking sections", () => {
      const testText =
        "Hello! <think>Outer thinking <think>Inner thinking</think> continues</think> Here is the response.";
      const options: MagentaOptions = {
        profiles: [
          {
            name: "test",
            provider: "anthropic",
            model: "test-model",
          },
        ],
        activeProfile: "test",
        sidebarPosition: "left",
        commandAllowlist: [],
        autoContext: [],
        hide_thinking: true,
      };

      const result = processLlmOutput(testText, options);

      expect(result).not.toContain("<think>");
      expect(result).not.toContain("</think>");
      expect(result).not.toContain("Outer thinking");
      expect(result).not.toContain("Inner thinking");
      expect(result).not.toContain("continues");
      expect(result).toBe("Hello!  Here is the response.");
    });

    it("should handle multi-line thinking sections", () => {
      const testText =
        "Hello!\n<think>\nThis is a multi-line\nthinking section\nthat should be hidden\n</think>\nHere is the rest of my response.";
      const options: MagentaOptions = {
        profiles: [
          {
            name: "test",
            provider: "anthropic",
            model: "test-model",
          },
        ],
        activeProfile: "test",
        sidebarPosition: "left",
        commandAllowlist: [],
        autoContext: [],
        hide_thinking: true,
      };

      const result = processLlmOutput(testText, options);

      expect(result).not.toContain("<think>");
      expect(result).not.toContain("</think>");
      expect(result).not.toContain("This is a multi-line");
      expect(result).toBe("Hello!\n\nHere is the rest of my response.");
    });
  });
});

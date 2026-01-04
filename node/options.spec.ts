import { describe, expect, it } from "vitest";
import { mergeOptions, type MagentaOptions } from "./options.ts";

describe("mergeOptions", () => {
  const baseOptions: MagentaOptions = {
    profiles: [
      { name: "test", provider: "mock", model: "mock", fastModel: "mock-fast" },
    ],
    activeProfile: "test",
    sidebarPosition: "left",
    sidebarPositionOpts: {
      above: { displayHeightPercentage: 0.3, inputHeightPercentage: 0.1 },
      below: { displayHeightPercentage: 0.3, inputHeightPercentage: 0.1 },
      tab: { displayHeightPercentage: 0.8 },
      left: { widthPercentage: 0.4, displayHeightPercentage: 0.8 },
      right: { widthPercentage: 0.4, displayHeightPercentage: 0.8 },
    },
    maxConcurrentSubagents: 3,
    commandConfig: { commands: [], pipeCommands: [] },
    autoContext: [],
    skillsPaths: [],
    mcpServers: {},
    getFileAutoAllowGlobs: [],
    customCommands: [],
  };

  describe("commandConfig merging", () => {
    it("should combine commands from both configs", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          commands: [["git", "status", { type: "restAny" }]],
          pipeCommands: [],
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          commands: [["npm", "install", { type: "restAny" }]],
          pipeCommands: [],
        },
      });

      expect(merged.commandConfig.commands).toEqual([
        ["git", "status", { type: "restAny" }],
        ["npm", "install", { type: "restAny" }],
      ]);
    });

    it("should combine pipeCommands from both configs", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          commands: [],
          pipeCommands: [["head", "-n", { type: "any" }]],
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          commands: [],
          pipeCommands: [["grep", { type: "any" }]],
        },
      });

      expect(merged.commandConfig.pipeCommands).toEqual([
        ["head", "-n", { type: "any" }],
        ["grep", { type: "any" }],
      ]);
    });

    it("should combine both commands and pipeCommands arrays", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          commands: [["cat", { type: "file" }]],
          pipeCommands: [["head"]],
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          commands: [["cat", "-n", { type: "file" }]],
          pipeCommands: [["head", "-n", { type: "any" }]],
        },
      });

      expect(merged.commandConfig.commands).toEqual([
        ["cat", { type: "file" }],
        ["cat", "-n", { type: "file" }],
      ]);
      expect(merged.commandConfig.pipeCommands).toEqual([
        ["head"],
        ["head", "-n", { type: "any" }],
      ]);
    });

    it("should handle empty base config", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: { commands: [], pipeCommands: [] },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          commands: [["git", "status"]],
          pipeCommands: [["grep", { type: "any" }]],
        },
      });

      expect(merged.commandConfig.commands).toEqual([["git", "status"]]);
      expect(merged.commandConfig.pipeCommands).toEqual([
        ["grep", { type: "any" }],
      ]);
    });

    it("should handle empty project config", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          commands: [["git", "status"]],
          pipeCommands: [["head"]],
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: { commands: [], pipeCommands: [] },
      });

      expect(merged.commandConfig.commands).toEqual([["git", "status"]]);
      expect(merged.commandConfig.pipeCommands).toEqual([["head"]]);
    });
  });
});

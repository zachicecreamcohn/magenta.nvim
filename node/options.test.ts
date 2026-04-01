import { describe, expect, it } from "vitest";
import { type MagentaOptions, mergeOptions } from "./options.ts";

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
    commandConfig: { rules: [] },
    autoContext: [],
    skillsPaths: [],
    agentsPaths: [],
    mcpServers: {},
    getFileAutoAllowGlobs: [],
    filePermissions: [],
    customCommands: [],
  };

  describe("commandConfig merging", () => {
    it("should combine rules from both configs", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          rules: [
            { cmd: "git", subcommands: [{ cmd: "status", rest: "any" }] },
          ],
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          rules: [
            { cmd: "npm", subcommands: [{ cmd: "install", rest: "any" }] },
          ],
        },
      });

      expect(merged.commandConfig.rules).toEqual([
        { cmd: "git", subcommands: [{ cmd: "status", rest: "any" }] },
        { cmd: "npm", subcommands: [{ cmd: "install", rest: "any" }] },
      ]);
    });

    it("should combine pipe and non-pipe rules", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          rules: [{ cmd: "cat", args: ["readFile"] }],
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          rules: [{ cmd: "grep", rest: "any", pipe: true }],
        },
      });

      expect(merged.commandConfig.rules).toEqual([
        { cmd: "cat", args: ["readFile"] },
        { cmd: "grep", rest: "any", pipe: true },
      ]);
    });

    it("should handle empty base config", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: { rules: [] },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          rules: [
            { cmd: "git", subcommands: [{ cmd: "status", rest: "any" }] },
          ],
        },
      });

      expect(merged.commandConfig.rules).toEqual([
        { cmd: "git", subcommands: [{ cmd: "status", rest: "any" }] },
      ]);
    });

    it("should handle empty project config", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          rules: [
            { cmd: "git", subcommands: [{ cmd: "status", rest: "any" }] },
          ],
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: { rules: [] },
      });

      expect(merged.commandConfig.rules).toEqual([
        { cmd: "git", subcommands: [{ cmd: "status", rest: "any" }] },
      ]);
    });
  });
});

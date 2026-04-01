import { describe, expect, it } from "vitest";
import {
  type MagentaOptions,
  type SandboxConfig,
  DEFAULT_SANDBOX_CONFIG,
  mergeOptions,
  parseOptions,
  parseProjectOptions,
} from "./options.ts";

function makeBaseOptions(overrides?: Partial<MagentaOptions>): MagentaOptions {
  return {
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
    sandbox: { ...DEFAULT_SANDBOX_CONFIG },
    autoContext: [],
    skillsPaths: [],
    agentsPaths: [],
    mcpServers: {},
    customCommands: [],
    ...overrides,
  };
}

const noopLogger = {
  warn: () => {},
  error: () => {},
};

describe("parseSandboxConfig", () => {
  it("should parse valid sandbox config", () => {
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
      sandbox: {
        enabled: true,
        allowedReadPaths: ["/home", "/tmp"],
        allowedWritePaths: ["/tmp"],
        allowedCommands: ["ls", "cat"],
        networkAccess: true,
      },
    };
    const result = parseOptions(input, noopLogger);
    expect(result.sandbox).toEqual({
      enabled: true,
      allowedReadPaths: ["/home", "/tmp"],
      allowedWritePaths: ["/tmp"],
      allowedCommands: ["ls", "cat"],
      networkAccess: true,
    });
  });

  it("should fill defaults for missing fields", () => {
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
      sandbox: {
        enabled: true,
      },
    };
    const result = parseOptions(input, noopLogger);
    expect(result.sandbox).toEqual({
      enabled: true,
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedCommands: [],
      networkAccess: false,
    });
  });

  it("should use all defaults when sandbox is not provided", () => {
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
    };
    const result = parseOptions(input, noopLogger);
    expect(result.sandbox).toEqual(DEFAULT_SANDBOX_CONFIG);
  });
});

describe("parseProjectOptions sandbox", () => {
  it("should parse sandbox from project options", () => {
    const result = parseProjectOptions(
      {
        sandbox: {
          enabled: true,
          allowedReadPaths: ["/project"],
        },
      },
      noopLogger,
    );
    expect(result.sandbox).toEqual({
      enabled: true,
      allowedReadPaths: ["/project"],
      allowedWritePaths: [],
      allowedCommands: [],
      networkAccess: false,
    });
  });
});

describe("mergeOptions", () => {
  it("should concatenate sandbox arrays and overwrite enabled", () => {
    const base = makeBaseOptions({
      sandbox: {
        enabled: false,
        allowedReadPaths: ["/home"],
        allowedWritePaths: ["/tmp"],
        allowedCommands: ["ls"],
        networkAccess: false,
      },
    });

    const merged = mergeOptions(base, {
      sandbox: {
        enabled: true,
        allowedReadPaths: ["/project"],
        allowedWritePaths: ["/project/out"],
        allowedCommands: ["cat"],
        networkAccess: true,
      },
    });

    expect(merged.sandbox).toEqual({
      enabled: true,
      allowedReadPaths: ["/home", "/project"],
      allowedWritePaths: ["/tmp", "/project/out"],
      allowedCommands: ["ls", "cat"],
      networkAccess: true,
    });
  });

  it("should keep base sandbox when project has no sandbox", () => {
    const base = makeBaseOptions({
      sandbox: {
        enabled: true,
        allowedReadPaths: ["/home"],
        allowedWritePaths: [],
        allowedCommands: ["ls"],
        networkAccess: false,
      },
    });

    const merged = mergeOptions(base, {});
    expect(merged.sandbox).toEqual(base.sandbox);
  });
});

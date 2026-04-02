import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxConfig } from "./options.ts";
import { DEFAULT_SANDBOX_CONFIG } from "./options.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";

const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockIsSupportedPlatform = vi.fn().mockReturnValue(true);
const mockCheckDependencies = vi
  .fn()
  .mockReturnValue({ warnings: [] as string[], errors: [] as string[] });
const mockUpdateConfig = vi.fn();
const mockReset = vi.fn().mockResolvedValue(undefined);

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    isSupportedPlatform: () => mockIsSupportedPlatform(),
    checkDependencies: () => mockCheckDependencies(),
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
    reset: () => mockReset(),
  },
}));

const cwd = "/home/user/project" as NvimCwd;
const homeDir = "/home/user" as HomeDir;

function makeConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return structuredClone({ ...DEFAULT_SANDBOX_CONFIG, ...overrides });
}

describe("sandbox-manager", () => {
  let initializeSandbox: typeof import("./sandbox-manager.ts").initializeSandbox;
  let resolveConfigPaths: typeof import("./sandbox-manager.ts").resolveConfigPaths;

  beforeEach(async () => {
    vi.resetModules();

    mockInitialize.mockReset().mockResolvedValue(undefined);
    mockIsSupportedPlatform.mockReset().mockReturnValue(true);
    mockCheckDependencies
      .mockReset()
      .mockReturnValue({ warnings: [], errors: [] });
    mockUpdateConfig.mockReset();
    mockReset.mockReset().mockResolvedValue(undefined);
    logger.warn.mockReset();

    vi.doMock("@anthropic-ai/sandbox-runtime", () => ({
      SandboxManager: {
        initialize: (...args: unknown[]) => mockInitialize(...args),
        isSupportedPlatform: () => mockIsSupportedPlatform(),
        checkDependencies: () => mockCheckDependencies(),
        updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
        reset: () => mockReset(),
      },
    }));

    const mod = await import("./sandbox-manager.ts");
    initializeSandbox = mod.initializeSandbox;
    resolveConfigPaths = mod.resolveConfigPaths;
  });

  const logger = { warn: vi.fn() };

  describe("initializeSandbox", () => {
    it("disabled config returns disabled sandbox", async () => {
      const config = makeConfig({ enabled: false });
      const sandbox = await initializeSandbox(
        config,
        cwd,
        homeDir,
        undefined,
        logger,
      );
      expect(sandbox.getState()).toEqual({ status: "disabled" });
      expect(mockInitialize).not.toHaveBeenCalled();
    });

    it("unsupported platform returns unsupported sandbox", async () => {
      mockIsSupportedPlatform.mockReturnValue(false);
      const config = makeConfig();
      const sandbox = await initializeSandbox(
        config,
        cwd,
        homeDir,
        undefined,
        logger,
      );
      expect(sandbox.getState()).toEqual({
        status: "unsupported",
        reason: "Sandbox is not supported on this platform",
      });
      expect(logger.warn).toHaveBeenCalled();
      expect(mockInitialize).not.toHaveBeenCalled();
    });

    it("dependency errors return unsupported sandbox with reason", async () => {
      mockCheckDependencies.mockReturnValue({
        warnings: [],
        errors: ["bwrap not found"],
      });
      const config = makeConfig();
      const sandbox = await initializeSandbox(
        config,
        cwd,
        homeDir,
        undefined,
        logger,
      );
      const state = sandbox.getState();
      expect(state.status).toBe("unsupported");
      if (state.status === "unsupported") {
        expect(state.reason).toContain("bwrap not found");
      }
      expect(logger.warn).toHaveBeenCalled();
      expect(mockInitialize).not.toHaveBeenCalled();
    });

    it("successful init returns ready sandbox", async () => {
      const config = makeConfig();
      const askCallback = vi
        .fn()
        .mockResolvedValue(
          true,
        ) as unknown as import("@anthropic-ai/sandbox-runtime").SandboxAskCallback;
      const sandbox = await initializeSandbox(
        config,
        cwd,
        homeDir,
        askCallback,
        logger,
      );
      expect(sandbox.getState()).toEqual({ status: "ready" });
      expect(mockInitialize).toHaveBeenCalledOnce();
      const calledConfig = mockInitialize.mock
        .calls[0][0] as import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig;
      expect(calledConfig.filesystem.allowWrite).toEqual(
        expect.arrayContaining(["/home/user/project"]),
      );
      expect(mockInitialize.mock.calls[0][2]).toBe(true);
    });

    it("dependency warnings are logged but do not prevent initialization", async () => {
      mockCheckDependencies.mockReturnValue({
        warnings: ["seccomp not available"],
        errors: [],
      });
      const config = makeConfig();
      const sandbox = await initializeSandbox(
        config,
        cwd,
        homeDir,
        undefined,
        logger,
      );
      expect(sandbox.getState()).toEqual({ status: "ready" });
      expect(logger.warn).toHaveBeenCalledWith(
        "Sandbox dependency warning: seccomp not available",
      );
      expect(mockInitialize).toHaveBeenCalledOnce();
    });
  });

  describe("resolveConfigPaths", () => {
    it("expands ~/ to homeDir", () => {
      const config = makeConfig({
        filesystem: { allowWrite: [], denyWrite: [], denyRead: ["~/.ssh"] },
      });
      const resolved = resolveConfigPaths(config, cwd, homeDir);
      expect(resolved.filesystem.denyRead).toEqual(["/home/user/.ssh"]);
    });

    it("expands ./ to cwd", () => {
      const config = makeConfig({
        filesystem: { allowWrite: ["./"], denyWrite: [], denyRead: [] },
      });
      const resolved = resolveConfigPaths(config, cwd, homeDir);
      expect(resolved.filesystem.allowWrite).toEqual(["/home/user/project"]);
    });

    it("leaves absolute paths unchanged", () => {
      const config = makeConfig({
        filesystem: { allowWrite: ["/tmp/build"], denyWrite: [], denyRead: [] },
      });
      const resolved = resolveConfigPaths(config, cwd, homeDir);
      expect(resolved.filesystem.allowWrite).toEqual(["/tmp/build"]);
    });

    it("resolves relative paths to cwd-relative", () => {
      const config = makeConfig({
        filesystem: { allowWrite: ["src/output"], denyWrite: [], denyRead: [] },
      });
      const resolved = resolveConfigPaths(config, cwd, homeDir);
      expect(resolved.filesystem.allowWrite).toEqual([
        "/home/user/project/src/output",
      ]);
    });

    it("passes network config through unchanged", () => {
      const config = makeConfig({
        network: {
          allowedDomains: ["example.com"],
          deniedDomains: ["evil.com"],
        },
      });
      const resolved = resolveConfigPaths(config, cwd, homeDir);
      expect(resolved.network.allowedDomains).toEqual(["example.com"]);
      expect(resolved.network.deniedDomains).toEqual(["evil.com"]);
    });
  });

  describe("updateConfigIfChanged on sandbox instance", () => {
    it("does not call updateConfig when config is unchanged", async () => {
      const config = makeConfig();
      const sandbox = await initializeSandbox(
        config,
        cwd,
        homeDir,
        undefined,
        logger,
      );
      mockUpdateConfig.mockClear();

      sandbox.updateConfigIfChanged(config, cwd, homeDir);
      expect(mockUpdateConfig).not.toHaveBeenCalled();
    });

    it("calls updateConfig when config has changed", async () => {
      const config = makeConfig();
      const sandbox = await initializeSandbox(
        config,
        cwd,
        homeDir,
        undefined,
        logger,
      );
      mockUpdateConfig.mockClear();

      const changedConfig = makeConfig({
        filesystem: {
          allowWrite: ["./", "/tmp"],
          denyWrite: [".env"],
          denyRead: [],
        },
      });
      sandbox.updateConfigIfChanged(changedConfig, cwd, homeDir);
      expect(mockUpdateConfig).toHaveBeenCalledOnce();
      const calledConfig = mockUpdateConfig.mock
        .calls[0][0] as import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig;
      expect(calledConfig.filesystem.allowWrite).toContain("/tmp");
    });
  });
});

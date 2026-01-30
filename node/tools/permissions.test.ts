import { test, expect, describe } from "vitest";
import {
  canReadFile,
  canWriteFile,
  getEffectivePermissions,
  hasNewSecretSegment,
} from "./permissions.ts";
import type { AbsFilePath, NvimCwd } from "../utils/files.ts";
import type { MagentaOptions, FilePermission } from "../options.ts";
import type { Nvim } from "../nvim/nvim-node";
import os from "os";

const mockNvim = {
  logger: {
    error: () => {},
  },
} as unknown as Nvim;

const defaultOptions: MagentaOptions = {
  skillsPaths: [],
  getFileAutoAllowGlobs: [],
  filePermissions: [],
} as unknown as MagentaOptions;

describe("getEffectivePermissions", () => {
  const cwd = "/home/user/project" as NvimCwd;

  test("returns cwd default permissions for files in cwd", () => {
    const result = getEffectivePermissions(
      "/home/user/project/src/file.ts" as AbsFilePath,
      [],
      cwd,
    );
    expect(result).toEqual({
      read: true,
      write: true,
      readSecret: false,
      writeSecret: false,
    });
  });

  test("returns no permissions for files outside cwd without explicit rules", () => {
    const result = getEffectivePermissions(
      "/tmp/other/file.txt" as AbsFilePath,
      [],
      cwd,
    );
    expect(result).toEqual({
      read: false,
      write: false,
      readSecret: false,
      writeSecret: false,
    });
  });

  test("unions permissions from multiple matching rules", () => {
    const permissions: FilePermission[] = [
      { path: "/tmp", read: true },
      { path: "/tmp/special", write: true },
    ];
    const result = getEffectivePermissions(
      "/tmp/special/file.txt" as AbsFilePath,
      permissions,
      cwd,
    );
    expect(result).toEqual({
      read: true,
      write: true,
      readSecret: false,
      writeSecret: false,
    });
  });

  test("handles tilde expansion in permission paths", () => {
    const permissions: FilePermission[] = [{ path: "~/.config", read: true }];
    const homeDir = os.homedir();
    const result = getEffectivePermissions(
      `${homeDir}/.config/nvim/init.lua` as AbsFilePath,
      permissions,
      cwd,
    );
    expect(result.read).toBe(true);
  });

  test("handles relative permission paths", () => {
    const permissions: FilePermission[] = [
      { path: "vendor", read: true, write: true },
    ];
    const result = getEffectivePermissions(
      "/home/user/project/vendor/lib/file.ts" as AbsFilePath,
      permissions,
      cwd,
    );
    expect(result).toEqual({
      read: true,
      write: true,
      readSecret: false,
      writeSecret: false,
    });
  });

  test("grants secret permissions when specified", () => {
    const permissions: FilePermission[] = [
      { path: "/secrets", readSecret: true, writeSecret: true },
    ];
    const result = getEffectivePermissions(
      "/secrets/.env" as AbsFilePath,
      permissions,
      cwd,
    );
    expect(result).toEqual({
      read: false,
      write: false,
      readSecret: true,
      writeSecret: true,
    });
  });
});

describe("hasNewSecretSegment", () => {
  const cwd = "/home/user/project" as NvimCwd;

  test("returns false when no hidden segments after permission path", () => {
    const result = hasNewSecretSegment(
      "/home/user/.config/nvim/init.lua" as AbsFilePath,
      "/home/user/.config",
      cwd,
    );
    expect(result).toBe(false);
  });

  test("returns true when hidden segment appears after permission path", () => {
    const result = hasNewSecretSegment(
      "/home/user/.config/nvim/.env" as AbsFilePath,
      "/home/user/.config",
      cwd,
    );
    expect(result).toBe(true);
  });

  test("returns true for hidden file in non-hidden directory", () => {
    const result = hasNewSecretSegment(
      "/home/user/project/.secret" as AbsFilePath,
      "/home/user/project",
      cwd,
    );
    expect(result).toBe(true);
  });

  test("returns true for file in hidden directory", () => {
    const result = hasNewSecretSegment(
      "/home/user/project/.hidden/file.txt" as AbsFilePath,
      "/home/user/project",
      cwd,
    );
    expect(result).toBe(true);
  });

  test("handles tilde expansion", () => {
    const homeDir = os.homedir();
    const result = hasNewSecretSegment(
      `${homeDir}/.config/nvim/init.lua` as AbsFilePath,
      "~/.config",
      cwd,
    );
    expect(result).toBe(false);
  });

  test("returns false when file path doesn't start with permission path", () => {
    const result = hasNewSecretSegment(
      "/other/path/.secret" as AbsFilePath,
      "/home/user/project",
      cwd,
    );
    expect(result).toBe(false);
  });
});

describe("canReadFile", () => {
  test("returns true for files in /tmp/magenta directory", async () => {
    const result = await canReadFile(
      "/tmp/magenta/threads/abc123/tools/tool_1/bashCommand.log" as AbsFilePath,
      {
        cwd: "/home/user/project" as NvimCwd,
        nvim: mockNvim,
        options: defaultOptions,
      },
    );
    expect(result).toBe(true);
  });

  test("returns false for other /tmp files without explicit permission", async () => {
    const result = await canReadFile("/tmp/other/file.txt" as AbsFilePath, {
      cwd: "/home/user/project" as NvimCwd,
      nvim: mockNvim,
      options: defaultOptions,
    });
    expect(result).toBe(false);
  });

  test("returns true for /tmp files with explicit permission", async () => {
    const options = {
      ...defaultOptions,
      filePermissions: [{ path: "/tmp", read: true }] as FilePermission[],
    };
    const result = await canReadFile("/tmp/other/file.txt" as AbsFilePath, {
      cwd: "/home/user/project" as NvimCwd,
      nvim: mockNvim,
      options,
    });
    expect(result).toBe(true);
  });

  test("returns true for files in project cwd", async () => {
    const result = await canReadFile(
      "/home/user/project/src/file.ts" as AbsFilePath,
      {
        cwd: "/home/user/project" as NvimCwd,
        nvim: mockNvim,
        options: defaultOptions,
      },
    );
    expect(result).toBe(true);
  });

  test("returns false for hidden files in cwd without secret permission", async () => {
    const result = await canReadFile(
      "/home/user/project/.hidden/file.ts" as AbsFilePath,
      {
        cwd: "/home/user/project" as NvimCwd,
        nvim: mockNvim,
        options: defaultOptions,
      },
    );
    expect(result).toBe(false);
  });

  test("returns true for hidden files with readSecret permission", async () => {
    const options = {
      ...defaultOptions,
      filePermissions: [
        { path: "/home/user/project", readSecret: true },
      ] as FilePermission[],
    };
    const result = await canReadFile("/home/user/project/.env" as AbsFilePath, {
      cwd: "/home/user/project" as NvimCwd,
      nvim: mockNvim,
      options,
    });
    expect(result).toBe(true);
  });

  test("returns true for gitignored files (gitignore no longer blocks)", async () => {
    const result = await canReadFile(
      "/home/user/project/node_modules/lib/file.js" as AbsFilePath,
      {
        cwd: "/home/user/project" as NvimCwd,
        nvim: mockNvim,
        options: defaultOptions,
      },
    );
    expect(result).toBe(true);
  });

  test("permission inheritance: parent grants child access", async () => {
    const options = {
      ...defaultOptions,
      filePermissions: [{ path: "/external", read: true }] as FilePermission[],
    };
    const result = await canReadFile(
      "/external/deep/nested/file.ts" as AbsFilePath,
      {
        cwd: "/home/user/project" as NvimCwd,
        nvim: mockNvim,
        options,
      },
    );
    expect(result).toBe(true);
  });

  test("readSecret allows reading hidden files under permission path", async () => {
    const homeDir = os.homedir();
    const options = {
      ...defaultOptions,
      filePermissions: [
        { path: "~/.config", read: true, readSecret: true },
      ] as FilePermission[],
    };
    const result = await canReadFile(
      `${homeDir}/.config/app/.secret-config` as AbsFilePath,
      {
        cwd: "/home/user/project" as NvimCwd,
        nvim: mockNvim,
        options,
      },
    );
    expect(result).toBe(true);
  });
});

describe("canWriteFile", () => {
  test("returns true for files in project cwd", () => {
    const result = canWriteFile(
      "/home/user/project/src/file.ts" as AbsFilePath,
      {
        cwd: "/home/user/project" as NvimCwd,
        options: defaultOptions,
      },
    );
    expect(result).toBe(true);
  });

  test("returns false for files outside cwd without explicit permission", () => {
    const result = canWriteFile("/tmp/file.txt" as AbsFilePath, {
      cwd: "/home/user/project" as NvimCwd,
      options: defaultOptions,
    });
    expect(result).toBe(false);
  });

  test("returns true for files outside cwd with explicit write permission", () => {
    const options = {
      ...defaultOptions,
      filePermissions: [{ path: "/tmp", write: true }] as FilePermission[],
    };
    const result = canWriteFile("/tmp/file.txt" as AbsFilePath, {
      cwd: "/home/user/project" as NvimCwd,
      options,
    });
    expect(result).toBe(true);
  });

  test("returns false for hidden files in cwd without secret permission", () => {
    const result = canWriteFile("/home/user/project/.env" as AbsFilePath, {
      cwd: "/home/user/project" as NvimCwd,
      options: defaultOptions,
    });
    expect(result).toBe(false);
  });

  test("returns true for hidden files with writeSecret permission", () => {
    const options = {
      ...defaultOptions,
      filePermissions: [
        { path: "/home/user/project", writeSecret: true },
      ] as FilePermission[],
    };
    const result = canWriteFile("/home/user/project/.env" as AbsFilePath, {
      cwd: "/home/user/project" as NvimCwd,
      options,
    });
    expect(result).toBe(true);
  });

  test("returns true for gitignored files (gitignore no longer blocks)", () => {
    const result = canWriteFile(
      "/home/user/project/dist/bundle.js" as AbsFilePath,
      {
        cwd: "/home/user/project" as NvimCwd,
        options: defaultOptions,
      },
    );
    expect(result).toBe(true);
  });
});

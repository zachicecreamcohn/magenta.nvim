import * as fs from "node:fs/promises";
import {
  containsGlobChars,
  globToRegex,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import type { FileIO } from "@magenta/core";
import type { BufferTracker } from "../buffer-tracker.ts";
import type { Line, NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import type { FsReadConfig, Sandbox } from "../sandbox-manager.ts";
import { getBufferIfOpen } from "../utils/buffers.ts";
import {
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";

export class SandboxFileIO implements FileIO {
  constructor(
    private context: {
      nvim: Nvim;
      bufferTracker: BufferTracker;
      cwd: NvimCwd;
      homeDir: HomeDir;
    },
    private sandbox: Sandbox,
    private promptForWriteApproval: (absPath: string) => Promise<void>,
  ) {}

  private resolvePath(path: string): AbsFilePath {
    return resolveFilePath(
      this.context.cwd,
      path as UnresolvedFilePath,
      this.context.homeDir,
    );
  }

  /** Replicate the seatbelt matching logic from sandbox-runtime:
   *  - literal paths use subpath matching (path + all children)
   *  - glob patterns use regex matching via globToRegex
   */
  private pathMatchesPattern(absPath: string, pattern: string): boolean {
    if (containsGlobChars(pattern)) {
      return new RegExp(globToRegex(pattern)).test(absPath);
    }
    return absPath === pattern || absPath.startsWith(`${pattern}/`);
  }

  isReadBlocked(absPath: string): boolean {
    if (this.sandbox.getState().status !== "ready") return false;
    const readConfig = this.sandbox.getFsReadConfig();
    const isDenied = readConfig.denyOnly.some((pattern) =>
      this.pathMatchesPattern(absPath, pattern),
    );
    if (!isDenied) return false;
    const isReAllowed = (readConfig.allowWithinDeny ?? []).some((pattern) =>
      this.pathMatchesPattern(absPath, pattern),
    );
    return !isReAllowed;
  }

  async readFile(path: string): Promise<string> {
    const abs = this.resolvePath(path);
    if (this.isReadBlocked(abs)) {
      throw new Error(`Sandbox: read access denied for ${path}`);
    }
    return fs.readFile(abs, "utf-8");
  }

  async readBinaryFile(path: string): Promise<Buffer> {
    const abs = this.resolvePath(path);
    if (this.isReadBlocked(abs)) {
      throw new Error(`Sandbox: read access denied for ${path}`);
    }
    return fs.readFile(abs);
  }

  isWriteBlocked(absPath: string): boolean {
    if (this.sandbox.getState().status !== "ready") return true;
    const writeConfig = this.sandbox.getFsWriteConfig();
    const inAllowed = writeConfig.allowOnly.some((pattern) =>
      this.pathMatchesPattern(absPath, pattern),
    );
    if (!inAllowed) return true;
    const inDeny = writeConfig.denyWithinAllow.some((pattern) =>
      this.pathMatchesPattern(absPath, pattern),
    );
    return inDeny;
  }

  private async findOpenBuffer(
    absPath: AbsFilePath,
  ): Promise<NvimBuffer | undefined> {
    const result = await getBufferIfOpen({
      unresolvedPath: absPath,
      context: this.context,
    });
    if (result.status === "ok") {
      return result.buffer;
    }
    return undefined;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = this.resolvePath(path);
    if (this.isWriteBlocked(abs)) {
      await this.promptForWriteApproval(abs);
    }

    const buffer = await this.findOpenBuffer(abs);
    if (buffer) {
      const lines = content.split("\n") as Line[];
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines,
      });
      await buffer.attemptWrite();
      await this.context.bufferTracker.trackBufferSync(abs, buffer.id);
    } else {
      await fs.writeFile(abs, content, "utf-8");
    }
  }

  async fileExists(path: string): Promise<boolean> {
    const abs = this.resolvePath(path);
    try {
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    const abs = this.resolvePath(path);
    await fs.mkdir(abs, { recursive: true });
  }

  async stat(
    path: string,
  ): Promise<{ mtimeMs: number; size: number } | undefined> {
    const abs = this.resolvePath(path);
    try {
      const stats = await fs.stat(abs);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return undefined;
    }
  }
}

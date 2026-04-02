import type { FileIO } from "@magenta/core";
import type { Sandbox } from "../sandbox-manager.ts";
import {
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";

export class SandboxFileIO implements FileIO {
  constructor(
    private inner: FileIO,
    private context: { cwd: NvimCwd; homeDir: HomeDir },
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

  isReadBlocked(absPath: string): boolean {
    if (this.sandbox.getState().status !== "ready") return false;
    const readConfig = this.sandbox.getFsReadConfig();
    return (
      readConfig.denyOnly.some(
        (denied) => absPath === denied || absPath.startsWith(denied + "/"),
      ) &&
      !(readConfig.allowWithinDeny ?? []).some(
        (allowed) => absPath === allowed || absPath.startsWith(allowed + "/"),
      )
    );
  }

  isWriteBlocked(absPath: string): boolean {
    if (this.sandbox.getState().status !== "ready") return true;
    const writeConfig = this.sandbox.getFsWriteConfig();
    const inAllowed = writeConfig.allowOnly.some(
      (allowed) =>
        absPath === allowed ||
        allowed === "/" ||
        absPath.startsWith(allowed + "/"),
    );
    if (!inAllowed) return true;
    const inDeny = writeConfig.denyWithinAllow.some(
      (denied) =>
        absPath === denied ||
        denied === "/" ||
        absPath.startsWith(denied + "/"),
    );
    return inDeny;
  }

  async readFile(path: string): Promise<string> {
    const abs = this.resolvePath(path);
    if (this.isReadBlocked(abs)) {
      throw new Error(`Sandbox: read access denied for ${path}`);
    }
    return this.inner.readFile(path);
  }

  async readBinaryFile(path: string): Promise<Buffer> {
    const abs = this.resolvePath(path);
    if (this.isReadBlocked(abs)) {
      throw new Error(`Sandbox: read access denied for ${path}`);
    }
    return this.inner.readBinaryFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = this.resolvePath(path);
    if (this.isWriteBlocked(abs)) {
      await this.promptForWriteApproval(abs);
    }
    return this.inner.writeFile(path, content);
  }

  async fileExists(path: string): Promise<boolean> {
    return this.inner.fileExists(path);
  }

  async mkdir(path: string): Promise<void> {
    return this.inner.mkdir(path);
  }

  async stat(
    path: string,
  ): Promise<{ mtimeMs: number; size: number } | undefined> {
    return this.inner.stat(path);
  }
}

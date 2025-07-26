import fs from "node:fs";
import type { Nvim } from "../nvim/nvim-node";
import { getBufferIfOpen } from "../utils/buffers.ts";
import type { MessageId } from "../chat/message.ts";
import {
  resolveFilePath,
  type AbsFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import { getcwd } from "../nvim/nvim.ts";
import type { Row0Indexed } from "../nvim/window.ts";

export interface FileSnapshot {
  content: string;
  timestamp: number;
}

export class FileSnapshots {
  private snapshots: Map<string, FileSnapshot> = new Map();
  private nvim: Nvim;

  constructor(nvim: Nvim) {
    this.nvim = nvim;
  }

  /**
   * Creates a key for the snapshots map from a messageId and filePath
   */
  private createKey(messageId: MessageId, absFilePath: AbsFilePath): string {
    return `${messageId}:${absFilePath}`;
  }

  /**
   * Take a snapshot of a file before it's edited by the assistant
   * @param absFilePath The path to the file that will be edited
   * @param messageId The ID of the message that is editing the file
   * @returns Promise<boolean> True if a new snapshot was taken, false if one already existed
   */
  public async willEditFile(
    unresolvedPath: UnresolvedFilePath,
    messageId: MessageId,
  ): Promise<boolean> {
    const cwd = await getcwd(this.nvim);
    const absFilePath = resolveFilePath(cwd, unresolvedPath);
    const key = this.createKey(messageId, absFilePath);
    // If we already have a snapshot for this file and message, don't take another one
    if (this.snapshots.has(key)) {
      return false;
    }

    try {
      // Get the content of the file, either from an open buffer or from disk
      const content = await this.getFileContent(absFilePath);

      // Store the snapshot
      this.snapshots.set(key, {
        content,
        timestamp: Date.now(),
      });

      return true;
    } catch {
      // File might not exist yet, which is fine for new files
      // Just store an empty snapshot
      this.snapshots.set(key, {
        content: "",
        timestamp: Date.now(),
      });

      return true;
    }
  }

  /**
   * Get the content of a file, either from an open buffer or from disk
   * @param filePath The path to the file
   * @returns Promise<string> The content of the file
   */
  private async getFileContent(absFilePath: AbsFilePath): Promise<string> {
    const bufferResult = await getBufferIfOpen({
      unresolvedPath: absFilePath,
      context: { nvim: this.nvim },
    });

    if (bufferResult.status === "ok") {
      // Get content from buffer
      const lines = await bufferResult.buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      return lines.join("\n");
    } else {
      // Get content from disk
      return fs.promises.readFile(absFilePath, "utf-8");
    }
  }

  /**
   * Get a snapshot for a specific file and message
   * @param absFilePath The path to the file
   * @param messageId The ID of the message
   * @returns The file snapshot or undefined if none exists
   */
  public getSnapshot(
    absFilePath: AbsFilePath,
    messageId: MessageId,
  ): FileSnapshot | undefined {
    const key = this.createKey(messageId, absFilePath);
    return this.snapshots.get(key);
  }

  /**
   * Clear snapshots for a specific message or all snapshots if no messageId is provided
   * @param messageId Optional ID of the message to clear snapshots for
   */
  public clearSnapshots(messageId?: MessageId): void {
    if (!messageId) {
      this.snapshots.clear();
      return;
    }

    // Remove all snapshots for the specified messageId
    for (const key of this.snapshots.keys()) {
      if (key.startsWith(`${messageId}:`)) {
        this.snapshots.delete(key);
      }
    }
  }
}

import fs from "node:fs";
import path from "node:path";
import type { Nvim } from "nvim-node";
import { getcwd } from "../nvim/nvim.ts";
import { getBufferIfOpen } from "../utils/buffers.ts";
import type { MessageId } from "../chat/message.ts";

// Nominal type for FilePath
export type FilePath = string & { __filePath: true };

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
  private createKey(messageId: MessageId, filePath: FilePath): string {
    return `${messageId}:${filePath}`;
  }

  /**
   * Take a snapshot of a file before it's edited by the assistant
   * @param filePath The path to the file that will be edited
   * @param messageId The ID of the message that is editing the file
   * @returns Promise<boolean> True if a new snapshot was taken, false if one already existed
   */
  public async willEditFile(filePath: FilePath, messageId: MessageId): Promise<boolean> {
    const key = this.createKey(messageId, filePath);

    // If we already have a snapshot for this file and message, don't take another one
    if (this.snapshots.has(key)) {
      return false;
    }

    try {
      // Get the content of the file, either from an open buffer or from disk
      const content = await this.getFileContent(filePath);

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
  private async getFileContent(filePath: FilePath): Promise<string> {
    const cwd = await getcwd(this.nvim);
    const relFilePath = path.relative(cwd, filePath as string);

    // First check if the file is open in a buffer
    const bufferResult = await getBufferIfOpen({
      relativePath: relFilePath,
      context: { nvim: this.nvim },
    });

    if (bufferResult.status === "ok") {
      // Get content from buffer
      const lines = await bufferResult.buffer.getLines({
        start: 0,
        end: -1,
      });
      return lines.join("\n");
    } else {
      // Get content from disk
      return fs.promises.readFile(filePath as string, "utf-8");
    }
  }

  /**
   * Get a snapshot for a specific file and message
   * @param filePath The path to the file
   * @param messageId The ID of the message
   * @returns The file snapshot or undefined if none exists
   */
  public getSnapshot(filePath: FilePath, messageId: MessageId): FileSnapshot | undefined {
    const key = this.createKey(messageId, filePath);
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

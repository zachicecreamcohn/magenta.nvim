import type { AbsFilePath } from "./utils/files.ts";
import type { Nvim } from "./nvim/nvim-node";

export interface TextChange {
  filePath: AbsFilePath;
  oldText: string;
  newText: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  timestamp: Date;
}

export class ChangeTracker {
  private changes: TextChange[] = [];
  private maxChanges: number;

  constructor(
    private nvim: Nvim,
    options: {
      maxChanges?: number;
    } = {},
  ) {
    this.maxChanges = options.maxChanges ?? 100;
  }

  onTextDocumentDidChange(data: {
    filePath: string;
    oldText: string;
    newText: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  }): void {
    const change: TextChange = {
      filePath: data.filePath as AbsFilePath,
      oldText: data.oldText,
      newText: data.newText,
      range: data.range,
      timestamp: new Date(),
    };

    this.changes.push(change);

    // Keep only the latest N changes
    if (this.changes.length > this.maxChanges) {
      this.changes.shift();
    }

    this.nvim.logger.debug(
      `Tracked change in ${data.filePath}: "${data.oldText}" -> "${data.newText}"`,
    );
  }

  getChanges(): TextChange[] {
    return [...this.changes];
  }

  getChangesForFile(filePath: AbsFilePath): TextChange[] {
    return this.changes.filter((change) => change.filePath === filePath);
  }

  getRecentChanges(count: number): TextChange[] {
    return this.changes.slice(-count);
  }

  clear(): void {
    this.changes = [];
  }

  getChangeCount(): number {
    return this.changes.length;
  }
}

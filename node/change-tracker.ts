import type { AbsFilePath, RelFilePath, NvimCwd } from "./utils/files.ts";
import { relativePath } from "./utils/files.ts";
import type { Nvim } from "./nvim/nvim-node";

export interface TextChange {
  filePath: RelFilePath;
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
    private cwd: NvimCwd,
    options: {
      maxChanges?: number;
    } = {},
  ) {
    this.maxChanges = options.maxChanges ?? 5;
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
    const absFilePath = data.filePath as AbsFilePath;
    const relFilePath = relativePath(this.cwd, absFilePath);

    const change: TextChange = {
      filePath: relFilePath,
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
  }

  getChanges(): TextChange[] {
    return [...this.changes];
  }

  getChangesForFile(filePath: RelFilePath): TextChange[] {
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

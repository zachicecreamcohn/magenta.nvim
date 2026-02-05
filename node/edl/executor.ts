import * as fs from "node:fs/promises";
import { Document } from "./document.ts";
import type { Command, Pattern } from "./parser.ts";
import type {
  FileMutationSummary,
  Range,
  ScriptResult,
  TraceEntry,
} from "./types.ts";

export class ExecutionError extends Error {
  constructor(
    message: string,
    public trace: TraceEntry[] = [],
  ) {
    super(message);
  }
}

const MAX_SNIPPET_LENGTH = 120;

export type FileState = {
  doc: Document;
  path: string;
  mutations: FileMutationSummary;
  isNew?: boolean;
};

export class Executor {
  public trace: TraceEntry[] = [];
  public registers = new Map<string, string>();
  public fileDocs = new Map<string, FileState>();
  public currentFile: FileState | undefined;
  public selection: Range[] = [];

  async getOrLoadFile(path: string): Promise<FileState> {
    let state = this.fileDocs.get(path);
    if (!state) {
      let content: string;
      try {
        content = await fs.readFile(path, "utf-8");
      } catch (e) {
        throw new ExecutionError(
          `Failed to read file: ${path}: ${e instanceof Error ? e.message : String(e)}`,
          this.trace,
        );
      }
      state = {
        doc: new Document(content),
        path,
        mutations: {
          insertions: 0,
          deletions: 0,
          replacements: 0,
          linesAdded: 0,
          linesRemoved: 0,
        },
      };
      this.fileDocs.set(path, state);
    }
    return state;
  }

  requireFile(): FileState {
    if (!this.currentFile)
      throw new ExecutionError(
        "No file selected. Use 'file' command first.",
        this.trace,
      );
    return this.currentFile;
  }

  requireSingleSelect(): Range {
    if (this.selection.length !== 1) {
      throw new ExecutionError(
        `Expected single selection, got ${this.selection.length}`,
        this.trace,
      );
    }
    return this.selection[0];
  }

  findAllMatches(
    pattern: Pattern,
    doc: Document,
    withinRanges: Range[],
  ): Range[] {
    const results: Range[] = [];
    for (const scope of withinRanges) {
      const scopeText = doc.getText(scope);
      const matches = this.findInText(pattern, scopeText, doc, scope.start);
      results.push(...matches);
    }
    return results;
  }

  findInText(
    pattern: Pattern,
    text: string,
    doc: Document,
    baseOffset: number,
  ): Range[] {
    switch (pattern.type) {
      case "regex": {
        const results: Range[] = [];
        const flags = pattern.pattern.flags.includes("g")
          ? pattern.pattern.flags
          : pattern.pattern.flags + "g";
        const re = new RegExp(pattern.pattern.source, flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          results.push({
            start: baseOffset + m.index,
            end: baseOffset + m.index + m[0].length,
          });
          if (m[0].length === 0) re.lastIndex++;
        }
        return results;
      }
      case "literal": {
        const results: Range[] = [];
        let idx = 0;
        while ((idx = text.indexOf(pattern.text, idx)) !== -1) {
          results.push({
            start: baseOffset + idx,
            end: baseOffset + idx + pattern.text.length,
          });
          idx += pattern.text.length || 1;
        }
        return results;
      }
      case "line": {
        return [doc.lineRange(pattern.line)];
      }
      case "lineCol": {
        const offset = doc.posToOffset({
          line: pattern.line,
          col: pattern.col,
        });
        return [{ start: offset, end: offset }];
      }
      case "bof":
        return [{ start: 0, end: 0 }];
      case "eof":
        return [{ start: doc.content.length, end: doc.content.length }];
    }
  }

  addTrace(command: string, ranges: Range[], doc: Document): void {
    const texts = ranges.map((r) => doc.getText(r));
    const snippet =
      texts.length === 1
        ? Executor.formatSnippet(texts[0])
        : texts.map((t) => Executor.formatSnippet(t)).join(" | ");
    this.trace.push({ command, ranges: [...ranges], snippet });
  }

  static formatSnippet(text: string): string {
    const lines = text.split("\n");
    if (lines.length === 1) {
      const line = lines[0];
      if (line.length > MAX_SNIPPET_LENGTH) {
        const half = Math.floor((MAX_SNIPPET_LENGTH - 3) / 2);
        return line.slice(0, half) + "..." + line.slice(line.length - half);
      }
      return line;
    }
    const first = lines[0];
    const last = lines[lines.length - 1];
    return first + "\n...\n" + last;
  }

  static countLines(text: string): number {
    if (text.length === 0) return 0;
    let count = 1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") count++;
    }
    return count;
  }

  static recalcSelectionAfterReplace(
    originalRanges: Range[],
    replacementText: string,
  ): Range[] {
    const sorted = [...originalRanges].sort((a, b) => a.start - b.start);
    const result: Range[] = [];
    let offsetShift = 0;
    for (const range of sorted) {
      const newStart = range.start + offsetShift;
      const newEnd = newStart + replacementText.length;
      result.push({ start: newStart, end: newEnd });
      const oldLen = range.end - range.start;
      offsetShift += replacementText.length - oldLen;
    }
    return result;
  }

  async execute(commands: Command[]): Promise<ScriptResult> {
    for (const cmd of commands) {
      switch (cmd.type) {
        case "file": {
          this.currentFile = await this.getOrLoadFile(cmd.path);
          this.selection = [this.currentFile.doc.fullRange()];
          this.trace.push({
            command: `file ${cmd.path}`,
            ranges: [...this.selection],
            snippet: `switched to ${cmd.path} (${this.currentFile.doc.lineCount} lines)`,
          });
          break;
        }
        case "newfile": {
          if (this.fileDocs.has(cmd.path)) {
            throw new ExecutionError(
              `newfile: file already loaded: ${cmd.path}`,
              this.trace,
            );
          }
          let exists = true;
          try {
            await fs.access(cmd.path);
          } catch {
            exists = false;
          }
          if (exists) {
            throw new ExecutionError(
              `newfile: file already exists on disk: ${cmd.path}`,
              this.trace,
            );
          }
          const state: FileState = {
            doc: new Document(""),
            path: cmd.path,
            mutations: {
              insertions: 0,
              deletions: 0,
              replacements: 0,
              linesAdded: 0,
              linesRemoved: 0,
            },
            isNew: true,
          };
          this.fileDocs.set(cmd.path, state);
          this.currentFile = state;
          this.selection = [{ start: 0, end: 0 }];
          this.trace.push({
            command: `newfile ${cmd.path}`,
            ranges: [...this.selection],
            snippet: `created ${cmd.path}`,
          });
          break;
        }

        case "select": {
          const file = this.requireFile();
          const matches = this.findAllMatches(
            cmd.pattern,
            file.doc,
            this.selection,
          );
          if (matches.length === 0)
            throw new ExecutionError(
              `select: no matches for pattern`,
              this.trace,
            );
          this.selection = matches;
          this.addTrace("select", this.selection, file.doc);
          break;
        }

        case "select_first": {
          const file = this.requireFile();
          const matches = this.findAllMatches(
            cmd.pattern,
            file.doc,
            this.selection,
          );
          if (matches.length === 0)
            throw new ExecutionError(
              "select_first: no matches for pattern",
              this.trace,
            );
          this.selection = [matches[0]];
          this.addTrace("select_first", this.selection, file.doc);
          break;
        }

        case "select_last": {
          const file = this.requireFile();
          const matches = this.findAllMatches(
            cmd.pattern,
            file.doc,
            this.selection,
          );
          if (matches.length === 0)
            throw new ExecutionError(
              "select_last: no matches for pattern",
              this.trace,
            );
          this.selection = [matches[matches.length - 1]];
          this.addTrace("select_last", this.selection, file.doc);
          break;
        }

        case "select_one": {
          const file = this.requireFile();
          const matches = this.findAllMatches(
            cmd.pattern,
            file.doc,
            this.selection,
          );
          if (matches.length === 0)
            throw new ExecutionError(
              "select_one: no matches for pattern",
              this.trace,
            );
          if (matches.length > 1)
            throw new ExecutionError(
              `select_one: expected 1 match, got ${matches.length}`,
              this.trace,
            );
          this.selection = [matches[0]];
          this.addTrace("select_one", this.selection, file.doc);
          break;
        }

        case "select_next": {
          const file = this.requireFile();
          const current = this.requireSingleSelect();
          const searchText = file.doc.content.slice(current.end);
          const matches = this.findInText(
            cmd.pattern,
            searchText,
            file.doc,
            current.end,
          );
          if (matches.length === 0)
            throw new ExecutionError(
              "select_next: no matches after selection",
              this.trace,
            );
          this.selection = [matches[0]];
          this.addTrace("select_next", this.selection, file.doc);
          break;
        }

        case "select_prev": {
          const file = this.requireFile();
          const current = this.requireSingleSelect();
          const searchText = file.doc.content.slice(0, current.start);
          const matches = this.findInText(cmd.pattern, searchText, file.doc, 0);
          if (matches.length === 0)
            throw new ExecutionError(
              "select_prev: no matches before selection",
              this.trace,
            );
          this.selection = [matches[matches.length - 1]];
          this.addTrace("select_prev", this.selection, file.doc);
          break;
        }

        case "extend_forward": {
          const file = this.requireFile();
          const current = this.requireSingleSelect();
          const searchText = file.doc.content.slice(current.end);
          const matches = this.findInText(
            cmd.pattern,
            searchText,
            file.doc,
            current.end,
          );
          if (matches.length === 0)
            throw new ExecutionError(
              "extend_forward: no matches after selection",
              this.trace,
            );
          this.selection = [{ start: current.start, end: matches[0].end }];
          this.addTrace("extend_forward", this.selection, file.doc);
          break;
        }

        case "extend_back": {
          const file = this.requireFile();
          const current = this.requireSingleSelect();
          const searchText = file.doc.content.slice(0, current.start);
          const matches = this.findInText(cmd.pattern, searchText, file.doc, 0);
          if (matches.length === 0)
            throw new ExecutionError(
              "extend_back: no matches before selection",
              this.trace,
            );
          this.selection = [
            {
              start: matches[matches.length - 1].start,
              end: current.end,
            },
          ];
          this.addTrace("extend_back", this.selection, file.doc);
          break;
        }

        case "nth": {
          if (this.selection.length === 0)
            throw new ExecutionError("nth: no selections", this.trace);
          const n = cmd.n < 0 ? this.selection.length + cmd.n : cmd.n;
          if (n < 0 || n >= this.selection.length)
            throw new ExecutionError(
              `nth: index ${cmd.n} out of range (${this.selection.length} selections)`,
              this.trace,
            );
          this.selection = [this.selection[n]];
          const file = this.requireFile();
          this.addTrace(`nth ${cmd.n}`, this.selection, file.doc);
          break;
        }

        case "replace": {
          const file = this.requireFile();
          if (this.selection.length === 0)
            throw new ExecutionError("replace: no selection", this.trace);
          const sorted = [...this.selection].sort((a, b) => b.start - a.start);
          for (const range of sorted) {
            const oldText = file.doc.getText(range);
            file.doc.splice(range, cmd.text);
            file.mutations.replacements++;
            file.mutations.linesRemoved += Executor.countLines(oldText);
            file.mutations.linesAdded += Executor.countLines(cmd.text);
          }
          this.selection = Executor.recalcSelectionAfterReplace(
            this.selection,
            cmd.text,
          );
          this.addTrace("replace", this.selection, file.doc);
          break;
        }

        case "delete": {
          const file = this.requireFile();
          if (this.selection.length === 0)
            throw new ExecutionError("delete: no selection", this.trace);
          this.addTrace("delete", this.selection, file.doc);
          const sorted = [...this.selection].sort((a, b) => b.start - a.start);
          for (const range of sorted) {
            const oldText = file.doc.getText(range);
            file.doc.splice(range, "");
            file.mutations.deletions++;
            file.mutations.linesRemoved += Executor.countLines(oldText);
          }
          const firstRange = this.selection[0];
          this.selection = [{ start: firstRange.start, end: firstRange.start }];
          break;
        }

        case "insert_before": {
          const file = this.requireFile();
          if (this.selection.length === 0)
            throw new ExecutionError("insert_before: no selection", this.trace);
          const sorted = [...this.selection].sort((a, b) => b.start - a.start);
          for (const range of sorted) {
            file.doc.splice({ start: range.start, end: range.start }, cmd.text);
            file.mutations.insertions++;
            file.mutations.linesAdded += Executor.countLines(cmd.text);
          }
          this.addTrace("insert_before", this.selection, file.doc);
          break;
        }

        case "insert_after": {
          const file = this.requireFile();
          if (this.selection.length === 0)
            throw new ExecutionError("insert_after: no selection", this.trace);
          const sorted = [...this.selection].sort((a, b) => b.start - a.start);
          for (const range of sorted) {
            file.doc.splice({ start: range.end, end: range.end }, cmd.text);
            file.mutations.insertions++;
            file.mutations.linesAdded += Executor.countLines(cmd.text);
          }
          this.addTrace("insert_after", this.selection, file.doc);
          break;
        }

        case "cut": {
          const file = this.requireFile();
          const range = this.requireSingleSelect();
          const text = file.doc.getText(range);
          this.registers.set(cmd.register, text);
          file.doc.splice(range, "");
          file.mutations.deletions++;
          file.mutations.linesRemoved += Executor.countLines(text);
          this.addTrace(`cut ${cmd.register}`, [range], file.doc);
          this.selection = [{ start: range.start, end: range.start }];
          break;
        }

        case "paste": {
          const file = this.requireFile();
          const text = this.registers.get(cmd.register);
          if (text === undefined)
            throw new ExecutionError(
              `paste: register "${cmd.register}" is empty`,
              this.trace,
            );
          const range = this.requireSingleSelect();
          file.doc.splice({ start: range.end, end: range.end }, text);
          file.mutations.insertions++;
          file.mutations.linesAdded += Executor.countLines(text);
          this.addTrace(`paste ${cmd.register}`, [range], file.doc);
          break;
        }
      }
    }

    const mutations = new Map<string, FileMutationSummary>();
    const newFiles = new Set<string>();
    for (const [path, state] of this.fileDocs) {
      const m = state.mutations;
      if (m.insertions > 0 || m.deletions > 0 || m.replacements > 0) {
        mutations.set(path, m);
      }
      if (state.isNew) {
        newFiles.add(path);
      }
    }

    for (const path of new Set([...mutations.keys(), ...newFiles])) {
      const state = this.fileDocs.get(path)!;
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) {
        await fs.mkdir(dir, { recursive: true });
      }
      await fs.writeFile(path, state.doc.content, "utf-8");
    }

    return {
      trace: this.trace,
      finalSelection:
        this.selection.length > 0 && this.currentFile
          ? {
              ranges: this.selection,
              snippet: this.selection
                .map((r) =>
                  Executor.formatSnippet(this.currentFile!.doc.getText(r)),
                )
                .join(" | "),
            }
          : undefined,
      mutations,
    };
  }
}

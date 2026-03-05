import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";

import type { MagentaOptions } from "../options.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";

import {
  displayPath,
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
  type FileTypeInfo,
  FileCategory,
} from "../utils/files.ts";
import { d, withBindings, withExtmark, withInlineCode } from "../tea/view.ts";
import open from "open";

import {
  CoreContextManager,
  type ContextFiles,
  type FileUpdates,
  type ToolApplied,
  type FileIO,
} from "@magenta/core";

export type { ContextFiles as Files, FileUpdates } from "@magenta/core";
export type {
  Patch,
  WholeFileUpdate,
  DiffUpdate,
  FileDeletedUpdate,
  FileUpdate,
} from "@magenta/core";
export type { ToolApplied as ToolApplication } from "@magenta/core";

type Files = ContextFiles;

export type Msg =
  | {
      type: "add-file-context";
      relFilePath: RelFilePath;
      absFilePath: AbsFilePath;
      fileTypeInfo: FileTypeInfo;
    }
  | {
      type: "remove-file-context";
      absFilePath: AbsFilePath;
    }
  | {
      type: "open-file";
      absFilePath: AbsFilePath;
    }
  | {
      type: "tool-applied";
      absFilePath: AbsFilePath;
      tool: ToolApplied;
      fileTypeInfo: FileTypeInfo;
    };

export class ContextManager {
  public core: CoreContextManager;

  get files(): Files {
    return this.core.files;
  }

  constructor(
    public myDispatch: Dispatch<Msg>,
    private context: {
      cwd: NvimCwd;
      homeDir: HomeDir;
      dispatch: Dispatch<RootMsg>;
      fileIO: FileIO;
      nvim: Nvim;
      options: MagentaOptions;
    },
    initialFiles: Files = {},
  ) {
    this.core = new CoreContextManager(
      context.nvim.logger,
      context.fileIO,
      context.cwd,
      context.homeDir,
      initialFiles,
    );
  }

  async addFiles(...args: Parameters<CoreContextManager["addFiles"]>) {
    return this.core.addFiles(...args);
  }

  reset() {
    this.core.reset();
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "add-file-context":
        this.core.addFileContext(
          msg.absFilePath,
          msg.relFilePath,
          msg.fileTypeInfo,
        );
        return;

      case "remove-file-context":
        this.core.removeFileContext(msg.absFilePath);
        return;

      case "open-file": {
        const fileInfo = this.core.files[msg.absFilePath];

        if (fileInfo && fileInfo.fileTypeInfo.category !== FileCategory.TEXT) {
          open(msg.absFilePath).catch((error: Error) => {
            this.context.nvim.logger.error(
              `Failed to open file with OS: ${error.message}`,
            );
          });
        } else {
          openFileInNonMagentaWindow(msg.absFilePath, {
            nvim: this.context.nvim,
            cwd: this.context.cwd,
            homeDir: this.context.homeDir,
            options: this.context.options,
          }).catch((e: Error) => this.context.nvim.logger.error(e.message));
        }

        return;
      }

      case "tool-applied":
        this.core.toolApplied(msg.absFilePath, msg.tool, msg.fileTypeInfo);
        return;

      default:
        assertUnreachable(msg);
    }
  }

  isContextEmpty(): boolean {
    return this.core.isContextEmpty();
  }

  async getContextUpdate(): Promise<FileUpdates> {
    return this.core.getContextUpdate();
  }

  contextUpdatesToContent(
    ...args: Parameters<CoreContextManager["contextUpdatesToContent"]>
  ) {
    return this.core.contextUpdatesToContent(...args);
  }

  view() {
    const fileContext = [];
    if (Object.keys(this.core.files).length == 0) {
      return "";
    }

    for (const absFilePath in this.core.files) {
      const fileInfo = this.core.files[absFilePath as AbsFilePath];
      const pathForDisplay = displayPath(
        this.context.cwd,
        absFilePath as AbsFilePath,
        this.context.homeDir,
      );

      const pdfInfo =
        fileInfo.agentView?.type === "pdf"
          ? this.formatPdfInfo({
              summary: fileInfo.agentView.summary,
              pages: fileInfo.agentView.pages,
            })
          : "";

      fileContext.push(
        withBindings(
          d`- ${withInlineCode(d`\`${pathForDisplay}\`${pdfInfo}`)}\n`,
          {
            dd: () =>
              this.myDispatch({
                type: "remove-file-context",
                absFilePath: absFilePath as AbsFilePath,
              }),
            "<CR>": () =>
              this.myDispatch({
                type: "open-file",
                absFilePath: absFilePath as AbsFilePath,
              }),
          },
        ),
      );
    }

    return d`\
${withExtmark(d`# context:`, { hl_group: "@markup.heading.1.markdown" })}
${fileContext}`;
  }

  private formatPageRanges(pages: number[]): string {
    if (pages.length === 0) return "";

    const ranges: string[] = [];
    let start = pages[0];
    let end = pages[0];

    for (let i = 1; i < pages.length; i++) {
      if (pages[i] === end + 1) {
        end = pages[i];
      } else {
        if (start === end) {
          ranges.push(start.toString());
        } else {
          ranges.push(`${start}-${end}`);
        }
        start = pages[i];
        end = pages[i];
      }
    }

    if (start === end) {
      ranges.push(start.toString());
    } else {
      ranges.push(`${start}-${end}`);
    }

    return ranges.join(", ");
  }

  private formatPdfInfo(options: {
    summary?: boolean | undefined;
    pages?: number[] | undefined;
  }): string {
    const parts: string[] = [];

    if (options.summary) {
      parts.push("summary");
    }

    if (options.pages && options.pages.length == 1) {
      parts.push(`page ${options.pages[0]}`);
    } else if (options.pages && options.pages.length > 1) {
      const pageRanges = this.formatPageRanges(options.pages);
      parts.push(`pages ${pageRanges}`);
    }

    if (parts.length > 0) {
      return ` (${parts.join(", ")})`;
    }

    return "";
  }

  renderContextUpdate(contextUpdates: FileUpdates | undefined) {
    if (!(contextUpdates && Object.keys(contextUpdates).length)) {
      return "";
    }

    const fileUpdates = [];
    for (const path in contextUpdates) {
      const absFilePath = path as AbsFilePath;
      const update = contextUpdates[absFilePath];

      if (update.update.status === "ok") {
        let changeIndicator = "";
        switch (update.update.value.type) {
          case "diff": {
            const patch = update.update.value.patch;
            const additions = (patch.match(/^\+[^+]/gm) || []).length;
            const deletions = (patch.match(/^-[^-]/gm) || []).length;
            changeIndicator = `[ +${additions} / -${deletions} ]`;
            break;
          }
          case "whole-file": {
            let lineCount = 0;
            const lastTextBlock = update.update.value.content.findLast(
              (block) => block.type === "text",
            );
            if (lastTextBlock && lastTextBlock.type === "text") {
              lineCount = (lastTextBlock.text.match(/\n/g) || []).length + 1;
            }
            changeIndicator = `[ +${lineCount} ]`;
            break;
          }
          case "file-deleted": {
            changeIndicator = "[ deleted ]";
            break;
          }
          default:
            assertUnreachable(update.update.value);
        }

        const pdfInfo =
          update.update.value.type === "whole-file"
            ? this.formatPdfInfo({
                summary: update.update.value.pdfSummary,
                pages: update.update.value.pdfPage
                  ? [update.update.value.pdfPage]
                  : undefined,
              })
            : "";

        const pathForDisplay = displayPath(
          this.context.cwd,
          absFilePath,
          this.context.homeDir,
        );

        const filePathLink = withBindings(
          d`- \`${pathForDisplay}\`${pdfInfo}`,
          {
            "<CR>": () =>
              this.myDispatch({
                type: "open-file",
                absFilePath,
              }),
          },
        );

        fileUpdates.push(d`${filePathLink} ${changeIndicator}\n`);
      } else {
        fileUpdates.push(
          d`- \`${absFilePath}\` [Error: ${update.update.error}]\n`,
        );
      }
    }

    return fileUpdates.length > 0 ? d`Context Updates:\n${fileUpdates}\n` : "";
  }
}

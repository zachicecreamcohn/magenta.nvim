import type { ContextManager, FileUpdates } from "@magenta/core";
import open from "open";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions } from "../options.ts";
import { d, type VDOMNode, withBindings, withInlineCode } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  type AbsFilePath,
  displayPath,
  FileCategory,
  type HomeDir,
  type NvimCwd,
} from "../utils/files.ts";

export type {
  ContextFiles as Files,
  DiffUpdate,
  FileDeletedUpdate,
  FileUpdate,
  FileUpdates,
  Patch,
  ToolApplied as ToolApplication,
  WholeFileUpdate,
} from "@magenta/core";

export type ContextViewContext = {
  cwd: NvimCwd;
  homeDir: HomeDir;
  nvim: Nvim;
  options: MagentaOptions;
};

export function openFile(
  absFilePath: AbsFilePath,
  core: ContextManager,
  context: ContextViewContext,
): void {
  const fileInfo = core.files[absFilePath];

  if (fileInfo && fileInfo.fileTypeInfo.category !== FileCategory.TEXT) {
    open(absFilePath).catch((error: Error) => {
      context.nvim.logger.error(
        `Failed to open file with OS: ${error.message}`,
      );
    });
  } else {
    openFileInNonMagentaWindow(absFilePath, {
      nvim: context.nvim,
      cwd: context.cwd,
      homeDir: context.homeDir,
      options: context.options,
    }).catch((e: Error) => context.nvim.logger.error(e.message));
  }
}

function renderUpdateIndicator(
  update: FileUpdates[AbsFilePath]["update"],
): string {
  if (update.status !== "ok") {
    return `[ error: ${update.error} ]`;
  }
  switch (update.value.type) {
    case "diff": {
      const patch = update.value.patch;
      const additions = (patch.match(/^\+[^+]/gm) || []).length;
      const deletions = (patch.match(/^-[^-]/gm) || []).length;
      return `[ +${additions} / -${deletions} ]`;
    }
    case "whole-file": {
      let lineCount = 0;
      const lastTextBlock = update.value.content.findLast(
        (block) => block.type === "text",
      );
      if (lastTextBlock && lastTextBlock.type === "text") {
        lineCount = (lastTextBlock.text.match(/\n/g) || []).length + 1;
      }
      return `[ +${lineCount} lines ]`;
    }
    case "file-deleted":
      return "[ deleted ]";
    default:
      assertUnreachable(update.value);
  }
}

export function contextFilesView(
  core: ContextManager,
  context: ContextViewContext,
  view: { expanded: boolean; onToggle: () => void },
) {
  const pending = core.getPendingUpdates();
  const allPaths = Object.keys(core.files) as AbsFilePath[];
  if (allPaths.length === 0) {
    return "";
  }

  const pendingPaths = Object.keys(pending) as AbsFilePath[];
  const otherPaths = allPaths
    .filter((p) => !pending[p])
    .sort() as AbsFilePath[];

  const renderFileLine = (
    absFilePath: AbsFilePath,
    indicator: string,
  ): VDOMNode => {
    const pathForDisplay = displayPath(
      context.cwd,
      absFilePath,
      context.homeDir,
    );
    return withBindings(
      d`- ${withInlineCode(d`\`${pathForDisplay}\``)}${indicator}\n`,
      {
        dd: () => core.removeFileContext(absFilePath),
        "<CR>": () => openFile(absFilePath, core, context),
      },
    );
  };

  const pendingLines = pendingPaths
    .sort()
    .map((p) =>
      renderFileLine(p, ` ${renderUpdateIndicator(pending[p].update)}`),
    );

  if (otherPaths.length === 0) {
    return d`${pendingLines}`;
  }

  const marker = view.expanded ? "▼" : "▶";
  const label =
    pendingPaths.length > 0
      ? `${otherPaths.length.toString()} other file${otherPaths.length === 1 ? "" : "s"} in context`
      : `${otherPaths.length.toString()} file${otherPaths.length === 1 ? "" : "s"} in context`;
  const toggleLine = withBindings(d`${marker} ${label}\n`, {
    "=": () => view.onToggle(),
  });

  if (!view.expanded) {
    return d`${pendingLines}${toggleLine}`;
  }

  const otherLines = otherPaths.map((p) => renderFileLine(p, ""));
  return d`${pendingLines}${toggleLine}${otherLines}`;
}

export function renderContextUpdate(
  contextUpdates: FileUpdates | undefined,
  core: ContextManager,
  context: ContextViewContext,
) {
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
          ? formatPdfInfo({
              summary: update.update.value.pdfSummary,
              pages: update.update.value.pdfPage
                ? [update.update.value.pdfPage]
                : undefined,
            })
          : "";

      const pathForDisplay = displayPath(
        context.cwd,
        absFilePath,
        context.homeDir,
      );

      const filePathLink = withBindings(d`- \`${pathForDisplay}\`${pdfInfo}`, {
        "<CR>": () => openFile(absFilePath, core, context),
      });

      fileUpdates.push(d`${filePathLink} ${changeIndicator}\n`);
    } else {
      fileUpdates.push(
        d`- \`${absFilePath}\` [Error: ${update.update.error}]\n`,
      );
    }
  }

  return fileUpdates.length > 0 ? d`Context Updates:\n${fileUpdates}\n` : "";
}

function formatPageRanges(pages: number[]): string {
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

function formatPdfInfo(options: {
  summary?: boolean | undefined;
  pages?: number[] | undefined;
}): string {
  const parts: string[] = [];

  if (options.summary) {
    parts.push("summary");
  }

  if (options.pages && options.pages.length === 1) {
    parts.push(`page ${options.pages[0]}`);
  } else if (options.pages && options.pages.length > 1) {
    const pageRanges = formatPageRanges(options.pages);
    parts.push(`pages ${pageRanges}`);
  }

  if (parts.length > 0) {
    return ` (${parts.join(", ")})`;
  }

  return "";
}

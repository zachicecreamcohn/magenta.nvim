import type {
  CompletedToolInfo,
  DisplayContext,
  GetFile,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import { d, type VDOMNode, withInlineCode } from "../tea/view.ts";
import {
  displayPath,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";

type Input = {
  filePath: UnresolvedFilePath;
  force?: boolean;
  pdfPage?: number;
  startLine?: number;
  numLines?: number;
};

function formatGetFileDisplay(
  input: Input,
  displayContext: DisplayContext,
): VDOMNode {
  const absFilePath = resolveFilePath(
    displayContext.cwd,
    input.filePath,
    displayContext.homeDir,
  );
  const pathForDisplay = displayPath(
    displayContext.cwd,
    absFilePath,
    displayContext.homeDir,
  );
  let extraInfo = "";
  if (input.pdfPage !== undefined) {
    extraInfo = ` (page ${input.pdfPage})`;
  } else if (input.startLine !== undefined || input.numLines !== undefined) {
    const start = input.startLine ?? 1;
    const num = input.numLines;
    extraInfo =
      num !== undefined
        ? ` (lines ${start}-${start + num - 1})`
        : ` (from line ${start})`;
  }
  return withInlineCode(d`\`${pathForDisplay}\`${extraInfo}`);
}

export function renderSummary(
  request: UnionToolRequest,
  displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  return d`👀 ${formatGetFileDisplay(input, displayContext)}`;
}

export function renderResultSummary(
  info: CompletedToolInfo,
  _displayContext: DisplayContext,
): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d`${result.error}`;
  }

  let lineCount = 0;
  if (info.structuredResult.toolName === "get_file") {
    lineCount = (info.structuredResult as GetFile.StructuredResult).lineCount;
  }
  return d`${lineCount.toString()} lines`;
}

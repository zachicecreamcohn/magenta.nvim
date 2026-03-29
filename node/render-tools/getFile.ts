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
  displayContext: DisplayContext,
): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status === "error") {
    return d`${formatGetFileDisplay(input, displayContext)}`;
  }

  let lineCount = 0;
  if (info.structuredResult.toolName === "get_file") {
    lineCount = (info.structuredResult as GetFile.StructuredResult).lineCount;
  }
  const lineCountStr = lineCount > 0 ? ` [+ ${lineCount}]` : "";
  return d`${formatGetFileDisplay(input, displayContext)}${lineCountStr}`;
}

export function renderResult(
  info: CompletedToolInfo,
  _displayContext: DisplayContext,
  _expanded: boolean,
): VDOMNode | undefined {
  const result = info.result.result;

  if (result.status === "error") {
    return d`Error: ${result.error}`;
  }

  const parts: VDOMNode[] = [];
  for (const content of result.value) {
    if (content.type === "text") {
      parts.push(d`${content.text}`);
    } else if (content.type === "image") {
      parts.push(d`[Image: ${content.source.media_type}]`);
    } else if (content.type === "document") {
      parts.push(d`[Document${content.title ? `: ${content.title}` : ""}]`);
    }
  }

  if (parts.length === 0) return undefined;
  return d`${parts}`;
}

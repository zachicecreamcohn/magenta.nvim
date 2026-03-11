import type {
  CompletedToolInfo,
  DisplayContext,
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
  symbol: string;
};

export function renderInFlightSummary(
  request: UnionToolRequest,
  displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
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
  return d`🔍⚙️ ${withInlineCode(d`\`${input.symbol}\``)} in ${withInlineCode(d`\`${pathForDisplay}\``)}`;
}

export function renderCompletedSummary(
  info: CompletedToolInfo,
  displayContext: DisplayContext,
): VDOMNode {
  const input = info.request.input as Input;
  const status = info.result.result.status === "error" ? "❌" : "✅";
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
  return d`🔍${status} ${withInlineCode(d`\`${input.symbol}\``)} in ${withInlineCode(d`\`${pathForDisplay}\``)}`;
}

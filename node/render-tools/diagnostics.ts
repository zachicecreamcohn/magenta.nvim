import type {
  CompletedToolInfo,
  DisplayContext,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import { d, type VDOMNode } from "../tea/view.ts";

export function renderSummary(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  return d`🔍 diagnostics`;
}

export function renderResultSummary(info: CompletedToolInfo): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d`${result.error}`;
  }

  let diagCount = 0;
  for (const content of result.value) {
    if (content.type === "text") {
      diagCount += content.text
        .split("\n")
        .filter((l) => l.trim().length > 0).length;
    }
  }
  return d`${diagCount.toString()} diagnostics`;
}

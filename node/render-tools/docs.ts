import type {
  CompletedToolInfo,
  DisplayContext,
  Docs,
  ToolRequestId,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import type { ToolViewState } from "../chat/thread.ts";
import { d, type VDOMNode, withBindings, withInlineCode } from "../tea/view.ts";

type Input = { query: string };

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  return d`📚 docs ${withInlineCode(d`\`${input.query}\``)}`;
}

export function renderResultSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;

  if (info.result.result.status === "error") {
    return d`docs(${input.query}): error`;
  }

  if (info.structuredResult.toolName === "docs") {
    const sr = info.structuredResult as Docs.StructuredResult;
    if (sr.matchCount === 0) {
      return d`docs(${input.query}): no matches`;
    }
    const suffix = sr.truncated ? "+" : "";
    return d`docs(${input.query}): ${sr.matchCount.toString()}${suffix} match${sr.matchCount === 1 ? "" : "es"}`;
  }

  return d`docs(${input.query})`;
}

export function renderResult(
  info: CompletedToolInfo,
  context: {
    threadDispatch: (msg: {
      type: "toggle-tool-result";
      toolRequestId: ToolRequestId;
    }) => void;
  },
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  const toggleBinding = {
    "<CR>": () =>
      context.threadDispatch({
        type: "toggle-tool-result",
        toolRequestId,
      }),
  };

  const result = info.result.result;
  if (result.status === "error") {
    return withBindings(d`${result.error}`, toggleBinding);
  }

  const firstValue = result.value[0];
  if (!firstValue || firstValue.type !== "text") return undefined;

  const text = firstValue.text;
  const expanded = toolViewState.resultExpanded;

  if (expanded) {
    return withBindings(d`${text}`, toggleBinding);
  }

  const lines = text.split("\n");
  const maxLines = 10;
  if (lines.length <= maxLines) {
    return withBindings(d`${text}`, toggleBinding);
  }
  const preview = [
    ...lines.slice(0, maxLines),
    `... (${(lines.length - maxLines).toString()} more lines)`,
  ].join("\n");
  return withBindings(d`${preview}`, toggleBinding);
}

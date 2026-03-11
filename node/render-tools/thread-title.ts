import type {
  CompletedToolInfo,
  DisplayContext,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import { d, type VDOMNode } from "../tea/view.ts";

type Input = {
  title: string;
};

function getStatusEmoji(result: ProviderToolResult): string {
  return result.result.status === "error" ? "❌" : "✅";
}

export function renderInFlightSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  return d`📝⚙️ Setting thread title: "${input.title}"`;
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const status = getStatusEmoji(info.result);
  return d`📝${status} thread_title: ${input.title ?? ""}`;
}

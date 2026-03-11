import type {
  CompletedToolInfo,
  DisplayContext,
  MCPProgress,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import { d, type VDOMNode, withInlineCode } from "../tea/view.ts";
export type { MCPProgress };

export function renderInFlightSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  progress?: MCPProgress,
): VDOMNode {
  if (progress) {
    const runningTime = Math.floor((Date.now() - progress.startTime) / 1000);
    return d`🔨⚙️ (${String(runningTime)}s) MCP tool ${withInlineCode(d`\`${request.toolName}\``)}`;
  }
  return d`🔨⚙️ MCP tool ${withInlineCode(d`\`${request.toolName}\``)} processing...`;
}

function getStatusEmoji(result: ProviderToolResult): string {
  return result.result.status === "error" ? "❌" : "✅";
}

export function renderCompletedSummary(
  info: CompletedToolInfo,
  _displayContext: DisplayContext,
): VDOMNode {
  return d`🔨${getStatusEmoji(info.result)} MCP tool ${withInlineCode(d`\`${info.request.toolName}\``)}`;
}

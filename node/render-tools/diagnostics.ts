import type {
  CompletedToolInfo,
  DisplayContext,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import { d, type VDOMNode } from "../tea/view.ts";

export function renderInFlightSummary(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  return d`🔍⚙️ diagnostics`;
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d`🔍❌ diagnostics - ${result.error}`;
  }

  return d`🔍✅ diagnostics - Diagnostics retrieved`;
}

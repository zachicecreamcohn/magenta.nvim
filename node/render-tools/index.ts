import {
  type BashCommand,
  type CompletedToolInfo,
  type DisplayContext,
  isMCPTool,
  type SpawnSubagents,
  type StaticToolName,
  type ToolRequest,
  type ToolRequestId,
} from "@magenta/core";
import type { Chat } from "../chat/chat.ts";
import type { Msg as ThreadMsg, ToolViewState } from "../chat/thread.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import * as BashCommandRender from "./bashCommand.ts";
import * as DiagnosticsRender from "./diagnostics.ts";
import * as EdlRender from "./edl.ts";
import * as FindReferencesRender from "./findReferences.ts";
import * as GetFileRender from "./getFile.ts";
import * as HoverRender from "./hover.ts";
import * as MCPToolRender from "./mcp-tool.ts";
import * as SpawnSubagentsRender from "./spawn-subagents.ts";
import * as ThreadTitleRender from "./thread-title.ts";

import * as YieldToParentRender from "./yield-to-parent.ts";

export type RenderContext = {
  getDisplayWidth: () => number;
  nvim: Nvim;
  cwd: NvimCwd;
  homeDir: HomeDir;
  options: MagentaOptions;
  dispatch: Dispatch<RootMsg>;
  threadDispatch: Dispatch<ThreadMsg>;
  chat: Chat;
};

function isError(result: ProviderToolResult): boolean {
  return result.result.status === "error";
}

function formatTokenEstimate(result: ProviderToolResult): string {
  const content =
    result.result.status === "error"
      ? result.result.error
      : JSON.stringify(result.result.value);
  const tokens = Math.ceil(content.length / 4);
  return tokens >= 1000
    ? `~${(tokens / 1000).toFixed(1)}k tok`
    : `~${tokens} tok`;
}

export function renderToolSummary(
  request: ToolRequest,
  displayContext: DisplayContext,
): VDOMNode {
  const toolName = request.toolName as StaticToolName;

  if (isMCPTool(toolName)) {
    return MCPToolRender.renderSummary(request, displayContext);
  }

  switch (toolName) {
    case "get_file":
      return GetFileRender.renderSummary(request, displayContext);
    case "hover":
      return HoverRender.renderSummary(request, displayContext);
    case "find_references":
      return FindReferencesRender.renderSummary(request, displayContext);
    case "diagnostics":
      return DiagnosticsRender.renderSummary(request, displayContext);
    case "thread_title":
      return ThreadTitleRender.renderSummary(request, displayContext);
    case "edl":
      return EdlRender.renderSummary(request, displayContext);
    case "bash_command":
      return BashCommandRender.renderSummary(request, displayContext);
    case "spawn_subagents":
      return SpawnSubagentsRender.renderSummary(request, displayContext);
    case "yield_to_parent":
      return YieldToParentRender.renderSummary(request, displayContext);
    case "learn":
      return d`learn(${(request.input as { name: string }).name})`;
    default:
      assertUnreachable(toolName);
  }
}

export function renderToolInput(
  request: ToolRequest,
  displayContext: DisplayContext,
  expanded: boolean,
): VDOMNode | undefined {
  const toolName = request.toolName as StaticToolName;

  if (isMCPTool(toolName)) {
    return undefined;
  }

  switch (toolName) {
    case "bash_command":
      return BashCommandRender.renderInput(request, displayContext, expanded);
    case "edl":
      return EdlRender.renderInput(request, displayContext, expanded);
    case "spawn_subagents":
      return SpawnSubagentsRender.renderInput(
        request,
        displayContext,
        expanded,
      );
    default:
      return undefined;
  }
}

export function renderToolProgress(
  request: ToolRequest,
  progress: unknown,
  context: RenderContext,
  expanded: boolean,
): VDOMNode | undefined {
  const toolName = request.toolName as StaticToolName;

  if (isMCPTool(toolName)) {
    return MCPToolRender.renderProgress(
      request,
      progress as MCPToolRender.MCPProgress,
      context,
      expanded,
    );
  }

  switch (toolName) {
    case "bash_command":
      return BashCommandRender.renderProgress(
        request,
        progress as BashCommand.BashProgress,
        context,
        expanded,
      );
    case "spawn_subagents":
      return SpawnSubagentsRender.renderProgress(
        request,
        progress as SpawnSubagents.SpawnSubagentsProgress | undefined,
        context,
        expanded,
      );
    default:
      return undefined;
  }
}

export function renderToolResultSummary(
  info: CompletedToolInfo,
  displayContext: DisplayContext,
): VDOMNode {
  const statusEmoji = isError(info.result) ? "❌" : "✅";
  const toolName = info.request.toolName as StaticToolName;

  const tokEst = formatTokenEstimate(info.result);

  if (isMCPTool(toolName)) {
    return d`${statusEmoji} ${MCPToolRender.renderResultSummary(info, displayContext)} (${tokEst})`;
  }

  switch (toolName) {
    case "get_file":
      return d`${statusEmoji} ${GetFileRender.renderResultSummary(info, displayContext)} (${tokEst})`;
    case "bash_command":
      return d`${statusEmoji} ${BashCommandRender.renderResultSummary(info)} (${tokEst})`;
    case "hover":
      return d`${statusEmoji} ${HoverRender.renderResultSummary(info, displayContext)} (${tokEst})`;
    case "find_references":
      return d`${statusEmoji} ${FindReferencesRender.renderResultSummary(info, displayContext)} (${tokEst})`;
    case "diagnostics":
      return d`${statusEmoji} ${DiagnosticsRender.renderResultSummary(info)} (${tokEst})`;
    case "spawn_subagents":
      return d`${statusEmoji} ${SpawnSubagentsRender.renderResultSummary(info)} (${tokEst})`;
    case "yield_to_parent":
      return d`${statusEmoji} ${YieldToParentRender.renderResultSummary(info)} (${tokEst})`;
    case "learn":
      return d`${statusEmoji} learn(${(info.request.input as { name: string }).name}) (${tokEst})`;
    case "thread_title":
      return d`${statusEmoji} ${ThreadTitleRender.renderResultSummary(info)}`;
    case "edl":
      return d`${statusEmoji} ${EdlRender.renderResultSummary(info)} (${tokEst})`;
    default:
      assertUnreachable(toolName);
  }
}

export function renderToolResult(
  info: CompletedToolInfo,
  context: RenderContext,
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  const toolName = info.request.toolName as StaticToolName;

  switch (toolName) {
    case "bash_command":
      return BashCommandRender.renderResult(
        info,
        context,
        toolViewState,
        toolRequestId,
      );
    case "spawn_subagents":
      return SpawnSubagentsRender.renderResult(
        info,
        context,
        toolViewState,
        toolRequestId,
      );
    case "edl":
      return EdlRender.renderResult(
        info,
        context,
        toolViewState,
        toolRequestId,
      );
    case "get_file":
      return undefined;
    default:
      return toolViewState.resultExpanded
        ? d`${JSON.stringify(info.request.input, null, 2)}`
        : undefined;
  }
}

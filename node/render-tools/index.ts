import {
  type BashCommand,
  type CompletedToolInfo,
  type DisplayContext,
  isMCPTool,
  type SpawnForeach,
  type SpawnSubagent,
  type StaticToolName,
  type ToolRequest,
  type WaitForSubagents,
} from "@magenta/core";
import type { Chat } from "../chat/chat.ts";
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
import * as SpawnForeachRender from "./spawn-foreach.ts";
import * as SpawnSubagentRender from "./spawn-subagent.ts";
import * as ThreadTitleRender from "./thread-title.ts";
import * as WaitForSubagentsRender from "./wait-for-subagents.ts";
import * as YieldToParentRender from "./yield-to-parent.ts";

export type RenderContext = {
  getDisplayWidth: () => number;
  nvim: Nvim;
  cwd: NvimCwd;
  homeDir: HomeDir;
  options: MagentaOptions;
  dispatch: Dispatch<RootMsg>;
  chat?: Chat;
};

function isError(result: ProviderToolResult): boolean {
  return result.result.status === "error";
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
    case "spawn_subagent":
      return SpawnSubagentRender.renderSummary(request, displayContext);
    case "spawn_foreach":
      return SpawnForeachRender.renderSummary(request, displayContext);
    case "wait_for_subagents":
      return WaitForSubagentsRender.renderSummary(request, displayContext);
    case "yield_to_parent":
      return YieldToParentRender.renderSummary(request, displayContext);
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
    case "spawn_subagent":
      return SpawnSubagentRender.renderInput(request, displayContext, expanded);
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
    case "spawn_subagent":
      return SpawnSubagentRender.renderProgress(
        request,
        progress as SpawnSubagent.SpawnSubagentProgress | undefined,
        context,
        expanded,
      );
    case "spawn_foreach":
      return SpawnForeachRender.renderProgress(
        request,
        progress as SpawnForeach.SpawnForeachProgress | undefined,
        context,
        expanded,
      );
    case "wait_for_subagents":
      return WaitForSubagentsRender.renderProgress(
        request,
        progress as WaitForSubagents.WaitForSubagentsProgress | undefined,
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

  if (isMCPTool(toolName)) {
    return d`${statusEmoji} ${MCPToolRender.renderResultSummary(info, displayContext)}`;
  }

  switch (toolName) {
    case "get_file":
      return d`${statusEmoji} ${GetFileRender.renderResultSummary(info, displayContext)}`;
    case "bash_command":
      return d`${statusEmoji} ${BashCommandRender.renderResultSummary(info)}`;
    case "hover":
      return d`${statusEmoji} ${HoverRender.renderResultSummary(info, displayContext)}`;
    case "find_references":
      return d`${statusEmoji} ${FindReferencesRender.renderResultSummary(info, displayContext)}`;
    case "diagnostics":
      return d`${statusEmoji} ${DiagnosticsRender.renderResultSummary(info)}`;
    case "spawn_subagent":
      return d`${statusEmoji} ${SpawnSubagentRender.renderResultSummary(info)}`;
    case "spawn_foreach":
      return d`${statusEmoji} ${SpawnForeachRender.renderResultSummary(info)}`;
    case "wait_for_subagents":
      return d`${statusEmoji} ${WaitForSubagentsRender.renderResultSummary(info)}`;
    case "yield_to_parent":
      return d`${statusEmoji} ${YieldToParentRender.renderResultSummary(info)}`;
    case "thread_title":
      return d`${statusEmoji} ${ThreadTitleRender.renderResultSummary(info)}`;
    case "edl":
      return d`${statusEmoji} ${EdlRender.renderResultSummary(info)}`;
    default:
      assertUnreachable(toolName);
  }
}

export function renderToolResult(
  info: CompletedToolInfo,
  context: RenderContext,
  expanded: boolean,
): VDOMNode | undefined {
  const toolName = info.request.toolName as StaticToolName;

  switch (toolName) {
    case "bash_command":
      return BashCommandRender.renderResult(info, context, expanded);
    case "spawn_subagent":
      return SpawnSubagentRender.renderResult(info, context, expanded);
    case "spawn_foreach":
      return SpawnForeachRender.renderResult(info, context, expanded);
    case "edl":
      return EdlRender.renderResult(info, context, expanded);
    case "get_file":
      return GetFileRender.renderResult(info, context, expanded);
    default:
      return expanded
        ? d`${JSON.stringify(info.request.input, null, 2)}`
        : undefined;
  }
}

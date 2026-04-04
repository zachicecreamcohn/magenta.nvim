import type {
  CompletedToolInfo,
  DisplayContext,
  SpawnSubagents,
  ThreadId,
  ToolRequestId,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import { renderPendingApprovals } from "../capabilities/render-pending-approvals.ts";
import type { Chat } from "../chat/chat.ts";
import type { Msg as ThreadMsg, ToolViewState } from "../chat/thread.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode, withBindings } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";

type Input = SpawnSubagents.Input;
type SubagentEntry = SpawnSubagents.SubagentEntry;

function truncate(text: string, maxLen: number = 50): string {
  const singleLine = text.replace(/\n/g, " ");
  return singleLine.length > maxLen
    ? `${singleLine.substring(0, maxLen)}...`
    : singleLine;
}

function agentTypeLabel(entry: SubagentEntry): string {
  const t = entry.agentType;
  if (!t || t === "default") return "";
  return ` (${t})`;
}

function isDockerEntry(entry: SubagentEntry): boolean {
  return (
    entry.environment === "docker" ||
    entry.environment === "docker_unsupervised"
  );
}

type AgentRowRenderInfo = {
  entry: SubagentEntry;
  statusIcon: string;
  statusDetail?: string | undefined;
  threadId?: ThreadId | undefined;
  pendingApprovals?: VDOMNode | undefined;
};

function resolveAgentRowFromProgress(
  element: SpawnSubagents.SpawnSubagentsProgress["elements"][0],
  chat: Chat,
): AgentRowRenderInfo {
  const entry = element.entry;

  switch (element.state.status) {
    case "pending":
      return { entry, statusIcon: "⏸️" };
    case "provisioning":
      return { entry, statusIcon: "📦", statusDetail: element.state.message };
    case "spawn-error":
      return { entry, statusIcon: "❌", statusDetail: element.state.error };
    case "spawned":
      return resolveAgentRowFromThread(entry, element.state.threadId, chat);
    default:
      assertUnreachable(element.state);
  }
}

function resolveAgentRowFromThread(
  entry: SubagentEntry,
  threadId: ThreadId,
  chat: Chat,
): AgentRowRenderInfo {
  const summary = chat.getThreadSummary(threadId);
  let statusIcon: string;
  let statusDetail: string | undefined;

  switch (summary.status.type) {
    case "missing":
      statusIcon = "❓";
      statusDetail = "not found";
      break;
    case "pending":
      statusIcon = "⏳";
      statusDetail = "initializing";
      break;
    case "running":
      statusIcon = "⏳";
      statusDetail = summary.status.activity;
      break;
    case "stopped":
      statusIcon = "⏹️";
      statusDetail = `stopped (${summary.status.reason})`;
      break;
    case "yielded": {
      const lineCount = summary.status.response.split("\n").length;
      statusIcon = "✅";
      statusDetail = `${lineCount.toString()} lines`;
      break;
    }
    case "error": {
      statusIcon = "❌";
      statusDetail =
        summary.status.message.length > 50
          ? `${summary.status.message.substring(0, 47)}...`
          : summary.status.message;
      break;
    }
    default:
      assertUnreachable(summary.status);
  }

  const pendingApprovals = renderPendingApprovals(chat, threadId);
  return { entry, statusIcon, statusDetail, threadId, pendingApprovals };
}

function resolveAgentRowFromResult(
  agent: SpawnSubagents.StructuredResult["agents"][0],
  entry: SubagentEntry,
  chat: Chat,
): AgentRowRenderInfo {
  if (agent.threadId) {
    return resolveAgentRowFromThread(entry, agent.threadId, chat);
  }

  const statusIcon = agent.ok ? "✅" : "❌";
  const statusDetail = agent.responseBody
    ? `${agent.responseBody.split("\n").length.toString()} lines`
    : undefined;
  return { entry, statusIcon, statusDetail, threadId: agent.threadId };
}

function renderAgentRowContent(info: AgentRowRenderInfo): VDOMNode {
  const label = truncate(info.entry.prompt ?? "");
  const typeLabel = agentTypeLabel(info.entry);
  const detail = info.statusDetail ? `: ${info.statusDetail}` : "";
  const dockerPrefix = isDockerEntry(info.entry) ? "🐳 " : "";
  const content = d`${dockerPrefix}${info.statusIcon}${typeLabel} ${label}${detail}`;

  return info.pendingApprovals
    ? d`${content}\n${info.pendingApprovals}`
    : content;
}

function threadBindings(
  info: AgentRowRenderInfo,
  dispatch: Dispatch<RootMsg>,
): Record<string, () => void> {
  if (!info.threadId) return {};
  const threadId = info.threadId;
  return {
    "<CR>": () =>
      dispatch({
        type: "chat-msg",
        msg: { type: "select-thread", id: threadId },
      }),
  };
}

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  const count = input.agents?.length ?? 0;
  return d`🤖 spawn_subagents: ${count.toString()} agent${count === 1 ? "" : "s"}`;
}

export function renderInput(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
  _expanded: boolean,
): VDOMNode | undefined {
  return undefined;
}

export function renderProgress(
  _request: UnionToolRequest,
  progress: SpawnSubagents.SpawnSubagentsProgress | undefined,
  context: {
    dispatch: Dispatch<RootMsg>;
    threadDispatch: Dispatch<ThreadMsg>;
    chat: Chat;
  },
  _expanded: boolean,
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  if (!progress || progress.elements.length === 0) {
    return undefined;
  }

  const rows = progress.elements.map((element, idx) => {
    const info = resolveAgentRowFromProgress(element, context.chat);
    const row = renderAgentRowContent(info);
    const agentKey = String(idx);
    const itemExpanded =
      toolViewState.progressItemExpanded?.[agentKey] || false;

    const expandedContent =
      itemExpanded && info.entry.prompt ? d`${row}\n${info.entry.prompt}` : row;

    return withBindings(d`${expandedContent}\n`, {
      ...threadBindings(info, context.dispatch),
      "=": () =>
        context.threadDispatch({
          type: "toggle-tool-progress-item",
          toolRequestId,
          itemKey: agentKey,
        }),
    });
  });

  return d`${rows}`;
}

export function renderResultSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;
  const totalAgents = input.agents?.length ?? 0;

  if (result.status === "error") {
    const errorPreview =
      result.error.length > 50
        ? `${result.error.substring(0, 50)}...`
        : result.error;
    return d`${errorPreview}`;
  }

  return d`${totalAgents.toString()} agent${totalAgents === 1 ? "" : "s"}`;
}

export function renderResult(
  info: CompletedToolInfo,
  context: {
    dispatch: Dispatch<RootMsg>;
    threadDispatch: Dispatch<ThreadMsg>;
    chat: Chat;
  },
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status === "error") {
    if (toolViewState.resultExpanded) {
      return d`**Error:**\n${result.error}`;
    }
    return undefined;
  }

  if (info.structuredResult.toolName !== "spawn_subagents") return undefined;
  const sr = info.structuredResult as SpawnSubagents.StructuredResult;

  const rows = sr.agents.map((agent, idx) => {
    const entry = input.agents[idx] ?? { prompt: agent.prompt };
    const agentKey = String(idx);
    const itemExpanded = toolViewState.resultItemExpanded?.[agentKey] || false;
    const rowInfo = resolveAgentRowFromResult(agent, entry, context.chat);
    const row = renderAgentRowContent(rowInfo);

    let expandedContent: VDOMNode = row;
    if (itemExpanded) {
      const promptText = entry.prompt ?? agent.prompt;
      const responseText = agent.responseBody;
      if (promptText && responseText) {
        expandedContent = d`${row}\n**Prompt:**\n${promptText}\n\n**Response:**\n${responseText}`;
      } else if (promptText) {
        expandedContent = d`${row}\n**Prompt:**\n${promptText}`;
      } else if (responseText) {
        expandedContent = d`${row}\n${responseText}`;
      }
    }

    return withBindings(d`${expandedContent}\n`, {
      ...threadBindings(rowInfo, context.dispatch),
      "=": () =>
        context.threadDispatch({
          type: "toggle-tool-result-item",
          toolRequestId,
          itemKey: agentKey,
        }),
    });
  });

  return d`${rows}`;
}

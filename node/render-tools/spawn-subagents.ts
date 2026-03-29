import type {
  CompletedToolInfo,
  DisplayContext,
  SpawnSubagents,
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

function truncate(text: string, maxLen: number = 50): string {
  const singleLine = text.replace(/\n/g, " ");
  return singleLine.length > maxLen
    ? `${singleLine.substring(0, maxLen)}...`
    : singleLine;
}

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  const count = input.agents?.length ?? 0;
  if (count === 1) {
    const agent = input.agents[0];
    const agentType = agent.agentType;
    const isDocker =
      agentType === "docker" || agentType === "docker_unsupervised";
    const typeLabel =
      agentType && agentType !== "default" ? ` (${agentType})` : "";
    return d`${isDocker ? "🐳" : "🚀"} spawn_subagents${typeLabel}: ${truncate(agent.prompt)}`;
  }
  return d`🤖 spawn_subagents: ${count.toString()} agents`;
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
    chat?: Chat;
  },
  _expanded: boolean,
): VDOMNode | undefined {
  if (!context.chat || !progress || progress.elements.length === 0) {
    return undefined;
  }

  // Single-agent case: show detailed status like old spawn_subagent
  if (progress.elements.length === 1) {
    const element = progress.elements[0];
    return renderSingleAgentProgress(element, context);
  }

  // Multi-agent case: show list like old spawn_foreach
  const elementViews = progress.elements.map((element) =>
    renderElementProgress(element, context),
  );

  return d`${elementViews}`;
}

function renderSingleAgentProgress(
  element: SpawnSubagents.SpawnSubagentsProgress["elements"][0],
  context: {
    dispatch: Dispatch<RootMsg>;
    chat?: Chat;
  },
): VDOMNode | undefined {
  switch (element.state.status) {
    case "pending":
      return undefined;
    case "provisioning":
      return d`🐳 ${element.state.message}`;
    case "running": {
      if (!element.state.threadId || !context.chat) return undefined;
      const threadId = element.state.threadId;
      const summary = context.chat.getThreadSummary(threadId);
      const displayName = context.chat.getThreadDisplayName(threadId);

      let statusText: string;
      switch (summary.status.type) {
        case "missing":
          statusText = "❓ not found";
          break;
        case "pending":
          statusText = "⏳ initializing";
          break;
        case "running":
          statusText = `⏳ ${summary.status.activity}`;
          break;
        case "stopped":
          statusText = `⏹️ stopped (${summary.status.reason})`;
          break;
        case "yielded": {
          const lineCount = summary.status.response.split("\n").length;
          statusText = `✅ ${lineCount.toString()} lines`;
          break;
        }
        case "error": {
          const truncatedError =
            summary.status.message.length > 50
              ? `${summary.status.message.substring(0, 47)}...`
              : summary.status.message;
          statusText = `❌ error: ${truncatedError}`;
          break;
        }
        default:
          return assertUnreachable(summary.status);
      }

      const pendingApprovals = renderPendingApprovals(context.chat, threadId);
      return withBindings(
        d`${displayName}: ${statusText}${pendingApprovals ? d`${pendingApprovals}` : d``}`,
        {
          "<CR>": () =>
            context.dispatch({
              type: "chat-msg",
              msg: { type: "select-thread", id: threadId },
            }),
        },
      );
    }
    case "completed":
      return undefined;
    default:
      return assertUnreachable(element.state);
  }
}

function renderElementProgress(
  element: SpawnSubagents.SpawnSubagentsProgress["elements"][0],
  context: {
    dispatch: Dispatch<RootMsg>;
    chat?: Chat;
  },
): VDOMNode {
  const label = truncate(element.entry.prompt);

  switch (element.state.status) {
    case "pending":
      return d`  ⏸️ ${label}\n`;
    case "provisioning":
      return d`  🐳 ${label}\n`;
    case "running": {
      if (!element.state.threadId || !context.chat) {
        return d`  🚀 ${label}\n`;
      }
      const summary = context.chat.getThreadSummary(element.state.threadId);
      let statusIcon: string;
      switch (summary.status.type) {
        case "missing":
          statusIcon = "❓";
          break;
        case "pending":
          statusIcon = "⏳";
          break;
        case "running":
          statusIcon = "⏳";
          break;
        case "stopped":
          statusIcon = "⏹️";
          break;
        case "yielded":
          statusIcon = "✅";
          break;
        case "error":
          statusIcon = "❌";
          break;
        default:
          return assertUnreachable(summary.status);
      }
      const pendingApprovals = renderPendingApprovals(
        context.chat,
        element.state.threadId,
      );
      const threadId = element.state.threadId;
      return withBindings(
        d`  ${statusIcon} ${label}\n${pendingApprovals ? d`${pendingApprovals}` : d``}`,
        {
          "<CR>": () =>
            context.dispatch({
              type: "chat-msg",
              msg: { type: "select-thread", id: threadId },
            }),
        },
      );
    }
    case "completed": {
      const status = element.state.result.status === "ok" ? "✅" : "❌";
      if (element.state.threadId) {
        const threadId = element.state.threadId;
        return withBindings(d`  ${status} ${label}\n`, {
          "<CR>": () =>
            context.dispatch({
              type: "chat-msg",
              msg: { type: "select-thread", id: threadId },
            }),
        });
      }
      return d`  ${status} ${label}\n`;
    }
    default:
      return assertUnreachable(element.state);
  }
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

  if (
    totalAgents === 1 &&
    info.structuredResult.toolName === "spawn_subagents"
  ) {
    const sr = info.structuredResult as SpawnSubagents.StructuredResult;
    const agent = sr.agents[0];
    if (agent) {
      const lineInfo = agent.responseBody
        ? `${agent.responseBody.split("\n").length.toString()} lines`
        : undefined;
      return lineInfo ? d`${lineInfo}` : d``;
    }
  }

  return d`${totalAgents.toString()}/${totalAgents.toString()} agents`;
}

export function renderResult(
  info: CompletedToolInfo,
  context: {
    dispatch: Dispatch<RootMsg>;
    threadDispatch: Dispatch<ThreadMsg>;
    chat?: Chat;
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

  // Single agent case
  if (sr.agents.length === 1) {
    return renderSingleAgentResult(
      sr.agents[0],
      input.agents[0],
      toolViewState,
      toolRequestId,
      context,
    );
  }

  // Multi-agent case: each agent line has its own bindings
  const elementViews = sr.agents.map((agent, idx) => {
    const agentKey = String(idx);
    const itemExpanded = toolViewState.resultItemExpanded?.[agentKey] || false;
    return renderAgentResultLine(
      agent,
      agentKey,
      itemExpanded,
      toolRequestId,
      context,
    );
  });
  return d`${elementViews}`;
}

function renderSingleAgentResult(
  agent: SpawnSubagents.StructuredResult["agents"][0],
  inputAgent: Input["agents"][0],
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
  context: {
    dispatch: Dispatch<RootMsg>;
    threadDispatch: Dispatch<ThreadMsg>;
    chat?: Chat;
  },
): VDOMNode | undefined {
  const threadId = agent.threadId;
  const itemExpanded = toolViewState.resultItemExpanded?.["0"] || false;

  if (!itemExpanded) {
    const lineInfo = agent.responseBody
      ? `${agent.responseBody.split("\n").length.toString()} lines`
      : undefined;
    const displayName =
      threadId && context.chat
        ? context.chat.getThreadDisplayName(threadId)
        : undefined;
    const label = displayName
      ? d`→ ${displayName}${lineInfo ? ` (${lineInfo})` : ""}`
      : lineInfo
        ? d`${lineInfo}`
        : threadId
          ? d`→ ${threadId}`
          : undefined;

    if (!label) return undefined;

    return withBindings(label, {
      ...(threadId
        ? {
            "<CR>": () =>
              context.dispatch({
                type: "chat-msg",
                msg: { type: "select-thread", id: threadId },
              }),
          }
        : {}),
      "=": () =>
        context.threadDispatch({
          type: "toggle-tool-result-item",
          toolRequestId,
          itemKey: "0",
        }),
    });
  }

  const promptSection = d`**Prompt:**\n${inputAgent.prompt}`;
  const content = agent.responseBody
    ? d`${promptSection}\n\n**Response:**\n${agent.responseBody}`
    : d`${promptSection}`;

  return withBindings(content, {
    ...(threadId
      ? {
          "<CR>": () =>
            context.dispatch({
              type: "chat-msg",
              msg: { type: "select-thread", id: threadId },
            }),
        }
      : {}),
    "=": () =>
      context.threadDispatch({
        type: "toggle-tool-result-item",
        toolRequestId,
        itemKey: "0",
      }),
  });
}

function renderAgentResultLine(
  agent: SpawnSubagents.StructuredResult["agents"][0],
  agentKey: string,
  itemExpanded: boolean,
  toolRequestId: ToolRequestId,
  context: {
    dispatch: Dispatch<RootMsg>;
    threadDispatch: Dispatch<ThreadMsg>;
    chat?: Chat;
  },
): VDOMNode {
  const status = agent.ok ? "✅" : "❌";
  const label = truncate(agent.prompt);

  const bindings: Record<string, () => void> = {
    "=": () =>
      context.threadDispatch({
        type: "toggle-tool-result-item",
        toolRequestId,
        itemKey: agentKey,
      }),
  };

  if (agent.threadId) {
    const threadId = agent.threadId;
    bindings["<CR>"] = () =>
      context.dispatch({
        type: "chat-msg",
        msg: { type: "select-thread", id: threadId },
      });
  }

  if (itemExpanded && agent.responseBody) {
    return withBindings(
      d`  ${status} ${label}\n${agent.responseBody}\n`,
      bindings,
    );
  }

  return withBindings(d`  ${status} ${label}\n`, bindings);
}

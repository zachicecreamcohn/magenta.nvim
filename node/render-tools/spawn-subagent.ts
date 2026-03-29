import type {
  CompletedToolInfo,
  DisplayContext,
  SpawnSubagent,
  ThreadId,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import { renderPendingApprovals } from "../capabilities/render-pending-approvals.ts";
import type { Chat } from "../chat/chat.ts";
import type { AgentType } from "../providers/system-prompt.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode, withBindings } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";

type Input = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  agentType?: AgentType | "docker" | "docker_unsupervised";
  blocking?: boolean;
};

function truncate(text: string, maxLen: number = 50): string {
  const singleLine = text.replace(/\n/g, " ");
  return singleLine.length > maxLen
    ? `${singleLine.substring(0, maxLen)}...`
    : singleLine;
}

function agentTypeLabel(
  agentType: AgentType | "docker" | "docker_unsupervised" | undefined,
): string {
  return agentType && agentType !== "default" ? ` (${agentType})` : "";
}

function isDockerAgentType(
  agentType: AgentType | "docker" | "docker_unsupervised" | undefined,
): boolean {
  return agentType === "docker" || agentType === "docker_unsupervised";
}

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  const typeLabel = agentTypeLabel(input.agentType);
  const dockerIcon = isDockerAgentType(input.agentType);
  return d`${dockerIcon ? "🐳" : "🚀"} spawn_subagent${typeLabel}: ${truncate(input.prompt)}`;
}

export function renderInput(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
  _expanded: boolean,
): VDOMNode | undefined {
  return undefined;
}

export function renderProgress(
  request: UnionToolRequest,
  progress: SpawnSubagent.SpawnSubagentProgress | undefined,
  context: {
    dispatch: Dispatch<RootMsg>;
    chat?: Chat;
  },
  expanded: boolean,
): VDOMNode | undefined {
  const input = request.input as Input;

  if (!progress?.threadId) {
    if (progress?.provisioningMessage) {
      return d`🐳 ${progress.provisioningMessage}`;
    }
    return undefined;
  }

  if (!context.chat) {
    return undefined;
  }

  const threadId = progress.threadId;
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
      assertUnreachable(summary.status);
  }

  const pendingApprovals = renderPendingApprovals(context.chat, threadId);

  if (expanded) {
    return withBindings(
      d`${displayName}: ${statusText}${pendingApprovals ? d`${pendingApprovals}` : d``}\n\n**Prompt:**\n${input.prompt}`,
      {
        "<CR>": () =>
          context.dispatch({
            type: "chat-msg",
            msg: {
              type: "select-thread",
              id: threadId,
            },
          }),
      },
    );
  }

  return withBindings(
    d`${displayName}: ${statusText}${pendingApprovals ? d`${pendingApprovals}` : d``}`,
    {
      "<CR>": () =>
        context.dispatch({
          type: "chat-msg",
          msg: {
            type: "select-thread",
            id: threadId,
          },
        }),
    },
  );
}

export function renderResultSummary(info: CompletedToolInfo): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    const errorPreview =
      result.error.length > 50
        ? `${result.error.substring(0, 50)}...`
        : result.error;
    return d`${errorPreview}`;
  }

  return d``;
}

export function renderResult(
  info: CompletedToolInfo,
  context: {
    dispatch: Dispatch<RootMsg>;
    chat?: Chat;
  },
  expanded: boolean,
): VDOMNode | undefined {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (!expanded) {
    if (result.status === "error") {
      return undefined;
    }

    if (info.structuredResult.toolName === "spawn_subagent") {
      const sr = info.structuredResult as SpawnSubagent.StructuredResult;

      const effectiveThreadId: ThreadId | undefined = sr.threadId;

      const lineInfo = sr.responseBody
        ? `${sr.responseBody.split("\n").length.toString()} lines`
        : undefined;
      const displayName =
        effectiveThreadId && context.chat
          ? context.chat.getThreadDisplayName(effectiveThreadId)
          : undefined;
      const label = displayName
        ? d`→ ${displayName}${lineInfo ? ` (${lineInfo})` : ""}`
        : lineInfo
          ? d`${lineInfo}`
          : effectiveThreadId
            ? d`→ ${effectiveThreadId}`
            : undefined;

      if (!label) return undefined;

      if (effectiveThreadId) {
        return withBindings(label, {
          "<CR>": () => {
            context.dispatch({
              type: "chat-msg",
              msg: {
                type: "select-thread",
                id: effectiveThreadId,
              },
            });
          },
        });
      }

      return label;
    }

    return undefined;
  }

  const promptSection = d`**Prompt:**\n${input.prompt}`;

  if (result.status === "error") {
    return d`${promptSection}\n\n**Error:**\n${result.error}`;
  }

  if (info.structuredResult.toolName === "spawn_subagent") {
    const sr = info.structuredResult as SpawnSubagent.StructuredResult;
    const effectiveThreadId = sr.threadId;

    const content = sr.responseBody
      ? d`${promptSection}\n\n**Response:**\n${sr.responseBody}`
      : d`${promptSection}\n\n**Status:** Started (non-blocking)`;

    if (effectiveThreadId) {
      return withBindings(content, {
        "<CR>": () => {
          context.dispatch({
            type: "chat-msg",
            msg: {
              type: "select-thread",
              id: effectiveThreadId,
            },
          });
        },
      });
    }

    return content;
  }

  return d`${promptSection}\n\n**Status:** Started (non-blocking)`;
}

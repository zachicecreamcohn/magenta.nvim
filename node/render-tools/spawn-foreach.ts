import type {
  CompletedToolInfo,
  DisplayContext,
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
import type { Result } from "../utils/result.ts";

type ForEachElement = string & { __forEachElement: true };

type Input = {
  prompt: string;
  elements: ForEachElement[];
  contextFiles?: UnresolvedFilePath[] | undefined;
  agentType?: AgentType | undefined;
};

type SpawnForeachElementProgress =
  | { status: "pending" }
  | { status: "running"; threadId: ThreadId }
  | { status: "completed"; threadId?: ThreadId; result: Result<string> };

type SpawnForeachProgress = {
  elements: Array<{
    element: ForEachElement;
    state: SpawnForeachElementProgress;
  }>;
};

export function renderInFlightSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  progress?: SpawnForeachProgress,
): VDOMNode {
  const input = request.input as Input;
  const agentTypeText =
    input.agentType && input.agentType !== "default"
      ? ` (${input.agentType})`
      : "";

  if (!progress || progress.elements.length === 0) {
    return d`🤖⚙️ Foreach subagents${agentTypeText}: preparing...`;
  }

  const completed = progress.elements.filter(
    (el) => el.state.status === "completed",
  ).length;
  const total = progress.elements.length;

  return d`🤖⏳ Foreach subagents${agentTypeText} (${completed.toString()}/${total.toString()})`;
}

export function renderInFlightPreview(
  _request: UnionToolRequest,
  progress: SpawnForeachProgress | undefined,
  context: {
    dispatch: Dispatch<RootMsg>;
    chat?: Chat;
  },
): VDOMNode {
  if (!context.chat || !progress || progress.elements.length === 0) {
    return d``;
  }

  const elementViews = progress.elements.map((entry) => {
    switch (entry.state.status) {
      case "completed": {
        const status = entry.state.result.status === "ok" ? "✅" : "❌";
        if (entry.state.threadId) {
          return withBindings(d`  ${status} ${entry.element}\n`, {
            "<CR>": () =>
              context.dispatch({
                type: "chat-msg",
                msg: {
                  type: "select-thread",
                  id:
                    entry.state.status === "completed"
                      ? entry.state.threadId!
                      : ("" as ThreadId),
                },
              }),
          });
        }
        return d`  ${status} ${entry.element}\n`;
      }
      case "running": {
        if (!entry.state.threadId) {
          return d`  🚀 ${entry.element}\n`;
        }
        const summary = context.chat!.getThreadSummary(entry.state.threadId);
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
          context.chat!,
          entry.state.threadId,
        );
        return withBindings(
          d`  ${statusIcon} ${entry.element}\n${pendingApprovals ? d`${pendingApprovals}` : d``}`,
          {
            "<CR>": () =>
              context.dispatch({
                type: "chat-msg",
                msg: {
                  type: "select-thread",
                  id:
                    entry.state.status === "running"
                      ? entry.state.threadId
                      : ("" as ThreadId),
                },
              }),
          },
        );
      }
      case "pending":
        return d`  ⏸️ ${entry.element}\n`;
      default:
        return assertUnreachable(entry.state);
    }
  });

  return d`${elementViews}`;
}

export function renderCompletedSummary(
  info: CompletedToolInfo,
  _dispatch: Dispatch<RootMsg>,
): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  const agentTypeText =
    input.agentType && input.agentType !== "default"
      ? ` (${input.agentType})`
      : "";
  const totalElements = input.elements?.length ?? 0;
  const status = result.status === "error" ? "❌" : "✅";

  return d`🤖${status} Foreach subagents${agentTypeText} (${totalElements.toString()}/${totalElements.toString()})`;
}

export function renderCompletedPreview(info: CompletedToolInfo): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d``;
  }

  const resultText =
    result.value[0]?.type === "text" ? result.value[0].text : "";

  const elementThreadsMatch = resultText.match(
    /ElementThreads:\n([\s\S]*?)\n\n/,
  );
  const elementLines = elementThreadsMatch
    ? elementThreadsMatch[1].split("\n").filter((line) => line.includes("::"))
    : [];

  const elementViews = elementLines.map((line) => {
    const parts = line.split("::");
    if (parts.length >= 3) {
      const element = parts[0];
      const status = parts[2] === "ok" ? "✅" : "❌";
      return d`  ${status} ${element}\n`;
    }
    return d`  - ${line}\n`;
  });

  return d`${elementViews}`;
}

export function renderCompletedDetail(
  info: CompletedToolInfo,
  dispatch: Dispatch<RootMsg>,
): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d`**Error:**\n${result.error}`;
  }

  const resultText =
    result.value[0]?.type === "text" ? result.value[0].text : "";

  const elementThreadsMatch = resultText.match(
    /ElementThreads:\n([\s\S]*?)\n\n/,
  );
  const elementLines = elementThreadsMatch
    ? elementThreadsMatch[1].split("\n").filter((line) => line.includes("::"))
    : [];

  const elementViews = elementLines.map((line) => {
    const parts = line.split("::");
    if (parts.length >= 3) {
      const element = parts[0];
      const threadId = parts[1] as ThreadId;
      const status = parts[2] === "ok" ? "✅" : "❌";

      return withBindings(d`  ${status} ${element}\n`, {
        "<CR>": () => {
          dispatch({
            type: "chat-msg",
            msg: {
              type: "select-thread",
              id: threadId,
            },
          });
        },
      });
    }
    return d`  - ${line}\n`;
  });

  return d`${elementViews}`;
}

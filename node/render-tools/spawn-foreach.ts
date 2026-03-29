import type {
  CompletedToolInfo,
  DisplayContext,
  SpawnForeach,
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

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  const agentTypeText =
    input.agentType && input.agentType !== "default"
      ? ` (${input.agentType})`
      : "";

  return d`🤖 Foreach subagents${agentTypeText}`;
}

export function renderProgress(
  _request: UnionToolRequest,
  progress: SpawnForeachProgress | undefined,
  context: {
    dispatch: Dispatch<RootMsg>;
    chat?: Chat;
  },
  _expanded: boolean,
): VDOMNode | undefined {
  if (!context.chat || !progress || progress.elements.length === 0) {
    return undefined;
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

export function renderResultSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;
  const totalElements = input.elements?.length ?? 0;

  if (result.status === "error") {
    return d`error`;
  }

  return d`${totalElements.toString()}/${totalElements.toString()} elements`;
}

export function renderResult(
  info: CompletedToolInfo,
  context: { dispatch: Dispatch<RootMsg> },
  expanded: boolean,
): VDOMNode | undefined {
  const result = info.result.result;

  if (result.status === "error") {
    if (expanded) {
      return d`**Error:**\n${result.error}`;
    }
    return undefined;
  }

  if (info.structuredResult.toolName === "spawn_foreach") {
    const sr = info.structuredResult as SpawnForeach.StructuredResult;
    if (expanded) {
      const elementViews = sr.elements.map((el) => {
        const status = el.ok ? "✅" : "❌";
        if (el.threadId) {
          return withBindings(d`  ${status} ${el.name}\n`, {
            "<CR>": () => {
              context.dispatch({
                type: "chat-msg",
                msg: {
                  type: "select-thread",
                  id: el.threadId!,
                },
              });
            },
          });
        }
        return d`  ${status} ${el.name}\n`;
      });
      return d`${elementViews}`;
    }
    const elementViews = sr.elements.map((el) => {
      const status = el.ok ? "✅" : "❌";
      return d`  ${status} ${el.name}\n`;
    });
    return d`${elementViews}`;
  }

  return undefined;
}

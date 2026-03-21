import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CompactionRecord,
  type CompletedToolInfo,
  type ContextManager,
  renderThreadToMarkdown,
  type ThreadMode,
  type ToolRequestId,
} from "@magenta/core";
import {
  type ContextViewContext,
  contextView,
  renderContextUpdate,
} from "../context/context-manager.ts";
import type {
  AgentStatus,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolResult,
  StopReason,
  Usage,
} from "../providers/provider.ts";
import type { SystemPrompt } from "../providers/system-prompt.ts";
import {
  renderCompletedToolDetail,
  renderCompletedToolPreview,
  renderCompletedToolSummary,
  renderInFlightToolDetail,
  renderInFlightToolPreview,
  renderInFlightToolSummary,
} from "../render-tools/index.ts";
import { renderStreamdedTool } from "../render-tools/streaming.ts";
import type { Dispatch } from "../tea/tea.ts";
import {
  d,
  type VDOMNode,
  type View,
  withBindings,
  withExtmark,
} from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Msg, Thread } from "./thread.ts";

function contextViewCtx(thread: Thread): ContextViewContext {
  return {
    cwd: thread.context.cwd,
    homeDir: thread.context.homeDir,
    nvim: thread.context.nvim,
    options: thread.context.options,
  };
}

/**
 * Helper function to render the animation frame for in-progress operations
 */
const getAnimationFrame = (sendDate: Date): string => {
  const frameIndex =
    Math.floor((Date.now() - sendDate.getTime()) / 333) %
    MESSAGE_ANIMATION.length;

  return MESSAGE_ANIMATION[frameIndex];
};

/**
 * Helper function to render the status message
 * Composes agent status with thread mode for complete display
 */
const renderStatus = (
  agentStatus: AgentStatus,
  mode: ThreadMode,
  latestUsage: Usage | undefined,
): VDOMNode => {
  const yieldedResponse = mode.type === "yielded" ? mode.response : undefined;
  // First check mode for thread-specific states
  if (mode.type === "tool_use") {
    return d`Executing tools...`;
  }
  if (yieldedResponse !== undefined) {
    return d`↗️ yielded to parent: ${yieldedResponse}`;
  }
  if (mode.type === "compacting") {
    return d`📦 Compacting thread...`;
  }

  // Then render based on agent status
  switch (agentStatus.type) {
    case "streaming":
      return d`Streaming response ${getAnimationFrame(agentStatus.startTime)}`;
    case "stopped":
      return renderStopReason(agentStatus.stopReason, latestUsage);
    case "error":
      return d`Error ${agentStatus.error.message}${
        agentStatus.error.stack ? `\n${agentStatus.error.stack}` : ""
      }`;
    default:
      assertUnreachable(agentStatus);
  }
};

function renderStopReason(
  stopReason: StopReason,
  usage: Usage | undefined,
): VDOMNode {
  const usageView = usage ? d` ${renderUsage(usage)}` : d``;
  if (stopReason === "aborted") {
    return d`[ABORTED] ${usageView} `;
  }
  return d`Stopped (${stopReason}) ${usageView} `;
}

function renderUsage(usage: Usage): VDOMNode {
  return d`[input: ${usage.inputTokens.toString()}, output: ${usage.outputTokens.toString()}${
    usage.cacheHits !== undefined
      ? d`, cache hits: ${usage.cacheHits.toString()}`
      : ""
  }${
    usage.cacheMisses !== undefined
      ? d`, cache misses: ${usage.cacheMisses.toString()}`
      : ""
  }]`;
}

/**
 * Helper function to determine if context manager view should be shown
 */
const shouldShowContextManager = (
  agentStatus: AgentStatus,
  mode: ThreadMode,
  contextManager: ContextManager,
): boolean => {
  return (
    agentStatus.type === "stopped" &&
    agentStatus.stopReason !== "tool_use" &&
    mode.type === "normal" &&
    !contextManager.isContextEmpty()
  );
};

/**
 * Helper function to render the system prompt in collapsed/expanded state
 */
const renderSystemPrompt = (
  systemPrompt: SystemPrompt,
  showSystemPrompt: boolean,
  dispatch: Dispatch<Msg>,
): VDOMNode => {
  if (showSystemPrompt) {
    return withBindings(
      withExtmark(d`⚙️ [System Prompt]\n${systemPrompt}`, {
        hl_group: "@comment",
      }),
      {
        "<CR>": () => {
          dispatch({ type: "toggle-system-prompt" });
        },
      },
    );
  } else {
    const estimatedTokens = Math.round(systemPrompt.length / 4 / 1000) * 1000;
    const tokenDisplay =
      estimatedTokens >= 1000
        ? `~${(estimatedTokens / 1000).toString()}K`
        : `~${estimatedTokens.toString()}`;

    return withBindings(
      withExtmark(d`⚙️ [System Prompt ${tokenDisplay}]`, {
        hl_group: "@comment",
      }),
      {
        "<CR>": () => {
          dispatch({ type: "toggle-system-prompt" });
        },
      },
    );
  }
};

function renderCompactionHistory(
  history: CompactionRecord[],
  viewState: Thread["state"]["compactionViewState"],
  dispatch: Dispatch<Msg>,
): VDOMNode {
  if (history.length === 0) return d``;

  return d`${history.map((record, recordIdx) => {
    const rv = viewState[recordIdx];
    const isExpanded = rv?.expanded || false;
    const summaryLen = record.finalSummary?.length ?? 0;
    const status =
      record.finalSummary !== undefined
        ? `summary: ${summaryLen} chars`
        : "⚠️ failed";

    const header = withBindings(
      withExtmark(
        d`📦 [Compaction ${(recordIdx + 1).toString()} — ${record.steps.length.toString()} step${record.steps.length === 1 ? "" : "s"}, ${status}]\n`,
        { hl_group: "@comment" },
      ),
      {
        "<CR>": () => dispatch({ type: "toggle-compaction-record", recordIdx }),
      },
    );

    if (!isExpanded) return header;

    const stepsView = record.steps.map((step, stepIdx) => {
      const stepExpanded = rv?.expandedSteps[stepIdx] || false;
      const stepHeader = withBindings(
        withExtmark(
          d`  📄 [Step ${(step.chunkIndex + 1).toString()} of ${step.totalChunks.toString()}]\n`,
          { hl_group: "@comment" },
        ),
        {
          "<CR>": () =>
            dispatch({
              type: "toggle-compaction-step",
              recordIdx,
              stepIdx,
            }),
        },
      );

      if (!stepExpanded) return stepHeader;

      const { markdown } = renderThreadToMarkdown(step.messages);
      return d`${stepHeader}${withExtmark(d`${markdown}\n`, { hl_group: "@comment" })}`;
    });

    const summaryView =
      record.finalSummary !== undefined
        ? d`  📋 Final Summary:\n${withExtmark(d`${record.finalSummary}\n`, { hl_group: "@comment" })}`
        : d`  ⚠️ Compaction failed — no summary produced\n`;

    return d`${header}${stepsView}${summaryView}`;
  })}`;
}
export const view: View<{
  thread: Thread;
  dispatch: Dispatch<Msg>;
}> = ({ thread, dispatch }) => {
  const threadType = thread.core.state.threadType;
  const titlePrefix =
    threadType === "docker_root"
      ? "🐳 "
      : threadType === "conductor"
        ? "🎼 "
        : "";
  const titleView = thread.core.state.title
    ? d`# ${titlePrefix}${thread.core.state.title}`
    : d`# ${titlePrefix}[ Untitled ]`;

  const systemPromptView = renderSystemPrompt(
    thread.core.state.systemPrompt,
    thread.state.showSystemPrompt,
    dispatch,
  );

  const messages = thread.getProviderMessages();
  const agentStatus = thread.agent.getState().status;
  const mode = thread.core.state.mode;

  // Show logo when empty and not busy
  const isIdle =
    agentStatus.type === "stopped" && agentStatus.stopReason === "end_turn";
  if (messages.length === 0 && isIdle && mode.type === "normal") {
    return d`\
${titleView}
${systemPromptView}

${LOGO}

magenta is for agentic flow

${contextView(thread.contextManager, contextViewCtx(thread))}`;
  }

  const latestUsage = thread.agent.getState().latestUsage;
  const statusView = renderStatus(agentStatus, mode, latestUsage);

  const contextManagerView = shouldShowContextManager(
    agentStatus,
    mode,
    thread.contextManager,
  )
    ? d`\n${contextView(thread.contextManager, contextViewCtx(thread))}`
    : d``;

  const filePermissionView =
    thread.permissionFileIO &&
    thread.permissionFileIO.getPendingPermissions().size > 0
      ? d`\n${thread.permissionFileIO.view()}`
      : d``;
  const shellPermissionView =
    thread.permissionShell &&
    thread.permissionShell.getPendingPermissions().size > 0
      ? d`\n${thread.permissionShell.view()}`
      : d``;
  const permissionView = d`${filePermissionView}${shellPermissionView}`;
  const compactionHistoryView = renderCompactionHistory(
    thread.core.state.compactionHistory,
    thread.state.compactionViewState,
    dispatch,
  );
  const pendingMessagesView =
    thread.core.state.pendingMessages.length > 0
      ? d`\n✉️  ${thread.core.state.pendingMessages.length.toString()} pending message${thread.core.state.pendingMessages.length === 1 ? "" : "s"}`
      : d``;

  // Helper to check if a message is a tool-result-only user message
  const isToolResultOnlyMessage = (msg: ProviderMessage): boolean =>
    msg.role === "user" &&
    msg.content.every(
      (c) => c.type === "tool_result" || c.type === "system_reminder",
    );

  // Render messages from provider thread
  const messagesView = messages.map((message, messageIdx) => {
    // Skip user messages that only contain tool results (no system_reminder)
    if (
      message.role === "user" &&
      message.content.every((c) => c.type === "tool_result")
    ) {
      return d``;
    }

    // For user messages with only tool_result and system_reminder,
    // skip the header but show the system reminder inline
    const isToolResultWithReminder =
      message.role === "user" &&
      message.content.every(
        (c) => c.type === "tool_result" || c.type === "system_reminder",
      ) &&
      message.content.some((c) => c.type === "system_reminder");

    // Skip "# assistant:" header if this is a continuation of a tool-use turn
    // (i.e., previous message was a tool-result-only user message)
    const prevMessage = messageIdx > 0 ? messages[messageIdx - 1] : undefined;
    const isAssistantContinuation =
      message.role === "assistant" &&
      prevMessage &&
      isToolResultOnlyMessage(prevMessage);

    const roleHeader =
      isToolResultWithReminder || isAssistantContinuation
        ? d``
        : withExtmark(d`# ${message.role}:\n`, {
            hl_group: "@markup.heading.1.markdown",
          });

    // Get view state for this message
    const viewState = thread.state.messageViewState[messageIdx];

    // Render context updates for user messages
    const contextUpdateView = viewState?.contextUpdates
      ? renderContextUpdate(
          viewState.contextUpdates,
          thread.contextManager,
          contextViewCtx(thread),
        )
      : d``;

    // Render content blocks
    const contentView = message.content.map((content, contentIdx) => {
      const isLastBlock = contentIdx === message.content.length - 1;
      return renderMessageContent(
        content,
        messageIdx,
        contentIdx,
        thread,
        dispatch,
        message.usage,
        isLastBlock,
      );
    });

    return d`\
${roleHeader}\
${contextUpdateView}\
${contentView}`;
  });

  const streamingBlockView =
    agentStatus.type === "streaming"
      ? d`\n${renderStreamingBlock(thread)}\n`
      : d``;

  return d`\
${titleView}
${systemPromptView}
${compactionHistoryView}
${messagesView}\
${streamingBlockView}\
${contextManagerView}\
${permissionView}\
${pendingMessagesView}
${statusView}`;
};

/** Render a single content block from a message */
function renderMessageContent(
  content: ProviderMessageContent,
  messageIdx: number,
  contentIdx: number,
  thread: Thread,
  dispatch: Dispatch<Msg>,
  messageUsage: Usage | undefined,
  isLastBlock: boolean,
): VDOMNode {
  switch (content.type) {
    case "text":
      return d`${content.text}\n`;

    case "thinking": {
      const viewState = thread.state.messageViewState[messageIdx];
      const isExpanded = viewState?.expandedContent?.[contentIdx] || false;

      if (isExpanded) {
        return withBindings(
          withExtmark(d`💭 [Thinking]\n${content.thinking}\n`, {
            hl_group: "@comment",
          }),
          {
            "<CR>": () => {
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              });
            },
          },
        );
      } else {
        return withBindings(
          withExtmark(d`💭 [Thinking]\n`, { hl_group: "@comment" }),
          {
            "<CR>": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          },
        );
      }
    }

    case "redacted_thinking":
      return withExtmark(d`💭 [Redacted Thinking]\n`, { hl_group: "@comment" });

    case "system_reminder": {
      const viewState = thread.state.messageViewState[messageIdx];
      const isExpanded = viewState?.expandedContent?.[contentIdx] || false;

      if (isExpanded) {
        return withBindings(
          withExtmark(d`📋 [System Reminder]\n${content.text}\n`, {
            hl_group: "@comment",
          }),
          {
            "<CR>": () => {
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              });
            },
          },
        );
      } else {
        // Render inline (no newline) so checkpoint can follow on same line
        return withBindings(
          withExtmark(d`📋 [System Reminder]\n`, { hl_group: "@comment" }),
          {
            "<CR>": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          },
        );
      }
    }

    case "tool_use": {
      if (content.request.status === "error") {
        return d`Malformed request: ${content.request.error}\n`;
      }

      const request = content.request.value;
      const toolViewState = thread.state.toolViewState[request.id];
      const showDetails = toolViewState?.details || false;

      // Show usage in details if this is the last block in the message
      const usageInDetails =
        showDetails && isLastBlock && messageUsage
          ? d`\n${renderUsage(messageUsage)}`
          : d``;

      // Check if tool is active (still running)
      const activeEntry =
        thread.core.state.mode.type === "tool_use" &&
        thread.core.state.mode.activeTools.get(request.id);

      if (activeEntry) {
        const displayContext = {
          cwd: thread.context.cwd,
          homeDir: thread.context.homeDir,
        };
        const renderContext = {
          getDisplayWidth: thread.context.getDisplayWidth,
          nvim: thread.context.nvim,
          cwd: thread.context.cwd,
          homeDir: thread.context.homeDir,
          options: thread.context.options,
          dispatch: thread.context.dispatch,
          chat: thread.context.chat,
        };

        const inFlightPreview = renderInFlightToolPreview(
          activeEntry.request,
          activeEntry.progress,
          renderContext,
        );

        return withBindings(
          d`${renderInFlightToolSummary(activeEntry.request, displayContext, activeEntry.progress)}${
            showDetails
              ? d`\n${renderInFlightToolDetail(activeEntry.request, activeEntry.progress, renderContext)}${usageInDetails}`
              : inFlightPreview
                ? d`\n${inFlightPreview}`
                : d``
          }\n`,
          {
            "<CR>": () =>
              dispatch({
                type: "toggle-tool-details",
                toolRequestId: request.id,
              }),
            t: () => activeEntry.handle.abort(),
          },
        );
      }

      // Completed tool - find the result and use tool-renderers
      const toolResult = findToolResult(thread, request.id);
      if (!toolResult) {
        return d`⚠️ tool result for ${request.id} not found\n`;
      }

      const resultInfo = thread.core.state.toolCache.resultInfos.get(
        request.id,
      );
      const completedInfo: CompletedToolInfo = {
        request: request,
        result: toolResult,
        ...(resultInfo ? { resultInfo } : {}),
      };

      const renderContext = {
        getDisplayWidth: thread.context.getDisplayWidth,
        nvim: thread.context.nvim,
        cwd: thread.context.cwd,
        homeDir: thread.context.homeDir,
        options: thread.context.options,
        dispatch: thread.context.dispatch,
      };

      // Get preview content to check if it's empty
      const previewContent = renderCompletedToolPreview(
        completedInfo,
        renderContext,
      );

      // Don't add trailing newline - let the message template handle it
      return withBindings(
        d`${renderCompletedToolSummary(completedInfo, thread.context.dispatch, renderContext, thread.context.chat)}${
          showDetails
            ? d`\n${renderCompletedToolDetail(completedInfo, renderContext)}${usageInDetails}`
            : previewContent
              ? d`\n${previewContent}`
              : d``
        }\n`,
        {
          "<CR>": () => {
            dispatch({
              type: "toggle-tool-details",
              toolRequestId: request.id,
            });
          },
        },
      );
    }

    case "tool_result":
      // Tool results are rendered with their corresponding tool_use
      return d``;

    case "image":
      return d`[Image]\n`;

    case "document":
      return d`[Document${content.title ? `: ${content.title}` : ""}]\n`;

    case "server_tool_use":
      return d`🔍 Searching ${withExtmark(d`${content.input.query}`, { hl_group: "@string" })}...\n`;

    case "web_search_tool_result": {
      const viewState = thread.state.messageViewState[messageIdx];
      const isExpanded = viewState?.expandedContent?.[contentIdx] || false;

      if (
        "type" in content.content &&
        content.content.type === "web_search_tool_result_error"
      ) {
        return d`🌐 Search error: ${withExtmark(d`${content.content.error_code}`, { hl_group: "ErrorMsg" })}\n`;
      }
      if (Array.isArray(content.content)) {
        const searchResults = content.content.filter(
          (
            r,
          ): r is Extract<
            (typeof content.content)[number],
            { type: "web_search_result" }
          > => r.type === "web_search_result",
        );
        if (isExpanded) {
          const results = searchResults.map(
            (r) =>
              d`  [${r.title}](${r.url})${r.page_age ? ` (${r.page_age})` : ""}\n`,
          );
          return withBindings(d`🌐 Search results\n${results}\n`, {
            "<CR>": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          });
        }
        return withBindings(
          d`🌐 ${searchResults.length.toString()} search result${searchResults.length === 1 ? "" : "s"}\n`,
          {
            "<CR>": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          },
        );
      }
      return d`🌐 Search results\n`;
    }

    case "context_update":
      // Context updates are rendered via thread.state.messageViewState
      return d``;

    default:
      return d`[Unknown content type]\n`;
  }
}

/** Find the tool result for a given tool request ID using the cached map */
export function findToolResult(
  thread: Thread,
  toolRequestId: ToolRequestId,
): ProviderToolResult | undefined {
  return thread.core.state.toolCache.results.get(toolRequestId);
}

function renderStreamingBlock(thread: Thread): string | VDOMNode {
  const state = thread.agent.getState();
  const block = state.streamingBlock;
  if (!block) return d``;

  switch (block.type) {
    case "text":
      return d`${block.text}`;
    case "thinking": {
      const lastLine = block.thinking.slice(
        block.thinking.lastIndexOf("\n") + 1,
      );
      return withExtmark(d`\n💭 [Thinking] ${lastLine}`, {
        hl_group: "@comment",
      });
    }
    case "tool_use": {
      return renderStreamdedTool(block);
    }
  }
}

export const LOGO = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "logo.txt"),
  "utf-8",
);

const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];

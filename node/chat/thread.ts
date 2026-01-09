import {
  ContextManager,
  type Msg as ContextManagerMsg,
  type FileUpdates,
} from "../context/context-manager.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import { displaySnapshotDiff } from "../tools/display-snapshot-diff.ts";
import { type Dispatch } from "../tea/tea.ts";
import {
  d,
  type View,
  type VDOMNode,
  withBindings,
  withExtmark,
} from "../tea/view.ts";
import {
  ToolManager,
  type Msg as ToolManagerMsg,
  type StaticToolRequest,
  type ToolRequestId,
} from "../tools/toolManager.ts";
import { MCPToolManager } from "../tools/mcp/manager.ts";
import { FileSnapshots } from "../tools/file-snapshots.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp } from "../lsp.ts";
import {
  getProvider as getProvider,
  type ProviderMessage,
  type ProviderMessageContent,
  type ProviderThread,
  type ProviderThreadAction,
  type ProviderThreadInput,
  type ProviderToolResult,
  type StopReason,
  type Usage,
} from "../providers/provider.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type MagentaOptions, type Profile } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import {
  relativePath,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import {
  type Input as ThreadTitleInput,
  spec as threadTitleToolSpec,
} from "../tools/thread-title.ts";

import type { Chat } from "./chat.ts";
import type { ThreadId, ThreadType } from "./types.ts";
import type { SystemPrompt } from "../providers/system-prompt.ts";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import player from "play-sound";
import { CommandRegistry } from "./commands/registry.ts";
import { getSubsequentReminder } from "../providers/system-reminders.ts";
import { readGitignoreSync, type Gitignore } from "../tools/util.ts";

export type StoppedConversationState = {
  state: "stopped";
  stopReason: StopReason;
};

export type ConversationState =
  | {
      state: "message-in-flight";
      sendDate: Date;
    }
  | StoppedConversationState
  | {
      state: "error";
      error: Error;
    }
  | {
      state: "yielded";
      response: string;
    };

export type InputMessage =
  | {
      type: "user";
      text: string;
    }
  | {
      type: "system";
      text: string;
    };

export type Msg =
  | { type: "set-title"; title: string }
  | { type: "update-profile"; profile: Profile }
  | {
      type: "send-message";
      messages: InputMessage[];
    }
  | {
      type: "abort";
    }
  | {
      type: "take-file-snapshot";
      unresolvedFilePath: UnresolvedFilePath;
    }
  | {
      type: "tool-manager-msg";
      msg: ToolManagerMsg;
    }
  | {
      type: "context-manager-msg";
      msg: ContextManagerMsg;
    }
  | {
      type: "toggle-system-prompt";
    }
  // View state messages
  | {
      type: "toggle-expand-content";
      messageIdx: number;
      contentIdx: number;
    }
  | {
      type: "toggle-expand-update";
      messageIdx: number;
      filePath: string;
    }
  | {
      type: "toggle-tool-details";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "open-edit-file";
      filePath: UnresolvedFilePath;
    }
  | {
      type: "diff-snapshot";
      filePath: string;
    }
  | {
      type: "provider-thread-action";
      action: ProviderThreadAction;
    };

export type ThreadMsg = {
  type: "thread-msg";
  id: ThreadId;
  msg: Msg;
};

/** View state for a single message, stored separately from provider thread content */
export type MessageViewState = {
  /** For user messages: context updates that were sent with this message */
  contextUpdates?: FileUpdates;
  /** Expansion state for context update entries */
  expandedUpdates?: { [absFilePath: string]: boolean };
  /** Expansion state for content blocks (e.g., thinking blocks) */
  expandedContent?: { [contentIdx: number]: boolean };
};

/** View state for tools, keyed by tool request ID */
export type ToolViewState = {
  details: boolean;
};

/** Edit tracking for files modified in this thread */
export type FileEditState = {
  requestIds: ToolRequestId[];
  status: { status: "pending" } | { status: "error"; message: string };
};

export class Thread {
  public state: {
    title?: string | undefined;
    profile: Profile;
    /** If the thread yielded to parent, stores the response */
    yieldedResponse?: string | undefined;
    threadType: ThreadType;
    systemPrompt: SystemPrompt;
    pendingMessages: InputMessage[];
    showSystemPrompt: boolean;
    /** View state per message, keyed by message index in providerThread */
    messageViewState: { [messageIdx: number]: MessageViewState };
    /** View state per tool, keyed by tool request ID */
    toolViewState: { [toolRequestId: ToolRequestId]: ToolViewState };
    /** File edit tracking, keyed by relative file path */
    edits: { [filePath: string]: FileEditState };
  };

  private myDispatch: Dispatch<Msg>;
  public toolManager: ToolManager;
  public fileSnapshots: FileSnapshots;
  public contextManager: ContextManager;
  public forkNextPrompt: string | undefined;
  private commandRegistry: CommandRegistry;
  public gitignore: Gitignore;
  public providerThread: ProviderThread;

  constructor(
    public id: ThreadId,
    threadType: ThreadType,
    systemPrompt: SystemPrompt,
    public context: {
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      mcpToolManager: MCPToolManager;
      bufferTracker: BufferTracker;
      profile: Profile;
      nvim: Nvim;
      cwd: NvimCwd;
      lsp: Lsp;
      contextManager: ContextManager;
      options: MagentaOptions;
      getDisplayWidth: () => number;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "thread-msg",
        id: this.id,
        msg,
      });

    this.gitignore = readGitignoreSync(this.context.cwd);
    this.toolManager = new ToolManager(
      (msg) =>
        this.myDispatch({
          type: "tool-manager-msg",
          msg,
        }),
      {
        ...this.context,
        threadId: this.id,
        gitignore: this.gitignore,
      },
    );

    this.fileSnapshots = new FileSnapshots(this.context.nvim, this.context.cwd);
    this.contextManager = this.context.contextManager;

    this.commandRegistry = new CommandRegistry();
    // Register custom commands from options
    if (this.context.options.customCommands) {
      for (const customCommand of this.context.options.customCommands) {
        this.commandRegistry.registerCustomCommand(customCommand);
      }
    }

    this.state = {
      profile: this.context.profile,
      threadType: threadType,
      systemPrompt: systemPrompt,
      pendingMessages: [],
      showSystemPrompt: false,
      messageViewState: {},
      toolViewState: {},
      edits: {},
    };

    const provider = getProvider(this.context.nvim, this.state.profile);
    this.providerThread = provider.createThread(
      {
        model: this.state.profile.model,
        systemPrompt: this.state.systemPrompt,
        tools: this.toolManager.getToolSpecs(this.state.threadType),
        ...(this.state.profile.thinking &&
          (this.state.profile.provider === "anthropic" ||
            this.state.profile.provider === "mock") && {
            thinking: this.state.profile.thinking,
          }),
        ...(this.state.profile.reasoning &&
          (this.state.profile.provider === "openai" ||
            this.state.profile.provider === "mock") && {
            reasoning: this.state.profile.reasoning,
          }),
      },
      (action) => {
        this.myDispatch({ type: "provider-thread-action", action });
      },
    );
  }

  /** Get conversation state derived from provider thread */
  getConversationState(): ConversationState {
    // Check for yielded state first
    if (this.state.yieldedResponse !== undefined) {
      return {
        state: "yielded",
        response: this.state.yieldedResponse,
      };
    }

    const status = this.providerThread.getState().status;
    switch (status.type) {
      case "idle":
        return {
          state: "stopped",
          stopReason: "end_turn",
        };
      case "streaming":
        return {
          state: "message-in-flight",
          sendDate: status.startTime,
        };
      case "stopped":
        return {
          state: "stopped",
          stopReason: status.stopReason,
        };
      case "error":
        return {
          state: "error",
          error: status.error,
        };
    }
  }

  /** Get messages from provider thread */
  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.providerThread?.getState().messages ?? [];
  }

  update(msg: RootMsg): void {
    if (msg.type == "thread-msg" && msg.id == this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "update-profile":
        this.state.profile = msg.profile;
        break;

      case "send-message": {
        const conversation = this.getConversationState();
        // Check if any message starts with @async
        const isAsync = msg.messages.some(
          (m) => m.type === "user" && m.text.trim().startsWith("@async"),
        );

        if (
          conversation.state == "message-in-flight" ||
          (conversation.state == "stopped" &&
            conversation.stopReason == "tool_use")
        ) {
          if (isAsync) {
            const processedMessages = msg.messages.map((m) => ({
              ...m,
              text:
                m.type === "user"
                  ? m.text.replace(/^\s*@async\s*/, "")
                  : m.text,
            }));
            this.state.pendingMessages.push(...processedMessages);
            break;
          } else {
            this.abortInProgressOperations();
          }
        }

        this.sendMessage(msg.messages).catch(
          this.handleSendMessageError.bind(this),
        );

        if (!this.state.title) {
          this.setThreadTitle(msg.messages.map((m) => m.text).join("\n")).catch(
            (err: Error) =>
              this.context.nvim.logger.error(
                "Error getting thread title: " + err.message + "\n" + err.stack,
              ),
          );
        }

        if (msg.messages.length) {
          setTimeout(() => {
            this.context.dispatch({
              type: "sidebar-msg",
              msg: {
                type: "scroll-to-last-user-message",
              },
            });
          }, 100);
        }
        break;
      }

      case "take-file-snapshot": {
        this.fileSnapshots
          .willEditFile(msg.unresolvedFilePath)
          .catch((e: Error) => {
            this.context.nvim.logger.error(
              `Failed to take file snapshot: ${e.message}`,
            );
          });
        return;
      }

      case "tool-manager-msg": {
        this.toolManager.update(msg.msg);
        this.maybeAutoRespond();
        return;
      }

      case "context-manager-msg": {
        this.contextManager.update(msg.msg);
        return;
      }

      case "abort": {
        this.abortInProgressOperations();
        return;
      }

      case "set-title": {
        this.state.title = msg.title;
        return;
      }

      case "toggle-system-prompt": {
        this.state.showSystemPrompt = !this.state.showSystemPrompt;
        return;
      }

      // View state messages
      case "toggle-expand-content": {
        const viewState = this.state.messageViewState[msg.messageIdx] || {};
        viewState.expandedContent = viewState.expandedContent || {};
        viewState.expandedContent[msg.contentIdx] =
          !viewState.expandedContent[msg.contentIdx];
        this.state.messageViewState[msg.messageIdx] = viewState;
        return;
      }

      case "toggle-expand-update": {
        const viewState = this.state.messageViewState[msg.messageIdx] || {};
        viewState.expandedUpdates = viewState.expandedUpdates || {};
        viewState.expandedUpdates[msg.filePath] =
          !viewState.expandedUpdates[msg.filePath];
        this.state.messageViewState[msg.messageIdx] = viewState;
        return;
      }

      case "toggle-tool-details": {
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          details: false,
        };
        toolState.details = !toolState.details;
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "open-edit-file": {
        openFileInNonMagentaWindow(msg.filePath, this.context).catch(
          (e: Error) => this.context.nvim.logger.error(e.message),
        );
        return;
      }

      case "diff-snapshot": {
        displaySnapshotDiff({
          unresolvedFilePath: msg.filePath as UnresolvedFilePath,
          nvim: this.context.nvim,
          cwd: this.context.cwd,
          fileSnapshots: this.fileSnapshots,
          getDisplayWidth: this.context.getDisplayWidth,
        }).catch((e: Error) => this.context.nvim.logger.error(e.message));
        return;
      }

      case "provider-thread-action": {
        this.handleProviderThreadAction(msg.action);
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  private handleProviderThreadAction(action: ProviderThreadAction): void {
    switch (action.type) {
      case "status-changed": {
        const status = action.status;
        switch (status.type) {
          case "idle":
          case "streaming":
            // Nothing to do - view reads from getConversationState()
            break;
          case "stopped":
            {
              const messages = this.getProviderMessages();
              const lastMessage = messages[messages.length - 1];

              // Check for yield_to_parent
              if (lastMessage?.role === "assistant") {
                const lastContentBlock =
                  lastMessage.content[lastMessage.content.length - 1];

                if (
                  lastContentBlock?.type === "tool_use" &&
                  lastContentBlock.request.status === "ok"
                ) {
                  const request = lastContentBlock.request.value;
                  if (request.toolName === "yield_to_parent") {
                    const yieldRequest = request as Extract<
                      StaticToolRequest,
                      { toolName: "yield_to_parent" }
                    >;
                    this.state.yieldedResponse = yieldRequest.input.result;
                  }
                }
              }

              const didAutoRespond = this.maybeAutoRespond();
              if (!didAutoRespond) {
                this.playChimeIfNeeded();
              }
            }
            break;
          case "error":
            this.handleErrorState(status.error);
            break;
        }
        break;
      }

      case "streaming-block-updated":
        // View reads streaming block directly from provider thread
        // No action needed here
        break;

      case "messages-updated": {
        // Initialize tools for new tool_use content blocks
        this.initializeNewTools();
        break;
      }
    }
  }

  private handleErrorState(error: Error): void {
    // On error, set up resubmit if we have a last user message
    const messages = this.getProviderMessages();
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "user") {
      const textContent = lastMessage.content
        .filter(
          (c): c is Extract<typeof c, { type: "text" }> => c.type === "text",
        )
        .map((c) => c.text)
        .join("");
      if (textContent) {
        setTimeout(
          () =>
            this.context.dispatch({
              type: "sidebar-msg",
              msg: {
                type: "setup-resubmit",
                lastUserMessage: textContent,
              },
            }),
          1,
        );
      }
    }
    this.context.nvim.logger.error(error);
  }

  /** Initialize tools for any new tool_use blocks in provider thread messages */
  private initializeNewTools(): void {
    const messages = this.providerThread.getState().messages;
    const lastMessage = messages[messages.length - 1];

    if (lastMessage?.role === "assistant") {
      for (const content of lastMessage.content) {
        if (content.type === "tool_use" && content.request.status === "ok") {
          const request = content.request.value;
          if (!this.toolManager.hasTool(request.id)) {
            this.toolManager.update({
              type: "init-tool-use",
              request,
              threadId: this.id,
            });

            // Track edits for insert/replace tools
            if (
              request.toolName === "insert" ||
              request.toolName === "replace"
            ) {
              const input = request.input as { filePath: string };
              const filePath = relativePath(
                this.context.cwd,
                input.filePath as UnresolvedFilePath,
              );

              if (!this.state.edits[filePath]) {
                this.state.edits[filePath] = {
                  status: { status: "pending" },
                  requestIds: [],
                };
              }
              this.state.edits[filePath].requestIds.push(request.id);
            }
          }
        }
      }
    }
  }

  private abortInProgressOperations(): void {
    // Abort provider thread if streaming
    this.providerThread.abort();

    // Abort any in-progress tools
    const messages = this.getProviderMessages();
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "assistant") {
      for (const content of lastMessage.content) {
        if (content.type === "tool_use" && content.request.status === "ok") {
          const tool = this.toolManager.getTool(content.request.value.id);
          if (tool && !tool.isDone()) {
            tool.abort();
          }
        }
      }
    }

    // no need to handle conversation stop, since ProviderThread.abort() will handle it for us.
  }

  maybeAutoRespond(): boolean {
    const conversation = this.getConversationState();
    if (
      conversation.state == "stopped" &&
      conversation.stopReason == "tool_use"
    ) {
      const messages = this.getProviderMessages();
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === "assistant") {
        // Collect completed tools and check for blocking ones
        const completedTools: Array<{
          id: ToolRequestId;
          result: ProviderToolResult;
        }> = [];

        for (const content of lastMessage.content) {
          if (content.type === "tool_use" && content.request.status === "ok") {
            const request = content.request.value;
            const tool = this.toolManager.getTool(request.id);

            if (tool.request.toolName === "yield_to_parent" || !tool.isDone()) {
              // terminate early if we have a blocking tool use
              return false;
            }

            // Collect completed tool result
            completedTools.push({
              id: request.id,
              result: {
                type: "tool_result",
                id: request.id,
                result: tool.getToolResult().result,
              },
            });
          }
        }

        // Send all tool results to the provider thread
        const pendingMessages = this.state.pendingMessages;
        this.state.pendingMessages = [];

        // Send tool results, then continue the conversation
        this.sendToolResultsAndContinue(completedTools, pendingMessages).catch(
          this.handleSendMessageError.bind(this),
        );
        return true;
      }
    } else if (
      conversation.state == "stopped" &&
      conversation.stopReason == "end_turn" &&
      this.state.pendingMessages.length
    ) {
      const pendingMessages = this.state.pendingMessages;
      this.state.pendingMessages = [];
      this.sendMessage(pendingMessages).catch(
        this.handleSendMessageError.bind(this),
      );
      return true;
    }
    return false;
  }

  private async sendToolResultsAndContinue(
    toolResults: Array<{ id: ToolRequestId; result: ProviderToolResult }>,
    pendingMessages: InputMessage[],
  ): Promise<void> {
    // Send all tool results to the provider thread (without triggering response yet)
    for (let i = 0; i < toolResults.length; i++) {
      const { id, result } = toolResults[i];
      const isLast = i === toolResults.length - 1;

      if (isLast && pendingMessages.length === 0) {
        // Last tool result with no pending messages - trigger response
        this.providerThread.toolResult(id, result, true);
      } else {
        // More results or pending messages to come
        this.providerThread.toolResult(id, result, false);
      }
    }

    // If there are pending messages, send them after tool results
    if (pendingMessages.length > 0) {
      await this.sendMessage(pendingMessages);
    }
  }

  private handleSendMessageError = (error: Error): void => {
    // Log the error - the provider thread will emit the error state
    this.context.nvim.logger.error(error);
  };

  private playChimeIfNeeded(): void {
    // Play chime when we need the user to do something:
    // 1. Agent stopped with end_turn (user needs to respond)
    // 2. We're blocked on a tool use that requires user action
    const conversation = this.getConversationState();
    if (conversation.state != "stopped") {
      return;
    }
    const stopReason = conversation.stopReason;
    if (stopReason === "end_turn") {
      this.playChimeSound();
      return;
    }

    if (stopReason === "tool_use") {
      const messages = this.getProviderMessages();
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === "assistant") {
        for (const content of lastMessage.content) {
          if (content.type === "tool_use" && content.request.status === "ok") {
            const request = content.request.value;
            const tool = this.toolManager.getTool(request.id);

            if (tool.isPendingUserAction()) {
              this.playChimeSound();
              return;
            }
          }
        }
      }
    }
  }

  private playChimeSound(): void {
    const actualVolume = this.context.options.chimeVolume;

    if (!actualVolume) {
      return;
    }

    try {
      const play = player();
      const chimeFile = join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "chime.wav",
      );

      // Play sound with volume control (platform-specific options)
      const playOptions = {
        // For macOS afplay: volume range is 0-1, where 1 is full volume
        afplay: ["-v", actualVolume.toString()],
        // For Linux aplay: volume range is 0-100%
        aplay: ["-v", Math.round(actualVolume * 100).toString() + "%"],
        // For mpg123: volume range is 0-32768
        mpg123: ["-f", Math.round(actualVolume * 32768).toString()],
      };

      play.play(chimeFile, playOptions, (err: Error | null) => {
        if (err) {
          this.context.nvim.logger.error(
            `Failed to play chime sound: ${err.message}`,
          );
        }
      });
    } catch (error) {
      this.context.nvim.logger.error(
        `Error setting up chime sound: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Prepare user message content for sending to provider thread */
  private async prepareUserContent(inputMessages?: InputMessage[]): Promise<{
    content: ProviderMessageContent[];
    contextUpdates: FileUpdates | undefined;
    hasContent: boolean;
  }> {
    // Process messages to handle @file commands
    const messageContent: ProviderMessageContent[] = [];

    for (const m of inputMessages || []) {
      if (m.type === "user") {
        const { processedText, additionalContent } =
          await this.commandRegistry.processMessage(m.text, {
            nvim: this.context.nvim,
            cwd: this.context.cwd,
            contextManager: this.contextManager,
            options: this.context.options,
          });

        messageContent.push({
          type: "text",
          text: processedText,
        });

        // Add any additional content from commands
        messageContent.push(...additionalContent);

        // Check for @fork command in user messages
        if (m.text.includes("@fork")) {
          const forkText = m.text.replace(/@fork\s*/g, "").trim();
          messageContent[messageContent.length - 1 - additionalContent.length] =
            {
              type: "text",
              text: `\
My next prompt will be:
${forkText}

Use the fork_thread tool to start a new thread for this prompt.

- Carefully analyze the prompt
- Identify key concepts, patterns, files and decisions that may be relevant
- Include higly relevant files as contextFiles
- Name less relevant files that may be useful in the summary, but leave them out of contextFiles.
- Summarize ONLY information that directly supports addressing the next prompt, especially previous user instructions and observations that cannot be directly observable in the codebase.
- Prefer including files in contextFiles to copying code from those files into the summary. Do not repeat anything in the summary that can be learned directly from contextFiles.

You must use the fork_thread tool immediately, with only the information you already have. Do not use any other tools.`,
            };
          this.forkNextPrompt = forkText;
        }
      } else {
        messageContent.push({
          type: "text",
          text: m.text,
        });
      }
    }

    // Get context updates after all @file commands have been processed
    const contextUpdates = await this.contextManager.getContextUpdate();

    // Add system reminder for user-submitted messages
    if (inputMessages?.length) {
      messageContent.push({
        type: "system_reminder",
        text: getSubsequentReminder(this.state.threadType),
      });
    }

    const hasContent =
      (inputMessages?.length ?? 0) > 0 ||
      Object.keys(contextUpdates).length > 0;

    return {
      content: messageContent,
      contextUpdates: Object.keys(contextUpdates).length
        ? contextUpdates
        : undefined,
      hasContent,
    };
  }

  async sendMessage(inputMessages?: InputMessage[]): Promise<void> {
    // Prepare user content
    const { content, contextUpdates, hasContent } =
      await this.prepareUserContent(inputMessages);

    if (!hasContent) {
      // No content to send - this shouldn't normally happen
      return;
    }

    // Start a new turn for file snapshots - all edits after this user message
    // will be grouped together
    this.fileSnapshots.startNewTurn();

    // Clear edits from previous turn
    this.state.edits = {};

    // Store context updates in view state for the new user message
    const currentMessageCount = this.getProviderMessages().length;
    if (contextUpdates) {
      this.state.messageViewState[currentMessageCount] = {
        contextUpdates,
      };
    }

    // Build content to send to provider thread
    // Include context as text content, then user content
    const contentToSend: ProviderThreadInput[] = [];

    // Add context updates as text
    if (contextUpdates) {
      const contextContent =
        this.contextManager.contextUpdatesToContent(contextUpdates);
      for (const c of contextContent) {
        if (c.type === "text") {
          contentToSend.push({ type: "text", text: c.text });
        }
      }
    }

    // Add user content (filter to input types only)
    for (const c of content) {
      if (c.type === "text") {
        contentToSend.push({ type: "text", text: c.text });
      } else if (c.type === "image") {
        contentToSend.push(c);
      } else if (c.type === "document") {
        contentToSend.push(c);
      } else if (c.type === "system_reminder") {
        // Convert system_reminder to text for the provider
        contentToSend.push({ type: "text", text: c.text });
      }
    }

    // Send to provider thread
    this.providerThread.appendUserMessage(contentToSend, true);
  }

  /** Get messages in provider format - delegates to provider thread */
  getMessages(): ProviderMessage[] {
    return [...this.getProviderMessages()];
  }

  async setThreadTitle(userMessage: string) {
    // Create a profile with reasoning/thinking disabled for fast model
    const profileForRequest: Profile = {
      ...this.context.profile,
      thinking: undefined,
      reasoning: undefined,
    };

    const request = getProvider(
      this.context.nvim,
      profileForRequest,
    ).forceToolUse({
      model: this.context.profile.fastModel,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `\
The user has provided the following prompt:
${userMessage}

Come up with a succinct thread title for this prompt. It should be less than 80 characters long.
`,
            },
          ],
        },
      ],
      spec: threadTitleToolSpec,
      systemPrompt: this.state.systemPrompt,
      disableCaching: true,
    });
    const result = await request.promise;
    if (result.toolRequest.status == "ok") {
      this.myDispatch({
        type: "set-title",
        title: (result.toolRequest.value.input as ThreadTitleInput).title,
      });
    }
  }

  getLastStopTokenCount(): number {
    const latestUsage = this.providerThread.getState().latestUsage;
    if (!latestUsage) {
      return 0;
    }
    return (
      latestUsage.inputTokens +
      latestUsage.outputTokens +
      (latestUsage.cacheHits || 0) +
      (latestUsage.cacheMisses || 0)
    );
  }
}

/**
 * Helper function to render the animation frame for in-progress operations
 */
const getAnimationFrame = (sendDate: Date): string => {
  const frameIndex =
    Math.floor((new Date().getTime() - sendDate.getTime()) / 333) %
    MESSAGE_ANIMATION.length;

  return MESSAGE_ANIMATION[frameIndex];
};

/**
 * Helper function to render the conversation state message
 */
const renderConversationState = (conversation: ConversationState): VDOMNode => {
  switch (conversation.state) {
    case "message-in-flight":
      return d`Streaming response ${getAnimationFrame(conversation.sendDate)}`;
    case "stopped":
      return renderStopReason(conversation.stopReason);
    case "yielded":
      return d`↗️ yielded to parent: ${conversation.response}`;
    case "error":
      return d`Error ${conversation.error.message}${
        conversation.error.stack ? "\n" + conversation.error.stack : ""
      }`;
    default:
      assertUnreachable(conversation);
  }
};

function renderStopReason(stopReason: StopReason): VDOMNode {
  if (stopReason === "aborted") {
    return d`[ABORTED]`;
  }
  return d`Stopped (${stopReason})`;
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
  conversation: ConversationState,
  contextManager: ContextManager,
): boolean => {
  return (
    conversation.state !== "message-in-flight" &&
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

export const view: View<{
  thread: Thread;
  dispatch: Dispatch<Msg>;
}> = ({ thread, dispatch }) => {
  const titleView = thread.state.title
    ? d`# ${thread.state.title}`
    : d`# [ Untitled ]`;

  const systemPromptView = renderSystemPrompt(
    thread.state.systemPrompt,
    thread.state.showSystemPrompt,
    dispatch,
  );

  const messages = thread.getProviderMessages();
  const conversation = thread.getConversationState();

  if (
    messages.length === 0 &&
    conversation.state === "stopped" &&
    conversation.stopReason === "end_turn"
  ) {
    return d`\
${titleView}
${systemPromptView}

${LOGO}

magenta is for agentic flow

${thread.context.contextManager.view()}`;
  }

  const conversationStateView = renderConversationState(conversation);

  const contextManagerView = shouldShowContextManager(
    conversation,
    thread.context.contextManager,
  )
    ? d`\n${thread.context.contextManager.view()}`
    : d``;

  const pendingMessagesView =
    thread.state.pendingMessages.length > 0
      ? d`\n✉️  ${thread.state.pendingMessages.length.toString()} pending message${thread.state.pendingMessages.length === 1 ? "" : "s"}`
      : d``;

  // Render edit summary
  const editSummaryView = renderEditSummary(thread, dispatch);

  // Render messages from provider thread
  const messagesView = messages.map((message, messageIdx) => {
    const roleHeader = withExtmark(d`# ${message.role}:`, {
      hl_group: "@markup.heading.1.markdown",
    });

    // Get view state for this message
    const viewState = thread.state.messageViewState[messageIdx];

    // Render context updates for user messages
    const contextUpdateView = viewState?.contextUpdates
      ? thread.contextManager.renderContextUpdate(viewState.contextUpdates)
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

    // Render streaming block if this is the last message and we're streaming
    const streamingBlockView =
      messageIdx === messages.length - 1 &&
      conversation.state === "message-in-flight"
        ? renderStreamingBlock(thread)
        : d``;

    // Render usage at end of assistant messages
    const usageView =
      message.role === "assistant" && message.usage
        ? d`${renderUsage(message.usage)}\n`
        : d``;

    return d`\
${roleHeader}
${contextUpdateView}${contentView}${streamingBlockView}${usageView}
`;
  });

  return d`\
${titleView}
${systemPromptView}

${messagesView}\
${editSummaryView}\
${contextManagerView}\
${pendingMessagesView}\
${conversationStateView}`;
};

/** Render the edit summary for files modified in the current assistant turn */
function renderEditSummary(thread: Thread, dispatch: Dispatch<Msg>): VDOMNode {
  const edits = thread.state.edits;
  const filePaths = Object.keys(edits);

  if (filePaths.length === 0) {
    return d``;
  }

  const editLines = filePaths.map((filePath) => {
    const editState = edits[filePath];
    const editCount = editState.requestIds.length;

    return withBindings(
      d`  \`${filePath}\` (${editCount.toString()} edits). [± diff snapshot]`,
      {
        "<CR>": () =>
          dispatch({
            type: "diff-snapshot",
            filePath,
          }),
      },
    );
  });

  return d`\nEdits:\n${editLines}\n`;
}

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
          withExtmark(d`💭 [Thinking]\n${content.thinking}`, {
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
          withExtmark(d`💭 [Thinking]`, { hl_group: "@comment" }),
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
          withExtmark(d`📋 [System Reminder]\n${content.text}`, {
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
          withExtmark(d`📋 [System Reminder]`, { hl_group: "@comment" }),
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
      const tool = thread.toolManager.getTool(request.id);
      if (!tool) {
        return d`⚠️ tool ${request.id} not found\n`;
      }

      const toolViewState = thread.state.toolViewState[request.id];
      const showDetails = toolViewState?.details || false;

      // Show usage in details if this is the last block in the message
      const usageInDetails =
        showDetails && isLastBlock && messageUsage
          ? d`\n${renderUsage(messageUsage)}`
          : d``;

      return withBindings(
        d`${tool.renderSummary()}${
          showDetails
            ? d`\n${tool.toolName}: ${tool.renderDetail ? tool.renderDetail() : JSON.stringify(tool.request.input, null, 2)}\n${tool.isDone() ? renderToolResult(tool) : ""}${usageInDetails}`
            : tool.renderPreview
              ? d`\n${tool.renderPreview()}`
              : ""
        }\n`,
        {
          "<CR>": () =>
            dispatch({
              type: "toggle-tool-details",
              toolRequestId: request.id,
            }),
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

    case "web_search_tool_result":
      if (
        "type" in content.content &&
        content.content.type === "web_search_tool_result_error"
      ) {
        return d`🌐 Search error: ${withExtmark(d`${content.content.error_code}`, { hl_group: "ErrorMsg" })}\n`;
      }
      // content.content is an array of web search results
      if (Array.isArray(content.content)) {
        const results = content.content
          .filter(
            (
              r,
            ): r is Extract<
              (typeof content.content)[number],
              { type: "web_search_result" }
            > => r.type === "web_search_result",
          )
          .map(
            (r) =>
              d`  [${r.title}](${r.url})${r.page_age ? ` (${r.page_age})` : ""}`,
          );
        return d`🌐 Search results\n${results}\n`;
      }
      return d`🌐 Search results\n`;

    default:
      return d`[Unknown content type]\n`;
  }
}

function renderToolResult(tool: ReturnType<ToolManager["getTool"]>): VDOMNode {
  if (!tool.isDone()) {
    return d``;
  }
  const result = tool.getToolResult();
  if (result.result.status === "error") {
    return d`error: ${result.result.error}`;
  }
  return d`result: ${result.result.value.map((v) => (v.type === "text" ? v.text : `[${v.type}]`)).join("\n")}`;
}

function renderStreamingBlock(thread: Thread): VDOMNode {
  const state = thread.providerThread.getState();
  const block = state.streamingBlock;
  if (!block) return d``;

  switch (block.type) {
    case "text":
      return d`${block.text}`;
    case "thinking": {
      const lastLine = block.thinking.slice(
        block.thinking.lastIndexOf("\n") + 1,
      );
      return withExtmark(d`💭 [Thinking] ${lastLine}`, {
        hl_group: "@comment",
      });
    }
    case "tool_use":
      return d`🔧 ${block.name}...`;
  }
}

export const LOGO = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "logo.txt"),
  "utf-8",
);

const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];

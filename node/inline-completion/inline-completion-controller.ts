import type { Nvim } from "../nvim/nvim-node";
import type { RootMsg } from "../root-msg";
import type { Dispatch } from "../tea/tea";
import type { InlineCompletionMsg, InlineCompletionState } from "./types";
import { getProvider } from "../providers/provider";
import { getActiveProfile, type MagentaOptions } from "../options";
import { assertUnreachable } from "../utils/assertUnreachable";
import type { Chat } from "../chat/chat";

export class InlineCompletionController {
  private state: Map<number, InlineCompletionState> = new Map();
  private myDispatch: Dispatch<InlineCompletionMsg>;

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      nvim: Nvim;
      options: MagentaOptions;
      chat: Chat;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "inline-completion-msg",
        msg,
      });
  }

  update(msg: RootMsg): void {
    if (msg.type === "inline-completion-msg") {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: InlineCompletionMsg): void {
    switch (msg.type) {
      case "trigger-completion":
        void this.triggerCompletion(msg.bufnr, msg.line, msg.col);
        return;
      case "accept-completion":
        void this.acceptCompletion(msg.bufnr);
        return;
      case "reject-completion":
        this.rejectCompletion(msg.bufnr);
        return;
      case "completion-received":
        void this.handleCompletionReceived(msg.bufnr, msg.completion);
        return;
      case "completion-error":
        this.handleCompletionError(msg.bufnr, msg.error);
        return;
      case "buffer-changed":
        this.handleBufferChanged(msg.bufnr, msg.line, msg.col, msg.text);
        return;
      case "cursor-moved":
        this.handleCursorMoved(msg.bufnr, msg.line, msg.col);
        return;
      default:
        assertUnreachable(msg);
    }
  }

  private async triggerCompletion(
    bufnr: number,
    line: number,
    col: number,
  ): Promise<void> {
    try {
      // Check if this buffer should have inline completion
      if (!(await this.shouldEnableCompletion(bufnr))) {
        return;
      }

      // Cancel any existing completion for this buffer
      this.cancelCompletion(bufnr);

      // Get buffer context
      const linesRes = await this.context.nvim.call("nvim_exec2", [
        `echo json_encode(getbufline(${bufnr}, ${Math.max(1, line - 20)}, ${line + 20}))`,
        { output: true },
      ]);
      const currentLineRes = await this.context.nvim.call("nvim_exec2", [
        `echo json_encode(getbufline(${bufnr}, ${line}, ${line}))`,
        { output: true },
      ]);

      const lines = JSON.parse(linesRes.output as string) as string[];
      const currentLine = JSON.parse(
        currentLineRes.output as string,
      ) as string[];

      if (
        !Array.isArray(lines) ||
        !Array.isArray(currentLine) ||
        currentLine.length === 0
      ) {
        return;
      }

      const context = lines.join("\n");
      const prefix = (currentLine[0] || "").substring(0, col);
      const suffix = (currentLine[0] || "").substring(col);

      // Get magenta context
      const magentaContext = this.getMagentaContext();

      // Check cache first (including magenta context in cache key)
      const cacheKey = this.getCacheKey(
        bufnr,
        line,
        col,
        prefix,
        suffix,
        magentaContext,
      );
      const cached = this.getCachedCompletion(bufnr, cacheKey);
      if (cached) {
        this.myDispatch({
          type: "completion-received",
          bufnr,
          completion: cached,
        });
        return;
      }

      // Get active profile and provider
      const activeProfile = getActiveProfile(
        this.context.options.profiles,
        this.context.options.activeProfile,
      );
      if (!activeProfile) {
        this.myDispatch({
          type: "completion-error",
          bufnr,
          error: "No active profile configured",
        });
        return;
      }

      const provider = getProvider(this.context.nvim, activeProfile);

      // Get file extension for language detection
      const filenameRes = await this.context.nvim.call("nvim_exec2", [
        `echo json_encode(fnamemodify(bufname(${bufnr}), ':t'))`,
        { output: true },
      ]);
      const filename =
        (JSON.parse(filenameRes.output as string) as string) || "";
      const language = this.detectLanguage(filename);

      // Create improved completion prompt
      const prompt = this.createCompletionPrompt(
        context,
        prefix,
        suffix,
        language,
        filename,
        magentaContext,
      );

      // Initialize state for accumulating text
      const state: InlineCompletionState = {
        request: { cancel: () => request.abort() },
        accumulatedText: "",
      };
      this.state.set(bufnr, state);

      // Start completion request
      const request = provider.sendMessage({
        model: activeProfile.fastModel || activeProfile.model,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
        ],
        onStreamEvent: (event) => {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            const currentState = this.state.get(bufnr);
            if (currentState) {
              currentState.accumulatedText =
                (currentState.accumulatedText || "") + event.delta.text;
            }
          }
        },
        tools: [],
      });

      // Wait for completion
      await request.promise;

      // Get the final accumulated text
      const finalState = this.state.get(bufnr);
      const completion = finalState?.accumulatedText?.trim();

      if (completion) {
        // Cache the result
        this.cacheCompletion(bufnr, cacheKey, completion, context);

        this.myDispatch({
          type: "completion-received",
          bufnr,
          completion,
        });
      } else {
        this.myDispatch({
          type: "completion-error",
          bufnr,
          error: "No completion text received",
        });
      }
    } catch (error) {
      // Handle different types of errors gracefully
      let errorMessage = "Unknown error";
      let shouldLog = true;

      if (error instanceof Error) {
        if (
          error.message.includes("aborted") ||
          error.message.includes("cancelled")
        ) {
          // Request was cancelled, don't show error to user
          void this.cleanupCompletion(bufnr);
          return;
        } else if (
          error.message.includes("network") ||
          error.message.includes("fetch")
        ) {
          errorMessage = "Network error - please check your connection";
        } else if (
          error.message.includes("API key") ||
          error.message.includes("authentication")
        ) {
          errorMessage = "Authentication error - please check your API key";
        } else if (error.message.includes("rate limit")) {
          errorMessage = "Rate limit exceeded - please try again later";
          shouldLog = false; // Don't spam logs with rate limit errors
        } else {
          errorMessage = error.message;
        }
      }

      if (shouldLog) {
        this.context.nvim.logger.error("Inline completion error:", error);
      }

      this.myDispatch({
        type: "completion-error",
        bufnr,
        error: errorMessage,
      });
    }
  }

  private async shouldEnableCompletion(bufnr: number): Promise<boolean> {
    try {
      // Check basic buffer properties
      const buftypeRes = await this.context.nvim.call("nvim_exec2", [
        `echo json_encode(getbufvar(${bufnr}, '&buftype'))`,
        { output: true },
      ]);
      const buftype = JSON.parse(buftypeRes.output as string) as string;

      const modifiableRes = await this.context.nvim.call("nvim_exec2", [
        `echo json_encode(getbufvar(${bufnr}, '&modifiable'))`,
        { output: true },
      ]);
      const modifiable = JSON.parse(modifiableRes.output as string) as boolean;

      // Don't enable completion in non-file buffers or non-modifiable buffers
      if (buftype !== "" || !modifiable) {
        return false;
      }

      // Check if this is a magenta display buffer (but allow input buffer)
      const windowsRes = await this.context.nvim.call("nvim_exec2", [
        `echo json_encode(win_findbuf(${bufnr}))`,
        { output: true },
      ]);
      const windows = JSON.parse(windowsRes.output as string) as number[];

      // Check each window that displays this buffer for magenta display window variable
      for (const winId of windows) {
        try {
          const magentaDisplayVarRes = await this.context.nvim.call(
            "nvim_exec2",
            [
              `echo json_encode(getwinvar(${winId}, 'magenta_display_window', v:null))`,
              { output: true },
            ],
          );
          const magentaDisplayVar = JSON.parse(
            magentaDisplayVarRes.output as string,
          ) as boolean | null;

          if (magentaDisplayVar === true) {
            return false; // This is a magenta display buffer, don't enable completion
          }
        } catch {
          // Ignore errors when checking individual windows
          continue;
        }
      }

      return true;
    } catch (error) {
      this.context.nvim.logger.error(
        "Error checking buffer eligibility:",
        error,
      );
      return false;
    }
  }

  private async handleCompletionReceived(
    bufnr: number,
    completion: string,
  ): Promise<void> {
    try {
      const state = this.state.get(bufnr);
      if (!state) return;

      // Get current cursor position
      const cursorRes = await this.context.nvim.call("nvim_exec2", [
        'echo json_encode(getpos("."))',
        { output: true },
      ]);
      const cursor = JSON.parse(cursorRes.output as string) as number[];
      const line = cursor[1] - 1; // Convert to 0-based
      const col = cursor[2] - 1;

      // Create virtual text for the suggestion with syntax highlighting
      const highlightGroup = await this.getCompletionHighlightGroup(bufnr);
      const extmarkId = await this.context.nvim.call("nvim_buf_set_extmark", [
        bufnr,
        await this.getOrCreateNamespace(),
        line,
        col,
        {
          virt_text: [[completion, highlightGroup]],
          virt_text_pos: "inline",
        },
      ]);

      // Update state with suggestion
      state.suggestion = {
        text: completion,
        line,
        col,
        extmarkId,
      };
      delete state.request;
    } catch (error) {
      this.context.nvim.logger.error("Error displaying completion:", error);
    }
  }

  private handleCompletionError(bufnr: number, error: string): void {
    // Only log errors that aren't user-facing (like network issues)
    if (!error.includes("Network error") && !error.includes("Rate limit")) {
      this.context.nvim.logger.error(
        `Inline completion error for buffer ${bufnr}:`,
        error,
      );
    }

    // For now, we silently fail inline completions to avoid disrupting the user's flow
    // In the future, we could show a subtle indicator in the status line
    void this.cleanupCompletion(bufnr);
  }

  private async acceptCompletion(bufnr: number): Promise<void> {
    try {
      const state = this.state.get(bufnr);
      if (!state?.suggestion) return;

      const { text, line, col } = state.suggestion;

      // Insert the completion text
      await this.context.nvim.call("nvim_buf_set_text", [
        bufnr,
        line,
        col,
        line,
        col,
        [text],
      ]);

      // Move cursor to end of inserted text
      const newCol = col + text.length;
      await this.context.nvim.call("nvim_exec2", [
        `call setpos(".", [0, ${line + 1}, ${newCol + 1}, 0])`,
        {},
      ]);

      void this.cleanupCompletion(bufnr);
    } catch (error) {
      this.context.nvim.logger.error("Error accepting completion:", error);
      void this.cleanupCompletion(bufnr);
    }
  }

  private rejectCompletion(bufnr: number): void {
    void this.cleanupCompletion(bufnr);
  }

  private cancelCompletion(bufnr: number): void {
    const state = this.state.get(bufnr);
    if (state?.request) {
      state.request.cancel();
    }
    if (state?.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    void this.cleanupCompletion(bufnr);
  }

  private async cleanupCompletion(bufnr: number): Promise<void> {
    const state = this.state.get(bufnr);
    if (state?.suggestion?.extmarkId !== undefined) {
      try {
        await this.context.nvim.call("nvim_buf_del_extmark", [
          bufnr,
          await this.getOrCreateNamespace(),
          state.suggestion.extmarkId,
        ]);
      } catch {
        // Ignore errors when cleaning up extmarks
      }
    }
    if (state?.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    this.state.delete(bufnr);
  }

  private async getOrCreateNamespace(): Promise<number> {
    return await this.context.nvim.call("nvim_create_namespace", [
      "magenta_inline_completion",
    ]);
  }
  private async getCompletionHighlightGroup(_bufnr: number): Promise<string> {
    try {
      // First, ensure our custom highlight group exists
      await this.context.nvim.call("nvim_exec2", [
        `
        if !exists('*hlget')
          " Fallback for older Neovim versions
          highlight default MagentaInlineCompletion ctermfg=8 guifg=#888888 gui=italic cterm=italic
        else
          " Check if highlight group already exists
          if empty(hlget('MagentaInlineCompletion'))
            highlight default MagentaInlineCompletion ctermfg=8 guifg=#888888 gui=italic cterm=italic
          endif
        endif
        `,
        {},
      ]);

      return "MagentaInlineCompletion";
    } catch (error) {
      this.context.nvim.logger.error(
        "Error setting up completion highlight group:",
        error,
      );
      // Fallback to a standard highlight group
      return "Comment";
    }
  }
  private getCacheKey(
    bufnr: number,
    line: number,
    col: number,
    prefix: string,
    suffix: string,
    magentaContext?: string,
  ): string {
    // Create a short hash of magenta context to keep cache key manageable
    const contextHash = magentaContext
      ? Buffer.from(magentaContext).toString("base64").substring(0, 8)
      : "none";
    return `${bufnr}:${line}:${col}:${prefix}:${suffix}:${contextHash}`;
  }

  private getCachedCompletion(
    bufnr: number,
    cacheKey: string,
  ): string | undefined {
    const state = this.state.get(bufnr);
    if (!state?.cache) return undefined;

    const entry = state.cache.get(cacheKey);
    if (!entry) return undefined;

    // Cache entries expire after 5 minutes
    const CACHE_EXPIRY_MS = 5 * 60 * 1000;
    if (Date.now() - entry.timestamp > CACHE_EXPIRY_MS) {
      state.cache.delete(cacheKey);
      return undefined;
    }

    return entry.completion;
  }

  private cacheCompletion(
    bufnr: number,
    cacheKey: string,
    completion: string,
    context: string,
  ): void {
    let state = this.state.get(bufnr);
    if (!state) {
      state = {};
      this.state.set(bufnr, state);
    }

    if (!state.cache) {
      state.cache = new Map();
    }

    // Limit cache size per buffer to prevent memory leaks
    const MAX_CACHE_SIZE = 50;
    if (state.cache.size >= MAX_CACHE_SIZE) {
      // Remove oldest entry
      const firstKey = state.cache.keys().next().value;
      if (firstKey) {
        state.cache.delete(firstKey);
      }
    }

    state.cache.set(cacheKey, {
      completion,
      timestamp: Date.now(),
      context,
    });
  }

  public async triggerManualCompletion(): Promise<void> {
    try {
      const bufnrRes = await this.context.nvim.call("nvim_exec2", [
        'echo bufnr("%")',
        { output: true },
      ]);
      const bufnr = parseInt(bufnrRes.output as string);

      const cursorRes = await this.context.nvim.call("nvim_exec2", [
        'echo json_encode(getpos("."))',
        { output: true },
      ]);
      const cursor = JSON.parse(cursorRes.output as string) as number[];
      const line = cursor[1];
      const col = cursor[2] - 1; // Convert to 0-based for our internal use

      this.myDispatch({
        type: "trigger-completion",
        bufnr,
        line,
        col,
      });
    } catch (error) {
      this.context.nvim.logger.error(
        "Error triggering manual completion:",
        error,
      );
    }
  }

  public async acceptCurrentCompletion(): Promise<void> {
    try {
      const bufnrRes = await this.context.nvim.call("nvim_exec2", [
        'echo bufnr("%")',
        { output: true },
      ]);
      const bufnr = parseInt(bufnrRes.output as string);

      this.myDispatch({
        type: "accept-completion",
        bufnr,
      });
    } catch (error) {
      this.context.nvim.logger.error("Error accepting completion:", error);
    }
  }

  public async rejectCurrentCompletion(): Promise<void> {
    try {
      const bufnrRes = await this.context.nvim.call("nvim_exec2", [
        'echo bufnr("%")',
        { output: true },
      ]);
      const bufnr = parseInt(bufnrRes.output as string);

      this.myDispatch({
        type: "reject-completion",
        bufnr,
      });
    } catch (error) {
      this.context.nvim.logger.error("Error rejecting completion:", error);
    }
  }

  private handleBufferChanged(
    bufnr: number,
    line: number,
    col: number,
    _text: string,
  ): void {
    if (!this.context.options.inlineCompletion?.autoTrigger) {
      return;
    }

    // Cancel any existing completion for this buffer
    this.cancelCompletion(bufnr);

    // Always schedule completion after any text change (with debouncing)
    this.scheduleCompletion(bufnr, line, col);
  }

  private handleCursorMoved(bufnr: number, line: number, col: number): void {
    const state = this.state.get(bufnr);
    if (!state) return;

    // If there's a suggestion and cursor moved away from it, clear it
    if (state.suggestion) {
      const { line: sugLine, col: sugCol } = state.suggestion;
      if (line !== sugLine || col < sugCol) {
        void this.cleanupCompletion(bufnr);
      }
    }
  }

  private shouldTriggerCompletion(text: string): boolean {
    // Trigger after typing a dot (for method calls, property access)
    if (text.endsWith(".")) {
      return true;
    }

    // Trigger after typing scope resolution operators
    if (text.endsWith("::")) {
      return true;
    }

    // Trigger after typing arrow operators
    if (text.endsWith("->") || text.endsWith("=>")) {
      return true;
    }

    // Trigger after opening brackets/parens (for function calls, array access)
    if (text.endsWith("(") || text.endsWith("[")) {
      return true;
    }

    // Trigger after typing import keywords
    const importKeywords = [
      "import ",
      "from ",
      "require(",
      "#include <",
      "use ",
    ];
    if (
      importKeywords.some((keyword) => text.toLowerCase().includes(keyword))
    ) {
      return true;
    }

    // Trigger after typing whitespace following certain keywords
    const completionKeywords = [
      "function ",
      "def ",
      "class ",
      "interface ",
      "type ",
      "const ",
      "let ",
      "var ",
      "if ",
      "for ",
      "while ",
      "switch ",
      "try ",
      "catch ",
      "return ",
      "yield ",
      "async ",
      "await ",
      "new ",
      "extends ",
      "implements ",
    ];

    return completionKeywords.some((keyword) => {
      const regex = new RegExp(keyword + "\\s*$", "i");
      return regex.test(text);
    });
  }

  private scheduleCompletion(bufnr: number, line: number, col: number): void {
    const state = this.state.get(bufnr) || {};

    // Clear existing timer
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    // Use shorter delay for certain trigger characters that expect immediate completion
    const getCurrentLineText = async (): Promise<string> => {
      try {
        const lineRes = await this.context.nvim.call("nvim_exec2", [
          `echo json_encode(getbufline(${bufnr}, ${line}, ${line}))`,
          { output: true },
        ]);
        const lineArray = JSON.parse(lineRes.output as string) as string[];
        return lineArray[0] || "";
      } catch {
        return "";
      }
    };

    void getCurrentLineText()
      .then((currentLineText) => {
        const prefix = currentLineText.substring(0, col);
        const isImmediateTrigger =
          prefix.endsWith(".") ||
          prefix.endsWith("::") ||
          prefix.endsWith("->") ||
          prefix.endsWith("=>") ||
          prefix.endsWith("(") ||
          prefix.endsWith("[");

        const delay = isImmediateTrigger
          ? 150
          : this.context.options.inlineCompletion.debounceMs;

        // Set up new timer with appropriate delay
        state.debounceTimer = setTimeout(() => {
          // Check if cursor is still at the same position
          this.getCurrentCursorPosition(bufnr)
            .then((currentPos) => {
              if (
                currentPos &&
                currentPos.line === line &&
                currentPos.col === col
              ) {
                this.myDispatch({
                  type: "trigger-completion",
                  bufnr,
                  line,
                  col,
                });
              }
            })
            .catch((error) => {
              this.context.nvim.logger.error(
                "Error checking cursor position:",
                error,
              );
            });
        }, delay);

        // Update state
        state.lastTriggerPosition = { line, col };
        this.state.set(bufnr, state);
      })
      .catch((error) => {
        this.context.nvim.logger.error(
          "Error getting current line text:",
          error,
        );
      });
  }

  private async getCurrentCursorPosition(
    bufnr: number,
  ): Promise<{ line: number; col: number } | null> {
    try {
      // Check if we're still in the same buffer
      const currentBufRes = await this.context.nvim.call("nvim_exec2", [
        'echo bufnr("%")',
        { output: true },
      ]);
      const currentBuf = parseInt(currentBufRes.output as string);

      if (currentBuf !== bufnr) {
        return null;
      }

      const cursorRes = await this.context.nvim.call("nvim_exec2", [
        'echo json_encode(getpos("."))',
        { output: true },
      ]);
      const cursor = JSON.parse(cursorRes.output as string) as number[];
      return {
        line: cursor[1],
        col: cursor[2] - 1, // Convert to 0-based
      };
    } catch {
      return null;
    }
  }

  public updateAutoTrigger(enabled: boolean): void {
    // Update the options
    this.context.options.inlineCompletion.autoTrigger = enabled;

    // If auto-trigger is being disabled, cancel all active completions
    if (!enabled) {
      for (const [bufnr] of this.state) {
        this.cancelCompletion(bufnr);
      }
    }
  }

  public destroy(): void {
    // Cancel all active requests and cleanup
    for (const [bufnr] of this.state) {
      this.cancelCompletion(bufnr);
    }
  }

  private detectLanguage(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase() || "";

    const languageMap: Record<string, string> = {
      js: "JavaScript",
      jsx: "JavaScript JSX",
      ts: "TypeScript",
      tsx: "TypeScript JSX",
      py: "Python",
      java: "Java",
      c: "C",
      cpp: "C++",
      cc: "C++",
      cxx: "C++",
      h: "C/C++ Header",
      hpp: "C++ Header",
      cs: "C#",
      php: "PHP",
      rb: "Ruby",
      go: "Go",
      rs: "Rust",
      swift: "Swift",
      kt: "Kotlin",
      scala: "Scala",
      sh: "Shell Script",
      bash: "Bash",
      zsh: "Zsh",
      fish: "Fish",
      ps1: "PowerShell",
      html: "HTML",
      xml: "XML",
      css: "CSS",
      scss: "SCSS",
      sass: "Sass",
      less: "Less",
      json: "JSON",
      yaml: "YAML",
      yml: "YAML",
      toml: "TOML",
      ini: "INI",
      sql: "SQL",
      md: "Markdown",
      tex: "LaTeX",
      vim: "Vim Script",
      lua: "Lua",
      r: "R",
      dart: "Dart",
      elm: "Elm",
      clj: "Clojure",
      ml: "OCaml",
      hs: "Haskell",
      erl: "Erlang",
      ex: "Elixir",
      exs: "Elixir",
    };

    return languageMap[ext] || "code";
  }

  private getMagentaContext(): string {
    try {
      const activeThread = this.context.chat.getActiveThread();
      if (!activeThread) {
        return "";
      }

      // Get thread title for high-level context
      const threadTitle = activeThread.state.title;

      // Get recent relevant messages (last 3 messages, excluding tool results)
      const messages = activeThread.getMessages();
      const recentMessages = messages
        .slice(-6) // Last 6 messages (3 user + 3 assistant pairs)
        .filter((msg) => {
          // Only include text content, exclude tool results and very short messages
          return msg.content.some(
            (content) =>
              content.type === "text" && content.text.trim().length > 10,
          );
        })
        .map((msg) => {
          const textContent = msg.content
            .filter((content) => content.type === "text")
            .map((content) => (content as { type: "text"; text: string }).text)
            .join(" ")
            .trim();

          // Truncate very long messages
          const truncated =
            textContent.length > 200
              ? textContent.substring(0, 197) + "..."
              : textContent;

          return `${msg.role}: ${truncated}`;
        });

      // Get context files summary (just file names and types, not full content)
      const contextFiles = Object.keys(activeThread.contextManager.files)
        .slice(0, 10) // Limit to prevent prompt bloat
        .map((filePath) => {
          const file =
            activeThread.contextManager.files[
              filePath as keyof typeof activeThread.contextManager.files
            ];
          return `- ${filePath} (${file.fileTypeInfo.category})`;
        });

      // Build compact context string
      let magentaContext = "";

      if (threadTitle) {
        magentaContext += `# Current Thread: ${threadTitle}\n\n`;
      }

      if (contextFiles.length > 0) {
        magentaContext += `# Context Files:\n${contextFiles.join("\n")}\n\n`;
      }

      if (recentMessages.length > 0) {
        magentaContext += `# Recent Discussion:\n${recentMessages.join("\n")}\n\n`;
      }

      return magentaContext.trim();
    } catch (error) {
      // Graceful degradation - don't break completion if magenta context fails
      this.context.nvim.logger.warn("Failed to get magenta context:", error);
      return "";
    }
  }

  private createCompletionPrompt(
    context: string,
    prefix: string,
    suffix: string,
    language: string,
    filename: string,
    magentaContext?: string,
  ): string {
    // Analyze the context to provide better completion hints
    const completionType = this.analyzeCompletionType(prefix, suffix, context);
    const indentation = this.detectIndentation(prefix);

    let prompt = `You are an expert ${language} programmer providing intelligent code completion.

File: ${filename}
Language: ${language}
Completion Type: ${completionType}`;

    // Add magenta context if available
    if (magentaContext && magentaContext.trim().length > 0) {
      prompt += `

## Project Context from Current Conversation:
${magentaContext}`;
    }

    prompt += `

Context (surrounding code):
\`\`\`${language.toLowerCase()}
${context}
\`\`\`

Current line with cursor position:
\`\`\`
${prefix}|${suffix}
\`\`\`

Instructions:
- Provide ONLY the text that should be inserted at the cursor position (marked with |)
- Match the existing code style, indentation, and naming conventions
- Consider both the immediate code context and the broader project context
- Do not include explanations, comments, or surrounding code
- Maintain proper ${language} syntax and idioms`;

    // Add specific guidance based on completion type
    switch (completionType) {
      case "method_call":
        prompt +=
          "\n- Focus on completing method calls with appropriate parameters";
        break;
      case "property_access":
        prompt += "\n- Focus on completing property names or method calls";
        break;
      case "function_definition":
        prompt +=
          "\n- Focus on completing function signatures and parameter lists";
        break;
      case "variable_assignment":
        prompt += "\n- Focus on completing variable names or expressions";
        break;
      case "import_statement":
        prompt += "\n- Focus on completing import paths and module names";
        break;
      case "control_flow":
        prompt +=
          "\n- Focus on completing control flow statements (if, for, while, etc.)";
        break;
      case "type_annotation":
        prompt +=
          "\n- Focus on completing type annotations and generic parameters";
        break;
    }

    if (indentation) {
      prompt += `\n- Use "${indentation}" for indentation to match existing code`;
    }

    return prompt;
  }

  private analyzeCompletionType(
    prefix: string,
    _suffix: string,
    _context: string,
  ): string {
    const trimmedPrefix = prefix.trim();

    // Check for common patterns
    if (trimmedPrefix.endsWith(".")) {
      return "property_access";
    }
    if (trimmedPrefix.includes("(") && !trimmedPrefix.includes(")")) {
      return "method_call";
    }
    if (trimmedPrefix.match(/^\s*(function|def|fn|func)\s+\w*$/)) {
      return "function_definition";
    }
    if (trimmedPrefix.match(/^\s*(const|let|var|=)\s+\w*$/)) {
      return "variable_assignment";
    }
    if (trimmedPrefix.match(/^\s*(import|from|require)\s+/)) {
      return "import_statement";
    }
    if (trimmedPrefix.match(/^\s*(if|for|while|switch|try|catch)\s*\(?$/)) {
      return "control_flow";
    }
    if (trimmedPrefix.includes(":") && !trimmedPrefix.includes("::")) {
      return "type_annotation";
    }

    return "general";
  }

  private detectIndentation(prefix: string): string {
    const match = prefix.match(/^(\s+)/);
    if (!match) return "";

    const whitespace = match[1];
    if (whitespace.includes("\t")) {
      return "tab";
    } else {
      return `${whitespace.length} spaces`;
    }
  }
}

import type { Result } from "../utils/result.ts";
import type { Dispatch, Thunk } from "../tea/tea.ts";
import type { ProviderToolResultContent } from "../providers/provider.ts";
import { d, withBindings } from "../tea/view.ts";
import type { ToolRequest } from "./toolManager.ts";
import type { Nvim } from "nvim-node";
import { spawn } from "child_process";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { CommandAllowlist, MagentaOptions } from "../options.ts";

export const spec = {
  name: "bash_command",
  description: `Run a command in a bash shell.
You will get the stdout and stderr of the command, as well as the exit code.
For example, you can run \`ls\`, \`echo 'Hello, World!'\`, or \`git status\`.
The command will time out after 1 min.
You should not run commands that require user input, such as \`git commit\` without \`-m\` or \`ssh\`.
You should not run commands that do not halt, such as \`docker compose up\` without \`-d\`, \`tail -f\` or \`watch\`.
`,

  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run in the terminal",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export type Input = {
  command: string;
};

type OutputLine = {
  stream: "stdout" | "stderr";
  text: string;
};

type State =
  | {
      state: "processing";
      output: OutputLine[];
      startTime: number;
      approved: boolean;
      childProcess: ReturnType<typeof spawn> | null;
    }
  | {
      state: "pending-user-action";
    }
  | {
      state: "done";
      output: OutputLine[];
      exitCode: number | undefined;
      result: ProviderToolResultContent;
    }
  | {
      state: "error";
      error: string;
    };

export type Msg =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; error: string }
  | { type: "request-user-approval" }
  | { type: "user-approval"; approved: boolean; remember?: boolean }
  | { type: "terminate" };

export function validateInput(args: { [key: string]: unknown }): Result<Input> {
  if (typeof args.command !== "string") {
    return {
      status: "error",
      error: `Expected command to be a string but got ${typeof args.command}`,
    };
  }

  return {
    status: "ok",
    value: {
      command: args.command,
    },
  };
}

export function isCommandAllowed(
  command: string,
  allowlist: CommandAllowlist,
  rememberedCommands?: Set<string>,
): boolean {
  if (rememberedCommands && rememberedCommands.has(command)) {
    return true;
  }

  if (!command || !allowlist || !Array.isArray(allowlist)) {
    return false;
  }

  // Clean the command string to avoid any tricks
  const cleanCommand = command.trim();
  if (!cleanCommand) {
    return false;
  }

  // Check each regex pattern until we find a match
  for (const pattern of allowlist) {
    try {
      const regex = new RegExp(pattern);
      if (regex.test(cleanCommand)) {
        return true;
      }
    } catch (error) {
      // Skip invalid regex patterns
      console.error(`Invalid regex pattern: ${pattern}`, error);
      continue;
    }
  }

  return false;
}

export class BashCommandTool {
  state: State;
  toolName = "bash_command" as const;

  private constructor(
    public request: Extract<ToolRequest, { toolName: "bash_command" }>,
    public context: {
      nvim: Nvim;
      options: MagentaOptions;
      rememberedCommands: Set<string>;
    },
  ) {
    const commandAllowlist = this.context.options.commandAllowlist;
    const isAllowed = isCommandAllowed(
      request.input.command,
      commandAllowlist,
      this.context.rememberedCommands,
    );

    if (isAllowed) {
      this.state = {
        state: "processing",
        output: [],
        startTime: Date.now(),
        approved: true,
        childProcess: null,
      };
    } else {
      this.state = {
        state: "pending-user-action",
      };
    }
  }

  static create(
    request: Extract<ToolRequest, { toolName: "bash_command" }>,
    context: {
      nvim: Nvim;
      options: MagentaOptions;
      rememberedCommands: Set<string>;
    },
  ): [BashCommandTool, Thunk<Msg>] {
    const tool = new BashCommandTool(request, context);
    return [tool, tool.executeCommand()];
  }

  update(msg: Msg): Thunk<Msg> | undefined {
    if (this.state.state === "done" || this.state.state === "error") {
      return;
    }

    switch (msg.type) {
      case "request-user-approval": {
        if (this.state.state !== "pending-user-action") {
          return;
        }
        return;
      }

      case "user-approval": {
        if (this.state.state !== "pending-user-action") {
          return;
        }

        if (msg.approved) {
          this.state = {
            state: "processing",
            output: [],
            startTime: Date.now(),
            approved: true,
            childProcess: null,
          };
          return this.executeCommand();
        } else {
          this.state = {
            state: "done",
            exitCode: 1,
            output: [],
            result: {
              type: "tool_result",
              id: this.request.id,
              result: {
                status: "error",
                error: `The user did not allow running this command.`,
              },
            },
          };
        }
        return;
      }

      case "stdout": {
        if (this.state.state !== "processing") {
          return;
        }

        // Trim line to 80 characters
        const trimmedText =
          msg.text.length > 80 ? msg.text.substring(0, 80) : msg.text;
        if (trimmedText.trim() !== "") {
          this.state.output.push({
            stream: "stdout",
            text: trimmedText,
          });
        }
        return;
      }

      case "stderr": {
        if (this.state.state !== "processing") {
          return;
        }

        // Trim line to 80 characters
        const trimmedText =
          msg.text.length > 80 ? msg.text.substring(0, 80) : msg.text;
        if (trimmedText.trim() !== "") {
          this.state.output.push({
            stream: "stderr",
            text: trimmedText,
          });
        }
        return;
      }

      case "exit": {
        if (this.state.state !== "processing") {
          return;
        }

        // Process the output array to format with stream markers
        const lastTenLines = this.state.output.slice(-10);
        let formattedOutput = "";
        let currentStream: "stdout" | "stderr" | null = null;

        for (const line of lastTenLines) {
          // Add stream marker only when switching or at the beginning
          if (currentStream !== line.stream) {
            formattedOutput +=
              line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
            currentStream = line.stream;
          }
          formattedOutput += line.text + "\n";
        }

        this.state = {
          state: "done",
          exitCode: msg.code ? msg.code : -1,
          output: this.state.output,
          result: {
            type: "tool_result",
            id: this.request.id,
            result: {
              status: "ok",
              value: formattedOutput,
            },
          },
        };
        return;
      }

      case "error": {
        this.state = {
          state: "error",
          error: msg.error,
        };
        return;
      }

      case "terminate": {
        if (this.state.state !== "processing") {
          return;
        }

        if (this.state.childProcess) {
          this.state.childProcess.kill("SIGTERM");
          this.state.output.push({
            stream: "stderr",
            text: "Process terminated by user with SIGTERM",
          });
        }
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  executeCommand(): Thunk<Msg> {
    return async (dispatch: Dispatch<Msg>) =>
      new Promise((resolve) => {
        const timeout = 300000; // 5 minute timeout
        const { command } = this.request.input;

        let timeoutId: NodeJS.Timeout | null = null;
        let childProcess: ReturnType<typeof spawn> | null = null;

        try {
          timeoutId = setTimeout(() => {
            if (childProcess) {
              childProcess.kill();
            }
            dispatch({
              type: "error",
              error: `Command timed out after ${timeout / 1000} seconds`,
            });
            resolve();
          }, timeout);

          childProcess = spawn("bash", ["-c", command], {
            stdio: "pipe",
          });

          if (this.state.state === "processing") {
            this.state.childProcess = childProcess;
          }

          childProcess.stdout?.on("data", (data: Buffer) => {
            const text = data.toString();
            const lines = text.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                dispatch({ type: "stdout", text: line });
              }
            }
          });

          childProcess.stderr?.on("data", (data: Buffer) => {
            const text = data.toString();
            const lines = text.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                dispatch({ type: "stderr", text: line });
              }
            }
          });

          childProcess.on("close", (code: number | null) => {
            if (timeoutId) clearTimeout(timeoutId);
            dispatch({ type: "exit", code });
            resolve();
          });
        } catch (error) {
          if (timeoutId) clearTimeout(timeoutId);
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          dispatch({
            type: "stderr",
            text: errorMessage,
          });
          dispatch({ type: "exit", code: 1 });
          resolve();
        }

        // Handle errors that might occur during process execution
        childProcess?.on("error", (error: Error) => {
          if (timeoutId) clearTimeout(timeoutId);
          dispatch({
            type: "stderr",
            text: error.message,
          });
          dispatch({ type: "exit", code: 1 });
        });
      });
  }

  // Helper function to format output with stream markers
  formatOutput(output: OutputLine[]): string {
    let formattedOutput = "";
    let currentStream: "stdout" | "stderr" | null = null;
    const lastTenLines = output.slice(-10);

    for (const line of lastTenLines) {
      // Add stream marker only when switching or at the beginning
      if (currentStream !== line.stream) {
        formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
        currentStream = line.stream;
      }
      formattedOutput += line.text + "\n";
    }

    return formattedOutput;
  }

  getToolResult(): ProviderToolResultContent {
    const { state } = this;

    switch (state.state) {
      case "done": {
        return state.result;
      }

      case "error":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "error",
            error: `Error: ${state.error}`,
          },
        };

      case "pending-user-action":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: `Waiting for user approval to run this command.`,
          },
        };

      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: "Command still running",
          },
        };

      default:
        assertUnreachable(state);
    }
  }

  view(dispatch: Dispatch<Msg>) {
    const { state } = this;

    if (state.state === "pending-user-action") {
      return d`⏳ May I run this command? \`${this.request.input.command}\`
${withBindings(d`**[ NO ]**`, {
  "<CR>": () => dispatch({ type: "user-approval", approved: false }),
})} ${withBindings(d`**[ YES ]**`, {
        "<CR>": () => dispatch({ type: "user-approval", approved: true }),
      })} ${withBindings(d`**[ ALWAYS ]**`, {
        "<CR>": () =>
          dispatch({ type: "user-approval", approved: true, remember: true }),
      })}`;
    }

    if (state.state === "processing") {
      const runningTime = Math.floor((Date.now() - state.startTime) / 1000);
      const formattedOutput = this.formatOutput(state.output);

      const content = d`⚡ (${String(runningTime)}s / 300s) \`${this.request.input.command}\`
\`\`\`
${formattedOutput}
\`\`\``;

      return withBindings(content, {
        t: () => dispatch({ type: "terminate" }),
      });
    }

    if (state.state === "done") {
      // Use the same formatting as in getToolResult
      const formattedOutput = this.formatOutput(state.output);

      return d`⚡ \`${this.request.input.command}\`
\`\`\`
${formattedOutput}
\`\`\`

Exit code: ${state.exitCode === null ? "null" : String(state.exitCode)}`;
    }

    if (state.state === "error") {
      return d`Error running command: ${state.error}`;
    }

    return d``;
  }

  displayInput(): string {
    return `bash_command: {
    command: ${this.request.input.command}
}`;
  }
}

import type { Result } from "../utils/result.ts";
import type { ProviderToolResultContent } from "../providers/provider.ts";
import { d, withBindings } from "../tea/view.ts";
import type { ToolRequest } from "./toolManager.ts";
import type { Thunk, Dispatch } from "../tea/tea.ts";
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

type State =
  | {
      state: "processing";
      stdout: string[];
      stderr: string[];
      startTime: number;
      approved: boolean;
      childProcess: ReturnType<typeof spawn> | null;
    }
  | {
      state: "pending-user-action";
    }
  | {
      state: "done";
      result: ProviderToolResultContent;
    }
  | {
      state: "error";
      error: string;
    };

export type Model = {
  type: "bash_command";
  request: ToolRequest<"bash_command">;
  state: State;
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

export function displayInput(input: Input): string {
  return `command: ${input.command}`;
}

function executeCommandThunk(model: Model): Thunk<Msg> {
  return (dispatch) => {
    return new Promise<void>((resolve) => {
      const timeout = 300000; // 5 minute timeout
      const { command } = model.request.input;

      let timeoutId: NodeJS.Timeout | null = null;
      let childProcess: ReturnType<typeof spawn> | null = null;

      try {
        // Set up timeout
        timeoutId = setTimeout(() => {
          if (childProcess) {
            childProcess.kill();
          }
          dispatch({
            type: "error",
            error: `Command timed out after ${timeout / 1000} seconds`,
          });
        }, timeout);

        childProcess = spawn("bash", ["-c", command], {
          stdio: "pipe",
        });

        // Store the child process in the model state
        if (model.state.state === "processing") {
          model.state.childProcess = childProcess;
        }

        // Set up stdout and stderr handlers
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
        resolve();
      });
    });
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

export function initModel(
  request: ToolRequest<"bash_command">,
  context: {
    nvim: Nvim;
    options: MagentaOptions;
    rememberedCommands: Set<string>;
  },
): [Model, Thunk<Msg>] {
  const model: Model = {
    type: "bash_command",
    request,
    state: {
      state: "pending-user-action",
    },
  };

  const commandAllowlist = context.options.commandAllowlist;

  const isAllowed = isCommandAllowed(
    request.input.command,
    commandAllowlist,
    context.rememberedCommands,
  );

  // If command is allowed, skip approval and execute immediately
  if (isAllowed) {
    const approvedModel: Model = {
      ...model,
      state: {
        state: "processing",
        stdout: [],
        stderr: [],
        startTime: Date.now(),
        approved: true,
        childProcess: null,
      },
    };
    return [approvedModel, executeCommandThunk(approvedModel)];
  }

  // Otherwise, request user approval as before
  const thunk: Thunk<Msg> = (dispatch) => {
    dispatch({ type: "request-user-approval" });
    return Promise.resolve();
  };

  return [model, thunk];
}

export function update(
  msg: Msg,
  model: Model,
): [Model, Thunk<Msg> | undefined] {
  if (model.state.state === "done" || model.state.state === "error") {
    return [model, undefined];
  }

  switch (msg.type) {
    case "request-user-approval": {
      if (model.state.state !== "pending-user-action") {
        return [model, undefined];
      }
      return [model, undefined];
    }

    case "user-approval": {
      if (model.state.state !== "pending-user-action") {
        return [model, undefined];
      }

      if (msg.approved) {
        const nextModel: Model = {
          ...model,
          state: {
            state: "processing",
            stdout: [],
            stderr: [],
            startTime: Date.now(),
            approved: true,
            childProcess: null,
          },
        };
        return [nextModel, executeCommandThunk(nextModel)];
      } else {
        return [
          {
            ...model,
            state: {
              state: "done",
              result: {
                type: "tool_result",
                id: model.request.id,
                result: {
                  status: "error",
                  error: `The user did not allow running this command.`,
                },
              },
            },
          },
          undefined,
        ];
      }
    }

    case "stdout": {
      if (model.state.state !== "processing") {
        return [model, undefined];
      }

      const lines = msg.text.split("\n");
      const stdout = [
        ...model.state.stdout,
        ...lines.filter((line) => line.trim() !== ""),
      ];

      return [
        {
          ...model,
          state: {
            ...model.state,
            stdout,
          },
        },
        undefined,
      ];
    }

    case "stderr": {
      if (model.state.state !== "processing") {
        return [model, undefined];
      }

      const lines = msg.text.split("\n");
      const stderr = [
        ...model.state.stderr,
        ...lines.filter((line) => line.trim() !== ""),
      ];

      return [
        {
          ...model,
          state: {
            ...model.state,
            stderr,
          },
        },
        undefined,
      ];
    }

    case "exit": {
      if (model.state.state !== "processing") {
        return [model, undefined];
      }

      const stdout = model.state.stdout.slice(-5000).join("\n");
      const stderr = model.state.stderr.slice(-5000).join("\n");

      const stderrSection = stderr.trim()
        ? `\nstderr:\n\`\`\`\n${stderr}\n\`\`\``
        : "";
      return [
        {
          ...model,
          state: {
            state: "done",
            result: {
              type: "tool_result",
              id: model.request.id,
              result: {
                status: "ok",
                value: `Exit code: ${msg.code === null ? "null" : String(msg.code)}\nstdout:\n\`\`\`\n${stdout}\n\`\`\`${stderrSection}`,
              },
            },
          },
        },
        undefined,
      ];
    }

    case "error": {
      return [
        {
          ...model,
          state: {
            state: "error",
            error: msg.error,
          },
        },
        undefined,
      ];
    }

    case "terminate": {
      if (model.state.state !== "processing") {
        return [model, undefined];
      }

      if (model.state.childProcess) {
        model.state.childProcess.kill("SIGTERM");

        return [
          {
            ...model,
            state: {
              ...model.state,
              stderr: [
                ...model.state.stderr,
                "Process terminated by user with SIGTERM",
              ],
            },
          },
          undefined,
        ];
      }
      return [model, undefined];
    }

    default:
      assertUnreachable(msg);
  }
}

export function view({
  model,
  dispatch,
}: {
  model: Model;
  dispatch?: Dispatch<Msg>;
}) {
  const { state } = model;

  if (state.state === "pending-user-action") {
    if (!dispatch) {
      return d`Waiting for user approval to run command: \`${model.request.input.command}\``;
    }
    return d`⏳ May I run this command? \`${model.request.input.command}\`
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
    const stderrSection = state.stderr.length
      ? `\nstderr:\n\`\`\`\n${state.stderr.join("\n")}\n\`\`\``
      : "";

    const content = d`Running command (timeout: 300s, running: ${String(runningTime)}s)
\`\`\`
${model.request.input.command}
\`\`\`

stdout:
\`\`\`
${state.stdout.join("\n")}
\`\`\`${stderrSection}`;

    if (!dispatch) {
      return content;
    }

    return withBindings(content, {
      t: () => dispatch({ type: "terminate" }),
    });
  }

  if (state.state === "done") {
    // Display the result content
    return d`Command:
\`\`\`
${model.request.input.command}
\`\`\`

${state.result.result.status === "ok" ? state.result.result.value : state.result.result.error}`;
  }

  if (state.state === "error") {
    return d`Error running command: ${state.error}`;
  }

  return d``;
}

export function getToolResult(model: Model): ProviderToolResultContent {
  const { state } = model;

  switch (state.state) {
    case "done":
      // Return the stored result
      return state.result;

    case "error":
      return {
        type: "tool_result",
        id: model.request.id,
        result: {
          status: "error",
          error: `Error: ${state.error}`,
        },
      };

    case "pending-user-action":
      return {
        type: "tool_result",
        id: model.request.id,
        result: {
          status: "ok",
          value: `Waiting for user approval to run this command.`,
        },
      };

    case "processing":
      return {
        type: "tool_result",
        id: model.request.id,
        result: {
          status: "ok",
          value: "Command still running",
        },
      };

    default:
      assertUnreachable(state);
  }
}

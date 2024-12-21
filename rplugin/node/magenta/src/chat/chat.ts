import Anthropic from "@anthropic-ai/sdk";
import { toMessageParam } from "./part.ts";
import {
  Model as Message,
  Msg as MessageMsg,
  update as updateMessage,
  view as messageView,
} from "./message.ts";
import {
  Dispatch,
  parallelThunks,
  Thunk,
  Update,
  wrapThunk,
} from "../tea/tea.ts";
import { d, View } from "../tea/view.ts";
import { context } from "../context.ts";
import * as ToolManager from "../tools/toolManager.ts";
import { getClient } from "../anthropic.ts";
import { Result } from "../utils/result.ts";

export type Role = "user" | "assistant";

export type ChatState =
  | {
      state: "pending-user-input";
    }
  | {
      state: "streaming-response";
    }
  | {
      state: "awaiting-tool-use";
    };

export function initModel(): Model {
  return {
    messages: [],
    toolManager: ToolManager.initModel(),
  };
}

export type Model = {
  messages: Message[];
  toolManager: ToolManager.Model;
};

export type Msg =
  | {
      type: "message-msg";
      msg: MessageMsg;
      idx: number;
    }
  | {
      type: "add-message";
      role: Role;
      content?: string;
    }
  | {
      type: "stream-response";
      text: string;
    }
  | {
      type: "stream-error";
      error: Error;
    }
  | {
      type: "init-tool-use";
      request: Result<ToolManager.ToolRequest, { rawRequest: unknown }>;
    }
  | {
      type: "send-message";
    }
  | {
      type: "clear";
    }
  | {
      type: "tool-manager-msg";
      msg: ToolManager.Msg;
    };

export const update: Update<Msg, Model> = (msg, model) => {
  switch (msg.type) {
    case "add-message": {
      let message: Message = {
        role: msg.role,
        parts: [],
      };

      if (msg.content) {
        const [next] = updateMessage(
          { type: "append-text", text: msg.content },
          message,
        );
        message = next;
      }
      model.messages.push(message);
      return [model];
    }

    case "send-message": {
      const lastMessage = model.messages[model.messages.length - 1];
      if (lastMessage && lastMessage.role == "user") {
        return [model, sendMessage(model)];
      } else {
        context.logger.error(
          `Cannot send when the last message has role ${lastMessage && lastMessage.role}`,
        );
        return [model];
      }
    }

    case "message-msg": {
      const [nextMessage] = updateMessage(msg.msg, model.messages[msg.idx]);
      model.messages[msg.idx] = nextMessage;

      if (
        msg.msg.type == "part-msg" &&
        msg.msg.msg.type == "tool-manager-msg"
      ) {
        const [nextToolManager, toolManagerThunk] = ToolManager.update(
          msg.msg.msg.msg,
          model.toolManager,
        );
        model.toolManager = nextToolManager;
        return [model, wrapThunk("tool-manager-msg", toolManagerThunk)];
      }

      return [model];
    }

    case "stream-response": {
      const lastMessage = model.messages[model.messages.length - 1];
      if (lastMessage?.role !== "assistant") {
        model.messages.push({
          role: "assistant",
          parts: [],
        });
      }

      const [nextMessage] = updateMessage(
        { type: "append-text", text: msg.text },
        model.messages[model.messages.length - 1],
      );
      model.messages[model.messages.length - 1] = nextMessage;

      return [model];
    }

    case "stream-error": {
      const lastMessage = model.messages[model.messages.length - 1];
      if (lastMessage?.role !== "assistant") {
        model.messages.push({
          role: "assistant",
          parts: [],
        });
      }

      const [nextMessage] = updateMessage(
        {
          type: "append-text",
          text: `Stream Error: ${msg.error.message}
${msg.error.stack}`,
        },
        model.messages[model.messages.length - 1],
      );
      model.messages[model.messages.length - 1] = nextMessage;

      return [model];
    }

    case "init-tool-use": {
      const lastMessage = model.messages[model.messages.length - 1];
      if (lastMessage?.role !== "assistant") {
        model.messages.push({
          role: "assistant",
          parts: [],
        });
      }

      if (msg.request.status == "error") {
        const [nextMessage] = updateMessage(
          {
            type: "add-part",
            part: {
              type: "malformed-tool-request",
              error: msg.request.error,
              rawRequest: msg.request.rawRequest,
            },
          },
          model.messages[model.messages.length - 1],
        );
        model.messages[model.messages.length - 1] = nextMessage;
        return [model];
      } else {
        const [nextToolManager, toolManagerThunk] = ToolManager.update(
          { type: "init-tool-use", request: msg.request.value },
          model.toolManager,
        );
        model.toolManager = nextToolManager;

        const [nextMessage] = updateMessage(
          {
            type: "add-part",
            part: {
              type: "tool-request",
              requestId: msg.request.value.id,
            },
          },
          model.messages[model.messages.length - 1],
        );
        model.messages[model.messages.length - 1] = nextMessage;
        return [model, wrapThunk("tool-manager-msg", toolManagerThunk)];
      }
    }

    case "tool-manager-msg": {
      const [nextToolManager, toolManagerThunk] = ToolManager.update(
        msg.msg,
        model.toolManager,
      );
      model.toolManager = nextToolManager;
      let thunk: Thunk<Msg> | undefined = wrapThunk(
        "tool-manager-msg",
        toolManagerThunk,
      );
      if (msg.msg.type == "tool-msg" && msg.msg.msg.msg.type == "finish") {
        const toolModel = nextToolManager.toolModels[msg.msg.id];

        if (toolModel.model.autoRespond) {
          let shouldRespond = true;
          for (const tool of Object.values(model.toolManager.toolModels)) {
            if (tool.model.state.state != "done") {
              shouldRespond = false;
              break;
            }
          }

          if (shouldRespond) {
            thunk = parallelThunks<Msg>(thunk, sendMessage(model));
          }
        }
      }
      return [model, thunk];
    }

    case "clear": {
      return [initModel()];
    }
  }
};

function sendMessage(model: Model): Thunk<Msg> {
  return async function (dispatch: Dispatch<Msg>) {
    const messages = getMessages(model);

    const toolRequests = await getClient().sendMessage(
      messages,
      (text) => {
        context.logger.trace(`stream received text ${text}`);
        dispatch({
          type: "stream-response",
          text,
        });
      },
      (error) => {
        context.logger.trace(`stream received error ${error}`);
        dispatch({
          type: "stream-error",
          error,
        });
      },
    );

    if (toolRequests.length) {
      for (const request of toolRequests) {
        dispatch({
          type: "init-tool-use",
          request,
        });
      }
    }
  };
}

export const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
  model,
  dispatch,
}) => {
  return d`${model.messages.map(
    (m, idx) =>
      d`${messageView({
        model: m,
        toolManager: model.toolManager,
        dispatch: (msg) => {
          dispatch({ type: "message-msg", msg, idx });
        },
      })}\n`,
  )}`;
};

export function getMessages(model: Model): Anthropic.MessageParam[] {
  return model.messages.flatMap((msg) => {
    const messageContent = [];
    const toolResponseContent = [];

    for (const part of msg.parts) {
      const { param, result } = toMessageParam(part, model.toolManager);
      messageContent.push(param);
      if (result) {
        toolResponseContent.push(result);
      }
    }

    const out: Anthropic.MessageParam[] = [
      {
        role: msg.role,
        content: messageContent,
      },
    ];

    if (toolResponseContent.length) {
      out.push({
        role: "user",
        content: toolResponseContent,
      });
    }

    return out;
  });
}

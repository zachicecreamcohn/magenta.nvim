import Anthropic from "@anthropic-ai/sdk";
import { toMessageParam } from "./part.ts";
import * as Message from "./message.ts";
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
    messageInFlight: undefined,
    messages: [],
    toolManager: ToolManager.initModel(),
  };
}

export type Model = {
  messageInFlight: Date | undefined;
  messages: Message.Model[];
  toolManager: ToolManager.Model;
};
type WrappedMessageMsg = {
  type: "message-msg";
  msg: Message.Msg;
  idx: number;
};

export type Msg =
  | WrappedMessageMsg
  | { type: "tick" }
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
      type: "message-in-flight";
      messageInFlight: boolean;
    }
  | {
      type: "clear";
    }
  | {
      type: "tool-manager-msg";
      msg: ToolManager.Msg;
    };

function wrapMessageThunk(
  messageIdx: number,
  thunk: Thunk<Message.Msg> | undefined,
): Thunk<WrappedMessageMsg> | undefined {
  if (!thunk) {
    return undefined;
  }
  return (dispatch: Dispatch<WrappedMessageMsg>) =>
    thunk((msg: Message.Msg) =>
      dispatch({ type: "message-msg", idx: messageIdx, msg }),
    );
}

export const update: Update<Msg, Model> = (msg, model) => {
  switch (msg.type) {
    case "tick":
      return [model];
    case "add-message": {
      let message: Message.Model = {
        role: msg.role,
        parts: [],
        edits: {},
      };

      let messageThunk;
      if (msg.content) {
        const [next, thunk] = Message.update(
          { type: "append-text", text: msg.content },
          message,
          model.toolManager,
        );
        message = next;
        messageThunk = thunk;
      }
      model.messages.push(message);
      return [model, wrapMessageThunk(model.messages.length - 1, messageThunk)];
    }

    case "message-in-flight": {
      model.messageInFlight = msg.messageInFlight ? new Date() : undefined;
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
      const [nextMessage, messageThunk] = Message.update(
        msg.msg,
        model.messages[msg.idx],
        model.toolManager,
      );
      model.messages[msg.idx] = nextMessage;

      if (msg.msg.type == "tool-manager-msg") {
        const [nextToolManager, toolManagerThunk] = ToolManager.update(
          msg.msg.msg,
          model.toolManager,
        );
        model.toolManager = nextToolManager;
        return [
          model,
          parallelThunks<Msg>(
            wrapMessageThunk(msg.idx, messageThunk),
            wrapThunk("tool-manager-msg", toolManagerThunk),
          ),
        ];
      }

      if (msg.msg.type == "diff-error") {
        const message = model.messages[msg.idx];
        const edit = message.edits[msg.msg.filePath];
        edit.status = {
          status: "error",
          message: msg.msg.error,
        };

        // TODO: maybe update request status with error?
        // for (const requestId of edit.requestIds) {
        // }
        return [model];
      }

      return [model, wrapMessageThunk(msg.idx, messageThunk)];
    }

    case "stream-response": {
      const lastMessage = model.messages[model.messages.length - 1];
      if (lastMessage?.role !== "assistant") {
        model.messages.push({
          role: "assistant",
          parts: [],
          edits: {},
        });
      }

      const [nextMessage, messageThunk] = Message.update(
        { type: "append-text", text: msg.text },
        model.messages[model.messages.length - 1],
        model.toolManager,
      );
      model.messages[model.messages.length - 1] = nextMessage;

      return [model, wrapMessageThunk(model.messages.length - 1, messageThunk)];
    }

    case "stream-error": {
      const lastMessage = model.messages[model.messages.length - 1];
      if (lastMessage?.role !== "assistant") {
        model.messages.push({
          role: "assistant",
          parts: [],
          edits: {},
        });
      }

      const [nextMessage, messageThunk] = Message.update(
        {
          type: "append-text",
          text: `Stream Error: ${msg.error.message}
${msg.error.stack}`,
        },
        model.messages[model.messages.length - 1],
        model.toolManager,
      );
      model.messages[model.messages.length - 1] = nextMessage;

      return [model, wrapMessageThunk(model.messages.length - 1, messageThunk)];
    }

    case "init-tool-use": {
      const lastMessage = model.messages[model.messages.length - 1];
      if (lastMessage?.role !== "assistant") {
        model.messages.push({
          role: "assistant",
          parts: [],
          edits: {},
        });
      }

      if (msg.request.status == "error") {
        const [nextMessage, messageThunk] = Message.update(
          {
            type: "add-malformed-tool-reqeust",
            error: msg.request.error,
            rawRequest: msg.request.rawRequest,
          },
          model.messages[model.messages.length - 1],
          model.toolManager,
        );
        model.messages[model.messages.length - 1] = nextMessage;
        return [
          model,
          wrapMessageThunk(model.messages.length - 1, messageThunk),
        ];
      } else {
        const [nextToolManager, toolManagerThunk] = ToolManager.update(
          { type: "init-tool-use", request: msg.request.value },
          model.toolManager,
        );
        model.toolManager = nextToolManager;

        const [nextMessage, messageThunk] = Message.update(
          {
            type: "add-tool-request",
            requestId: msg.request.value.id,
          },
          model.messages[model.messages.length - 1],
          model.toolManager,
        );
        model.messages[model.messages.length - 1] = nextMessage;
        return [
          model,
          parallelThunks<Msg>(
            wrapMessageThunk(model.messages.length - 1, messageThunk),
            wrapThunk("tool-manager-msg", toolManagerThunk),
          ),
        ];
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
        const toolModel = nextToolManager.toolWrappers[msg.msg.id];

        if (toolModel.model.autoRespond) {
          let shouldRespond = true;
          for (const tool of Object.values(model.toolManager.toolWrappers)) {
            if (tool.model.state.state != "done") {
              shouldRespond = false;
              break;
            }
          }

          if (shouldRespond) {
            context.logger.debug(
              `Got autoRespond message & no messages are pending, autoresponding.`,
            );
            thunk = parallelThunks<Msg>(thunk, sendMessage(model));
          } else {
            context.logger.debug(
              `Got autoRespond message but some messages are pending. Not responding.`,
            );
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

    dispatch({ type: "message-in-flight", messageInFlight: true });
    let toolRequests;
    try {
      toolRequests = await getClient().sendMessage(
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
    } finally {
      dispatch({ type: "message-in-flight", messageInFlight: false });
    }

    if (toolRequests?.length) {
      for (const request of toolRequests) {
        dispatch({
          type: "init-tool-use",
          request,
        });
      }
    }
  };
}

const MESSAGE_ANIMATION = [".", "..", "..."];

export const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
  model,
  dispatch,
}) => {
  return d`${model.messages.map(
    (m, idx) =>
      d`${Message.view({
        model: m,
        toolManager: model.toolManager,
        dispatch: (msg) => {
          dispatch({ type: "message-msg", msg, idx });
        },
      })}\n`,
  )}${
    model.messageInFlight
      ? d`Awaiting response ${
          MESSAGE_ANIMATION[
            Math.floor(
              (new Date().getTime() - model.messageInFlight.getTime()) / 333,
            ) % 3
          ]
        }`
      : ""
  }`;
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

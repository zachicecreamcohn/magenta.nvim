import Anthropic from "@anthropic-ai/sdk";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { toMessageParam } from "./part.ts";
import {
  Model as Message,
  Msg as MessageMsg,
  update as updateMessage,
  view as messageView,
} from "./message.ts";
import { ToolModel } from "../tools/toolManager.ts";
import {
  Dispatch,
  parallelThunks,
  Thunk,
  Update,
  wrapThunk,
} from "../tea/tea.ts";
import { d, View, withBindings } from "../tea/view.ts";
import { context } from "../context.ts";
import * as ToolManager from "../tools/toolManager.ts";
import { getClient } from "../anthropic.ts";

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
      type: "init-tool-use";
      request: ToolManager.ToolRequest;
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
      }
      return [model];
    }

    case "message-msg": {
      const [nextMessage] = updateMessage(msg.msg, model.messages[msg.idx]);
      model.messages[msg.idx] = nextMessage;

      if (msg.msg.type == "tool-manager-msg") {
        const [nextToolManager, toolManagerThunk] = ToolManager.update(
          msg.msg.msg,
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

    case "init-tool-use": {
      const [nextToolManager, toolManagerThunk] = ToolManager.update(
        { type: "init-tool-use", request: msg.request },
        model.toolManager,
      );
      model.toolManager = nextToolManager;

      const lastMessage = model.messages[model.messages.length - 1];
      if (lastMessage?.role !== "assistant") {
        model.messages.push({
          role: "assistant",
          parts: [],
        });
      }

      const [nextMessage] = updateMessage(
        { type: "add-tool-use", requestId: msg.request.id },
        model.messages[model.messages.length - 1],
      );
      model.messages[model.messages.length - 1] = nextMessage;
      return [model, wrapThunk("tool-manager-msg", toolManagerThunk)];
    }

    case "tool-manager-msg": {
      const [nextToolManager, toolManagerThunk] = ToolManager.update(
        msg.msg,
        model.toolManager,
      );
      model.toolManager = nextToolManager;
      let nextModel = model;
      let thunk: Thunk<Msg> | undefined = wrapThunk(
        "tool-manager-msg",
        toolManagerThunk,
      );
      if (msg.msg.type == "tool-msg" && msg.msg.msg.msg.type == "finish") {
        const toolModel = nextToolManager.toolModels[msg.msg.id];

        const response = msg.msg.msg.msg.result;
        [nextModel] = addToolResponse(model, toolModel, response);
        if (toolModel.autoRespond) {
          let shouldRespond = true;
          for (const tool of Object.values(model.toolManager.toolModels)) {
            if (tool.state.state != "done") {
              shouldRespond = false;
              break;
            }
          }

          if (shouldRespond) {
            thunk = parallelThunks<Msg>(thunk, sendMessage(model));
          }
        }
      }
      return [nextModel, thunk];
    }

    case "clear": {
      return [initModel()];
    }
  }
};

function sendMessage(model: Model): Thunk<Msg> {
  return async function (dispatch: Dispatch<Msg>) {
    const messages = getMessages(model);

    const toolRequests = await getClient().sendMessage(messages, (text) => {
      context.logger.trace(`stream received text ${text}`);
      dispatch({
        type: "stream-response",
        text,
      });
    });

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

function addToolResponse(
  model: Model,
  toolModel: ToolModel,
  response: ToolResultBlockParam,
): [Model] {
  let lastMessage = model.messages[model.messages.length - 1];
  if (lastMessage?.role !== "user") {
    lastMessage = {
      role: "user",
      parts: [],
    };
    model.messages.push(lastMessage);
  }

  const [next] = updateMessage(
    {
      type: "add-tool-response",
      requestId: toolModel.request.id,
      response,
    },
    lastMessage,
  );
  model.messages.splice(model.messages.length - 1, 1, next);
  return [model];
}

export const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
  model,
  dispatch,
}) => {
  return withBindings(
    d`# Chat\n${model.messages.map(
      (m, idx) =>
        d`${messageView({
          model: m,
          toolManager: model.toolManager,
          dispatch: (msg) => {
            dispatch({ type: "message-msg", msg, idx });
          },
        })}\n`,
    )}`,
    { Enter: () => context.logger.debug("hello, binding") },
  );
};

export function getMessages(model: Model): Anthropic.MessageParam[] {
  return model.messages.map((msg) => ({
    role: msg.role,
    content: msg.parts.map((p) => toMessageParam(p, model.toolManager)),
  }));
}

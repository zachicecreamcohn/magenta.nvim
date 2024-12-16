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
import { Dispatch, Update } from "../tea/tea.ts";
import { d, View } from "../tea/view.ts";

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

export type Model = {
  messages: Message[];
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
      type: "add-tool-use";
      toolModel: ToolModel;
    }
  | {
      type: "add-tool-response";
      toolModel: ToolModel;
      response: ToolResultBlockParam;
    }
  | {
      type: "tool-model-update";
      toolModel: ToolModel;
    }
  | {
      type: "clear";
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

    case "message-msg": {
      const [nextMessage] = updateMessage(msg.msg, model.messages[msg.idx]);
      model.messages[msg.idx] = nextMessage;
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

    case "add-tool-use": {
      const lastMessage = model.messages[model.messages.length - 1];
      if (lastMessage?.role !== "assistant") {
        model.messages.push({
          role: "assistant",
          parts: [],
        });
      }
      const [nextMessage] = updateMessage(
        { type: "add-tool-use", toolModel: msg.toolModel },
        model.messages[model.messages.length - 1],
      );
      model.messages[model.messages.length - 1] = nextMessage;
      return [model];
    }

    case "add-tool-response": {
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
          toolModel: msg.toolModel,
          response: msg.response,
        },
        lastMessage,
      );
      model.messages.splice(model.messages.length - 1, 1, next);
      return [model];
    }

    case "tool-model-update": {
      const nextMessages: Model["messages"] = [];
      for (const message of model.messages) {
        const [next] = updateMessage(
          {
            type: "tool-model-update",
            toolModel: msg.toolModel,
          },
          message,
        );

        nextMessages.push(next);
      }

      return [
        {
          ...model,
          messages: nextMessages,
        },
      ];
    }

    case "clear": {
      return [{ messages: [] }];
    }
  }
};

export const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
  model,
  dispatch,
}) => {
  return d`# Chat\n${model.messages.map(
    (m, idx) =>
      d`${messageView({
        model: m,
        dispatch: (msg) => {
          dispatch({ type: "message-msg", msg, idx });
        },
      })}\n`,
  )}`;
};

export function getMessages(model: Model): Anthropic.MessageParam[] {
  return model.messages.map((msg) => ({
    role: msg.role,
    content: msg.parts.map(toMessageParam),
  }));
}

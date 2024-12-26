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
import { getClient, StopReason } from "../anthropic.ts";
import { Result } from "../utils/result.ts";

export type Role = "user" | "assistant";

export function initModel(): Model {
  return {
    conversation: { state: "stopped", stopReason: "end_turn" },
    messages: [],
    toolManager: ToolManager.initModel(),
  };
}

export type ConversationState =
  | {
      state: "message-in-flight";
      sendDate: Date;
    }
  | {
      state: "stopped";
      stopReason: StopReason;
    };

export type Model = {
  conversation: ConversationState;
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
      type: "conversation-state";
      conversation: ConversationState;
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

    case "conversation-state": {
      model.conversation = msg.conversation;
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

      let toolManagerMsg;
      if (msg.msg.type == "tool-manager-msg") {
        toolManagerMsg = msg.msg.msg;
      }

      if (
        msg.msg.type == "part-msg" &&
        msg.msg.msg.type == "tool-manager-msg"
      ) {
        toolManagerMsg = msg.msg.msg.msg;
      }

      if (toolManagerMsg) {
        const [nextToolManager, toolManagerThunk] = ToolManager.update(
          toolManagerMsg,
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
          parallelThunks(
            wrapMessageThunk(model.messages.length - 1, messageThunk),
            maybeAutorespond(model),
          ),
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
            maybeAutorespond(model),
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
      const respondThunk = maybeAutorespond(model);
      return [
        model,
        parallelThunks(
          wrapThunk("tool-manager-msg", toolManagerThunk),
          respondThunk,
        ),
      ];
    }

    case "clear": {
      return [initModel()];
    }
  }
};

/** If the agent is waiting on tool use, check the last message to see if all tools have been resolved. If so,
 * automatically respond.
 */
function maybeAutorespond(model: Model): Thunk<Msg> | undefined {
  if (
    !(
      model.conversation.state == "stopped" &&
      model.conversation.stopReason == "tool_use"
    )
  ) {
    return;
  }

  const lastMessage = model.messages[model.messages.length - 1];
  if (!(lastMessage && lastMessage.role == "assistant")) {
    return;
  }

  function isBlocking(requestId: ToolManager.ToolRequestId) {
    const toolWrapper = model.toolManager.toolWrappers[requestId];
    return toolWrapper.model.state.state != "done";
  }

  for (const part of lastMessage.parts) {
    if (part.type == "tool-request") {
      if (isBlocking(part.requestId)) {
        return;
      }
    }
  }

  for (const filePath in lastMessage.edits) {
    for (const requestId of lastMessage.edits[filePath].requestIds) {
      if (isBlocking(requestId)) {
        return;
      }
    }
  }

  return sendMessage(model);
}

function sendMessage(model: Model): Thunk<Msg> {
  return async function (dispatch: Dispatch<Msg>) {
    const messages = getMessages(model);

    dispatch({
      type: "conversation-state",
      conversation: {
        state: "message-in-flight",
        sendDate: new Date(),
      },
    });
    let res;
    try {
      res = await getClient().sendMessage(
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
      dispatch({
        type: "conversation-state",
        conversation: {
          state: "stopped",
          stopReason: res?.stopReason || "end_turn",
        },
      });
    }

    if (res.toolRequests?.length) {
      for (const request of res.toolRequests) {
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
    model.conversation.state == "message-in-flight"
      ? d`Awaiting response ${
          MESSAGE_ANIMATION[
            Math.floor(
              (new Date().getTime() - model.conversation.sendDate.getTime()) /
                333,
            ) % 3
          ]
        }`
      : d`Stopped (${model.conversation.stopReason || ""})`
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

    for (const filePath in msg.edits) {
      for (const requestId of msg.edits[filePath].requestIds) {
        const toolWrapper = model.toolManager.toolWrappers[requestId];
        if (!toolWrapper) {
          throw new Error(
            `Expected to find tool use with requestId ${requestId}`,
          );
        }

        messageContent.push(toolWrapper.model.request);
        toolResponseContent.push(ToolManager.getToolResult(toolWrapper.model));
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

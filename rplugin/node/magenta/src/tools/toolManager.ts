import * as GetFile from "./getFile.ts";
import * as Insert from "./insert.ts";
import { Update } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";

export type ToolRequest =
  | GetFile.GetFileToolUseRequest
  | Insert.InsertToolUseRequest;

export const TOOL_SPECS = [GetFile.spec, Insert.spec];

export type Model = {
  toolModels: {
    [id: string]: GetFile.Model | Insert.Model;
  };
};

export type Msg =
  | {
      type: "init-tool-use";
      request: GetFile.GetFileToolUseRequest | Insert.InsertToolUseRequest;
    }
  | {
      type: "tool-msg";
      id: string;
      msg:
        | {
            type: "get-file";
            msg: GetFile.Msg;
          }
        | {
            type: "insert";
            msg: Insert.Msg;
          };
    };

export function initModel(): Model {
  return {
    toolModels: {},
  };
}

export const update: Update<Msg, Model> = (msg, model) => {
  switch (msg.type) {
    case "init-tool-use": {
      const request = msg.request;
      switch (request.name) {
        case "get_file": {
          const [getFileModel, thunk] = GetFile.initModel(request);
          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [request.id]: getFileModel,
              },
            },
            (dispatch) =>
              thunk((msg) =>
                dispatch({
                  type: "tool-msg",
                  id: request.id,
                  msg: {
                    type: "get-file",
                    msg,
                  },
                }),
              ),
          ];
        }

        case "insert": {
          const [insertModel, thunk] = Insert.initModel(request);
          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [request.id]: insertModel,
              },
            },
            (dispatch) =>
              thunk((msg) =>
                dispatch({
                  type: "tool-msg",
                  id: request.id,
                  msg: {
                    type: "insert",
                    msg,
                  },
                }),
              ),
          ];
        }
        default:
          return assertUnreachable(request);
      }
    }

    case "tool-msg": {
      const toolModel = model.toolModels[msg.id];
      if (!toolModel) {
        throw new Error(`Expected to find tool with id ${msg.id}`);
      }

      switch (msg.msg.type) {
        case "get-file": {
          const [nextToolModel, thunk] = GetFile.update(
            msg.msg.msg,
            toolModel as GetFile.Model,
          );

          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [msg.id]: nextToolModel,
              },
            },
            thunk
              ? (dispatch) =>
                  thunk((innerMsg) =>
                    dispatch({
                      type: "tool-msg",
                      id: msg.id,
                      msg: {
                        type: "get-file",
                        msg: innerMsg,
                      },
                    }),
                  )
              : undefined,
          ];
        }

        case "insert": {
          const [nextToolModel, thunk] = Insert.update(
            msg.msg.msg,
            toolModel as Insert.Model,
          );

          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [msg.id]: nextToolModel,
              },
            },
            thunk
              ? (dispatch) =>
                  thunk((innerMsg) =>
                    dispatch({
                      type: "tool-msg",
                      id: msg.id,
                      msg: {
                        type: "insert",
                        msg: innerMsg,
                      },
                    }),
                  )
              : undefined,
          ];
        }

        default:
          return assertUnreachable(msg.msg);
      }
    }

    default:
      assertUnreachable(msg);
  }
};

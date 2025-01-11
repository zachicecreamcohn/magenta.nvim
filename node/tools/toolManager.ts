import * as GetFile from "./getFile.ts";
import * as Insert from "./insert.ts";
import * as Replace from "./replace.ts";
import * as ListBuffers from "./listBuffers.ts";
import * as ListDirectory from "./listDirectory.ts";
import * as Hover from "./hover.ts";
import * as FindReferences from "./findReferences.ts";
import * as Diagnostics from "./diagnostics.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Result } from "../utils/result.ts";
import { d, withBindings } from "../tea/view.ts";
import { type Dispatch, type Update } from "../tea/tea.ts";
import type { Nvim } from "nvim-node";
import type { Lsp } from "../lsp.ts";
import type { ProviderToolResultContent } from "../providers/provider.ts";

type ToolMap = {
  get_file: {
    input: GetFile.Input;
  };
  insert: {
    input: Insert.Input;
  };
  replace: {
    input: Replace.Input;
  };
  list_buffers: {
    input: ListBuffers.Input;
  };
  list_directory: {
    input: ListDirectory.Input;
  };
  hover: {
    input: Hover.Input;
  };
  find_references: {
    input: FindReferences.Input;
  };
  diagnostics: {
    input: Diagnostics.Input;
  };
};

export type ToolName = keyof ToolMap;

export type ToolRequest<Name extends ToolName = ToolName> = {
  id: ToolRequestId;
  name: Name;
  input: ToolMap[Name]["input"];
};

export type ToolModel =
  | GetFile.Model
  | Insert.Model
  | Replace.Model
  | ListBuffers.Model
  | ListDirectory.Model
  | Hover.Model
  | FindReferences.Model
  | Diagnostics.Model;

export type ToolRequestId = string & { __toolRequestId: true };

export const TOOL_SPECS = [
  GetFile.spec,
  Insert.spec,
  Replace.spec,
  ListBuffers.spec,
  ListDirectory.spec,
  Hover.spec,
  FindReferences.spec,
  Diagnostics.spec,
];

export type ToolModelWrapper = {
  model: ToolModel;
  showRequest: boolean;
  showResult: boolean;
};

export type Model = {
  toolWrappers: {
    [id: ToolRequestId]: ToolModelWrapper;
  };
};

export type Msg =
  | {
      type: "init-tool-use";
      request: ToolRequest<ToolName>;
    }
  | {
      type: "toggle-display";
      id: ToolRequestId;
      showRequest: boolean;
      showResult: boolean;
    }
  | {
      type: "tool-msg";
      id: ToolRequestId;
      msg:
        | {
            type: "get_file";
            msg: GetFile.Msg;
          }
        | {
            type: "list_buffers";
            msg: ListBuffers.Msg;
          }
        | {
            type: "list_directory";
            msg: ListDirectory.Msg;
          }
        | {
            type: "insert";
            msg: Insert.Msg;
          }
        | {
            type: "replace";
            msg: Replace.Msg;
          }
        | {
            type: "hover";
            msg: Hover.Msg;
          }
        | {
            type: "find_references";
            msg: FindReferences.Msg;
          }
        | {
            type: "diagnostics";
            msg: Diagnostics.Msg;
          };
    };

export function validateToolInput(
  type: unknown,
  args: { [key: string]: unknown },
): Result<ToolMap[ToolName]["input"]> {
  switch (type) {
    case "get_file":
      return GetFile.validateInput(args);
    case "insert":
      return Insert.validateInput(args);
    case "replace":
      return Replace.validateInput(args);
    case "list_buffers":
      return ListBuffers.validateInput();
    case "list_directory":
      return ListDirectory.validateInput(args);
    case "hover":
      return Hover.validateInput(args);
    case "find_references":
      return FindReferences.validateInput(args);
    case "diagnostics":
      return Diagnostics.validateInput();
    default:
      return {
        status: "error",
        error: `Unexpected request type ${type as string}`,
      };
  }
}

export function init({ nvim, lsp }: { nvim: Nvim; lsp: Lsp }) {
  function getToolResult(model: ToolModel): ProviderToolResultContent {
    switch (model.type) {
      case "get_file":
        return GetFile.getToolResult(model);
      case "insert":
        return Insert.getToolResult(model);
      case "replace":
        return Replace.getToolResult(model);
      case "list_buffers":
        return ListBuffers.getToolResult(model);
      case "list_directory":
        return ListDirectory.getToolResult(model);
      case "hover":
        return Hover.getToolResult(model);
      case "find_references":
        return FindReferences.getToolResult(model);
      case "diagnostics":
        return Diagnostics.getToolResult(model);
      default:
        return assertUnreachable(model);
    }
  }

  function displayRequestInput(model: ToolModel): string {
    switch (model.type) {
      case "get_file":
        return GetFile.displayInput(model.request.input);
      case "insert":
        return Insert.displayInput(model.request.input);
      case "replace":
        return Replace.displayInput(model.request.input);
      case "list_buffers":
        return ListBuffers.displayInput();
      case "list_directory":
        return ListDirectory.displayInput(model.request.input);
      case "hover":
        return Hover.displayInput(model.request.input);
      case "find_references":
        return FindReferences.displayInput(model.request.input);
      case "diagnostics":
        return Diagnostics.displayInput();
      default:
        return assertUnreachable(model);
    }
  }

  function displayResult(model: ToolModel) {
    if (model.state.state == "done") {
      const result = model.state.result;
      if (result.result.status == "error") {
        return `\nError: ${result.result.error}`;
      } else {
        return `\nResult:
\`\`\`
${result.result.value}
\`\`\``;
      }
    } else {
      return "";
    }
  }

  function renderTool(
    model: Model["toolWrappers"][ToolRequestId],
    dispatch: Dispatch<Msg>,
  ) {
    return withBindings(
      d`${renderToolContents(model.model, dispatch)}${
        model.showRequest
          ? d`\nid: ${model.model.request.id}\n${displayRequestInput(model.model)}`
          : ""
      }${model.showResult ? displayResult(model.model) : ""}`,
      {
        "<CR>": () =>
          dispatch({
            type: "toggle-display",
            id: model.model.request.id,
            showRequest: !model.showRequest,
            showResult: !model.showResult,
          }),
      },
    );
  }

  function renderToolContents(model: ToolModel, dispatch: Dispatch<Msg>) {
    switch (model.type) {
      case "get_file":
        return GetFile.view({
          model,
          dispatch: (msg) =>
            dispatch({
              type: "tool-msg",
              id: model.request.id,
              msg: { type: "get_file", msg },
            }),
        });

      case "list_buffers":
        return ListBuffers.view({ model });

      case "list_directory":
        return ListDirectory.view({ model });

      case "insert":
        return Insert.view({
          model,
          dispatch: (msg) =>
            dispatch({
              type: "tool-msg",
              id: model.request.id,
              msg: { type: "insert", msg },
            }),
        });

      case "replace":
        return Replace.view({
          model,
          dispatch: (msg) =>
            dispatch({
              type: "tool-msg",
              id: model.request.id,
              msg: { type: "replace", msg },
            }),
        });

      case "hover":
        return Hover.view({
          model,
        });

      case "find_references":
        return FindReferences.view({
          model,
        });

      case "diagnostics":
        return Diagnostics.view({
          model,
        });

      default:
        assertUnreachable(model);
    }
  }

  function initModel(): Model {
    return {
      toolWrappers: {},
    };
  }

  const update: Update<Msg, Model, { nvim: Nvim }> = (msg, model, context) => {
    switch (msg.type) {
      case "toggle-display": {
        const toolWrapper = model.toolWrappers[msg.id];
        if (!toolWrapper) {
          throw new Error(`Could not find tool use with request id ${msg.id}`);
        }

        toolWrapper.showRequest = msg.showRequest;
        toolWrapper.showResult = msg.showResult;

        return [model];
      }

      case "init-tool-use": {
        const request = msg.request;

        switch (request.name) {
          case "get_file": {
            const [getFileModel, thunk] = GetFile.initModel(
              request as ToolRequest<"get_file">,
              { nvim },
            );
            model.toolWrappers[request.id] = {
              model: getFileModel,
              showRequest: false,
              showResult: false,
            };
            return [
              model,
              (dispatch) =>
                thunk((msg) =>
                  dispatch({
                    type: "tool-msg",
                    id: request.id,
                    msg: {
                      type: "get_file",
                      msg,
                    },
                  }),
                ),
            ];
          }

          case "list_buffers": {
            const [listBuffersModel, thunk] = ListBuffers.initModel(
              request as ToolRequest<"list_buffers">,
              {
                nvim,
              },
            );
            model.toolWrappers[request.id] = {
              model: listBuffersModel,
              showRequest: false,
              showResult: false,
            };
            return [
              model,
              (dispatch) =>
                thunk((msg) =>
                  dispatch({
                    type: "tool-msg",
                    id: request.id,
                    msg: {
                      type: "list_buffers",
                      msg,
                    },
                  }),
                ),
            ];
          }

          case "insert": {
            const [insertModel] = Insert.initModel(
              request as ToolRequest<"insert">,
            );
            model.toolWrappers[request.id] = {
              model: insertModel,
              showRequest: false,
              showResult: false,
            };
            return [model];
          }

          case "replace": {
            const [replaceModel] = Replace.initModel(
              request as ToolRequest<"replace">,
            );
            model.toolWrappers[request.id] = {
              model: replaceModel,
              showRequest: false,
              showResult: false,
            };
            return [model];
          }

          case "list_directory": {
            const [listDirModel, thunk] = ListDirectory.initModel(
              request as ToolRequest<"list_directory">,
              {
                nvim,
              },
            );
            model.toolWrappers[request.id] = {
              model: listDirModel,
              showRequest: false,
              showResult: false,
            };
            return [
              model,
              (dispatch) =>
                thunk((msg) =>
                  dispatch({
                    type: "tool-msg",
                    id: request.id,
                    msg: {
                      type: "list_directory",
                      msg,
                    },
                  }),
                ),
            ];
          }

          case "hover": {
            const [hoverModel, thunk] = Hover.initModel(
              request as ToolRequest<"hover">,
              { nvim, lsp },
            );
            model.toolWrappers[request.id] = {
              model: hoverModel,
              showRequest: false,
              showResult: false,
            };
            return [
              model,
              (dispatch) =>
                thunk((msg) =>
                  dispatch({
                    type: "tool-msg",
                    id: request.id,
                    msg: {
                      type: "hover",
                      msg,
                    },
                  }),
                ),
            ];
          }

          case "find_references": {
            const [findReferencesModel, thunk] = FindReferences.initModel(
              request as ToolRequest<"find_references">,
              { nvim, lsp },
            );
            model.toolWrappers[request.id] = {
              model: findReferencesModel,
              showRequest: false,
              showResult: false,
            };
            return [
              model,
              (dispatch) =>
                thunk((msg) =>
                  dispatch({
                    type: "tool-msg",
                    id: request.id,
                    msg: {
                      type: "find_references",
                      msg,
                    },
                  }),
                ),
            ];
          }

          case "diagnostics": {
            const [diagnosticsModel, thunk] = Diagnostics.initModel(
              request as ToolRequest<"diagnostics">,
              {
                nvim,
              },
            );
            model.toolWrappers[request.id] = {
              model: diagnosticsModel,
              showRequest: false,
              showResult: false,
            };
            return [
              model,
              (dispatch) =>
                thunk((msg) =>
                  dispatch({
                    type: "tool-msg",
                    id: request.id,
                    msg: {
                      type: "diagnostics",
                      msg,
                    },
                  }),
                ),
            ];
          }

          default:
            return assertUnreachable(request.name);
        }
      }

      case "tool-msg": {
        const toolWrapper = model.toolWrappers[msg.id];
        if (!toolWrapper) {
          throw new Error(`Expected to find tool with id ${msg.id}`);
        }

        switch (msg.msg.type) {
          case "get_file": {
            const [nextToolModel, thunk] = GetFile.update(
              msg.msg.msg,
              toolWrapper.model as GetFile.Model,
              context,
            );
            toolWrapper.model = nextToolModel;

            return [
              model,
              thunk
                ? (dispatch) =>
                    thunk((innerMsg) =>
                      dispatch({
                        type: "tool-msg",
                        id: msg.id,
                        msg: {
                          type: "get_file",
                          msg: innerMsg,
                        },
                      }),
                    )
                : undefined,
            ];
          }

          case "list_buffers": {
            const [nextToolModel, thunk] = ListBuffers.update(
              msg.msg.msg,
              toolWrapper.model as ListBuffers.Model,
            );
            toolWrapper.model = nextToolModel;

            return [
              model,
              thunk
                ? (dispatch) =>
                    thunk((innerMsg) =>
                      dispatch({
                        type: "tool-msg",
                        id: msg.id,
                        msg: {
                          type: "list_buffers",
                          msg: innerMsg,
                        },
                      }),
                    )
                : undefined,
            ];
          }

          case "list_directory": {
            const [nextToolModel, thunk] = ListDirectory.update(
              msg.msg.msg,
              toolWrapper.model as ListDirectory.Model,
            );
            toolWrapper.model = nextToolModel;

            return [
              model,
              thunk
                ? (dispatch) =>
                    thunk((innerMsg) =>
                      dispatch({
                        type: "tool-msg",
                        id: msg.id,
                        msg: {
                          type: "list_directory",
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
              toolWrapper.model as Insert.Model,
            );
            toolWrapper.model = nextToolModel;

            return [
              model,
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

          case "replace": {
            const [nextToolModel, thunk] = Replace.update(
              msg.msg.msg,
              toolWrapper.model as Replace.Model,
            );
            toolWrapper.model = nextToolModel;

            return [
              model,
              thunk
                ? (dispatch) =>
                    thunk((innerMsg) =>
                      dispatch({
                        type: "tool-msg",
                        id: msg.id,
                        msg: {
                          type: "replace",
                          msg: innerMsg,
                        },
                      }),
                    )
                : undefined,
            ];
          }

          case "hover": {
            const [nextToolModel, thunk] = Hover.update(
              msg.msg.msg,
              toolWrapper.model as Hover.Model,
            );
            toolWrapper.model = nextToolModel;

            return [
              model,
              thunk
                ? (dispatch) =>
                    thunk((innerMsg) =>
                      dispatch({
                        type: "tool-msg",
                        id: msg.id,
                        msg: {
                          type: "hover",
                          msg: innerMsg,
                        },
                      }),
                    )
                : undefined,
            ];
          }

          case "find_references": {
            const [nextToolModel, thunk] = FindReferences.update(
              msg.msg.msg,
              toolWrapper.model as FindReferences.Model,
            );
            toolWrapper.model = nextToolModel;

            return [
              model,
              thunk
                ? (dispatch) =>
                    thunk((innerMsg) =>
                      dispatch({
                        type: "tool-msg",
                        id: msg.id,
                        msg: {
                          type: "find_references",
                          msg: innerMsg,
                        },
                      }),
                    )
                : undefined,
            ];
          }

          case "diagnostics": {
            const [nextToolModel, thunk] = Diagnostics.update(
              msg.msg.msg,
              toolWrapper.model as Diagnostics.Model,
            );
            toolWrapper.model = nextToolModel;

            return [
              model,
              thunk
                ? (dispatch) =>
                    thunk((innerMsg) =>
                      dispatch({
                        type: "tool-msg",
                        id: msg.id,
                        msg: {
                          type: "diagnostics",
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

  return {
    getToolResult,
    update,
    initModel,
    renderTool,
  };
}

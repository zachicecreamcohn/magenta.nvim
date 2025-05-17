import { NvimBuffer, type Line } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { ToolRequest } from "./toolManager.ts";
import type { Dispatch } from "../tea/tea.ts";
import path from "node:path";
import fs from "node:fs";
import { getBufferIfOpen } from "../utils/buffers.ts";
import type { Result } from "../utils/result.ts";
import type { RootMsg } from "../root-msg.ts";
import type { MessageId } from "../chat/message.ts";
import type { ThreadId } from "../chat/thread.ts";
import { resolveFilePath } from "../utils/files.ts";
import { getcwd } from "../nvim/nvim.ts";
import { applyInsert, applyReplace } from "../utils/contentEdits.ts";

type InsertRequest = Extract<ToolRequest, { toolName: "insert" }>;
type ReplaceRequest = Extract<ToolRequest, { toolName: "replace" }>;
type EditRequest = InsertRequest | ReplaceRequest;
type Msg = {
  type: "finish";
  result: Result<string>;
};

type EditContext = {
  nvim: Nvim;
  myDispatch: Dispatch<Msg>;
  dispatch: Dispatch<RootMsg>;
};

/**
 * Helper function to save buffer changes and check if it's still modified
 * @returns true if successfully saved, false if still modified
 */
async function saveBufferChanges(buffer: NvimBuffer): Promise<boolean> {
  const isModified = await buffer.getOption("modified");
  if (isModified) {
    try {
      await buffer.attemptWrite();
    } catch {
      // ok if this fails
    }
    const stillModified = await buffer.getOption("modified");
    return !stillModified;
  }
  return true;
}

async function handleBufferEdit(
  request: EditRequest,
  buffer: NvimBuffer,
  context: EditContext,
): Promise<void> {
  const { myDispatch: dispatch } = context;
  const { filePath } = request.input;

  // First, try and persist any current buffer changes we have to disk, to make sure that the file hasn't changed
  // out from under us.
  if (!(await saveBufferChanges(buffer))) {
    dispatch({
      type: "finish",
      result: {
        status: "error",
        error: `Buffer for ${filePath} has unsaved changes that could not be written to disk.`,
      },
    });
    return;
  }

  // small performance optimization - don't need to load all the content if we're just appending
  if (request.toolName === "insert" && request.input.insertAfter === "") {
    const { content } = request.input;

    const contentLines = content.split("\n") as Line[];
    await buffer.setLines({
      start: -1,
      end: -1,
      lines: contentLines,
    });
    return;
  }

  const lines = await buffer.getLines({
    start: 0,
    end: -1,
  });
  const bufferContent = lines.join("\n");
  let newContent: string;

  if (request.toolName === "insert") {
    const { insertAfter, content } = request.input;
    const result = applyInsert(bufferContent, insertAfter, content);

    if (result.status === "error") {
      dispatch({
        type: "finish",
        result: {
          status: "error",
          error: `${result.error} in file \`${filePath}\``,
        },
      });
      return;
    }

    newContent = result.content;
  } else if (request.toolName === "replace") {
    const { find, replace } = request.input;
    const result = applyReplace(bufferContent, find, replace);

    if (result.status === "error") {
      dispatch({
        type: "finish",
        result: {
          status: "error",
          error: `${result.error} in file \`${filePath}\``,
        },
      });
      return;
    }

    newContent = result.content;
  } else {
    // This should never happen due to TypeScript, but adding as a safeguard
    dispatch({
      type: "finish",
      result: {
        status: "error",
        error: `Unknown edit operation for file \`${filePath}\``,
      },
    });
    return;
  }

  await buffer.setLines({
    start: 0,
    end: -1,
    lines: newContent.split("\n") as Line[],
  });

  if (!(await saveBufferChanges(buffer))) {
    dispatch({
      type: "finish",
      result: {
        status: "error",
        error: `Failed to modify buffer: Buffer ${filePath} has unsaved changes that could not be written to disk.`,
      },
    });
    return;
  }

  dispatch({
    type: "finish",
    result: {
      status: "ok",
      value: `Successfully applied edits.`,
    },
  });
}

async function handleFileEdit(
  request: EditRequest,
  context: EditContext,
): Promise<void> {
  const { myDispatch: dispatch } = context;
  const { filePath } = request.input;
  const cwd = await getcwd(context.nvim);
  const absFilePath = resolveFilePath(cwd, filePath);

  if (request.toolName === "insert" && request.input.insertAfter === "") {
    try {
      let fileExists = true;
      try {
        await fs.promises.access(absFilePath);
      } catch {
        fileExists = false;
      }

      if (fileExists) {
        const fileHandle = await fs.promises.open(absFilePath, "a");
        await fileHandle.write(request.input.content);
        await fileHandle.close();
      } else {
        const dirPath = path.dirname(absFilePath);
        await fs.promises.mkdir(dirPath, { recursive: true });
        await fs.promises.writeFile(
          absFilePath,
          request.input.content,
          "utf-8",
        );
      }

      dispatch({
        type: "finish",
        result: {
          status: "ok",
          value: `Successfully applied edits.`,
        },
      });
      return;
    } catch (error) {
      dispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Error accessing file ${filePath}: ${(error as Error).message}`,
        },
      });
      return;
    }
  }

  let fileContent;
  try {
    fileContent = await fs.promises.readFile(filePath, "utf-8");
  } catch {
    if (request.toolName === "replace" && request.input.find === "") {
      // Special case: empty find parameter with replace on non-existent file
      fileContent = "";
    } else {
      dispatch({
        type: "finish",
        result: {
          status: "error",
          error: `File \`${filePath}\` does not exist.`,
        },
      });
      return;
    }
  }

  let newContent: string;

  if (request.toolName === "insert") {
    const { insertAfter, content } = request.input;
    const result = applyInsert(fileContent, insertAfter, content);

    if (result.status === "error") {
      dispatch({
        type: "finish",
        result: {
          status: "error",
          error: `${result.error} in file \`${filePath}\`.
          Read the contents of the file and make sure your insertAfter parameter matches the content of the file exactly.`,
        },
      });
      return;
    }

    newContent = result.content;
  } else if (request.toolName === "replace") {
    const { find, replace } = request.input;
    const result = applyReplace(fileContent, find, replace);

    if (result.status === "error") {
      dispatch({
        type: "finish",
        result: {
          status: "error",
          error: `${result.error} in file \`${filePath}\`.`,
        },
      });
      return;
    }

    newContent = result.content;
  } else {
    dispatch({
      type: "finish",
      result: {
        status: "error",
        error: `Unknown edit operation for file \`${filePath}\``,
      },
    });
    return;
  }

  try {
    await fs.promises.writeFile(filePath, newContent, "utf-8");
    dispatch({
      type: "finish",
      result: {
        status: "ok",
        value: `Successfully applied edits.`,
      },
    });
  } catch (error) {
    dispatch({
      type: "finish",
      result: {
        status: "error",
        error: `Error writing to file ${filePath}: ${(error as Error).message}`,
      },
    });
  }
}

/**
 * Main function to apply edits to a file or buffer
 */
export async function applyEdit(
  request: EditRequest,
  threadId: ThreadId,
  messageId: MessageId,
  context: EditContext,
): Promise<void> {
  const { filePath } = request.input;
  const { nvim, myDispatch, dispatch } = context;

  dispatch({
    type: "thread-msg",
    id: threadId,
    msg: {
      type: "take-file-snapshot",
      unresolvedFilePath: filePath,
      messageId,
    },
  });

  const bufferOpenResult = await getBufferIfOpen({
    unresolvedPath: filePath,
    context: { nvim },
  });

  if (bufferOpenResult.status === "error") {
    myDispatch({
      type: "finish",
      result: {
        status: "error",
        error: bufferOpenResult.error,
      },
    });
    return;
  }

  if (bufferOpenResult.status === "ok") {
    await handleBufferEdit(request, bufferOpenResult.buffer, context);
  } else if (bufferOpenResult.status === "not-found") {
    await handleFileEdit(request, context);
  }

  const cwd = await getcwd(context.nvim);
  const absFilePath = resolveFilePath(cwd, filePath);
  dispatch({
    type: "thread-msg",
    id: threadId,
    msg: {
      type: "context-manager-msg",
      msg: {
        type: "tool-applied",
        absFilePath,
        tool:
          request.toolName == "insert"
            ? {
                type: "insert",
                insertAfter: request.input.insertAfter,
                content: request.input.content,
              }
            : {
                type: "replace",
                find: request.input.find,
                replace: request.input.replace,
              },
      },
    },
  });
}

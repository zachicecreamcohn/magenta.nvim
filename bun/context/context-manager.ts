import { d, withBindings, type View } from "../tea/view";
import type { Dispatch, Update } from "../tea/tea";
import { assertUnreachable } from "../utils/assertUnreachable";
import type { ProviderMessage } from "../providers/provider";
import type { Nvim } from "bunvim";
import type { MessageId } from "../chat/message";
import { BufferAndFileManager } from "./file-and-buffer-manager";

export type Model = {
  files: {
    [absFilePath: string]: {
      relFilePath: string;
      initialMessageId: MessageId;
    };
  };
};

export type Msg =
  | {
      type: "add-file-context";
      relFilePath: string;
      absFilePath: string;
      messageId: MessageId;
    }
  | {
      type: "remove-file-context";
      absFilePath: string;
    };

export function init({ nvim }: { nvim: Nvim }) {
  const bufferAndFileManager = new BufferAndFileManager(nvim);

  function initModel(): Model {
    return {
      files: {},
    };
  }
  const update: Update<Msg, Model> = (msg: Msg, model: Model) => {
    switch (msg.type) {
      case "add-file-context":
        return [
          {
            ...model,
            files: {
              ...model.files,
              [msg.absFilePath]: {
                relFilePath: msg.relFilePath,
                initialMessageId: msg.messageId,
              },
            },
          },
        ];
      case "remove-file-context":
        delete model.files[msg.absFilePath];
        return [model];
      default:
        assertUnreachable(msg);
    }
  };

  const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
    model,
    dispatch,
  }) => {
    const fileContext = [];
    for (const absFilePath in model.files) {
      fileContext.push(
        withBindings(d`file: \`${model.files[absFilePath].relFilePath}\`\n`, {
          "<CR>": () => dispatch({ type: "remove-file-context", absFilePath }),
        }),
      );
    }

    return d`\
# context:
${fileContext}`;
  };

  function isContextEmpty(model: Model) {
    return Object.keys(model.files).length == 0;
  }

  async function getContextMessages(
    currentMessageId: MessageId,
    model: Model,
  ): Promise<{ messageId: MessageId; message: ProviderMessage }[] | undefined> {
    if (isContextEmpty(model)) {
      return undefined;
    }

    return await Promise.all(
      Object.keys(model.files).map((absFilePath) =>
        getFileMessage({ absFilePath, currentMessageId }),
      ),
    );
  }

  async function getFileMessage({
    absFilePath,
    currentMessageId,
  }: {
    absFilePath: string;
    currentMessageId: MessageId;
  }): Promise<{ messageId: MessageId; message: ProviderMessage }> {
    const res = await bufferAndFileManager.getFileContents(
      absFilePath,
      currentMessageId,
    );

    switch (res.status) {
      case "ok":
        return {
          messageId: res.value.messageId,
          message: {
            role: "user",
            content: renderFile({
              relFilePath: res.value.relFilePath,
              content: res.value.content,
            }),
          },
        };

      case "error":
        return {
          messageId: currentMessageId,
          message: {
            role: "user",
            content: `Error reading file \`${absFilePath}\`: ${res.error}`,
          },
        };
      default:
        assertUnreachable(res);
    }
  }

  function renderFile({
    relFilePath,
    content,
  }: {
    relFilePath: string;
    content: string;
  }) {
    return `\
Here are the contents of file \`${relFilePath}\`:
\`\`\`
${content}
\`\`\``;
  }

  return {
    isContextEmpty,
    initModel,
    update,
    view,
    getContextMessages,
  };
}

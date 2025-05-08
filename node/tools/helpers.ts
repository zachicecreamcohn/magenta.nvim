import * as GetFile from "./getFile";
import * as Insert from "./insert";
import * as Replace from "./replace";
import * as ListBuffers from "./listBuffers";
import * as ListDirectory from "./listDirectory";
import * as Hover from "./hover";
import * as FindReferences from "./findReferences";
import * as Diagnostics from "./diagnostics";
import * as BashCommand from "./bashCommand";

export function validateInput(
  toolName: unknown,
  input: { [key: string]: unknown },
) {
  switch (toolName) {
    case "get_file":
      return GetFile.validateInput(input);
    case "insert":
      return Insert.validateInput(input);
    case "replace":
      return Replace.validateInput(input);
    case "list_buffers":
      return ListBuffers.validateInput();
    case "list_directory":
      return ListDirectory.validateInput(input);
    case "hover":
      return Hover.validateInput(input);
    case "find_references":
      return FindReferences.validateInput(input);
    case "diagnostics":
      return Diagnostics.validateInput();
    case "bash_command":
      return BashCommand.validateInput(input);
    case "inline_edit":
      return Replace.validateInput(input);
    case "replace_selection":
      return Replace.validateInput(input);
    default:
      throw new Error(`Unexpected toolName: ${toolName as string}`);
  }
}

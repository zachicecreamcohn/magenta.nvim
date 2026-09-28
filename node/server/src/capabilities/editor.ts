import type { AuthUI } from "../auth-ui.ts";
import type { AbsFilePath, Cwd, HomeDir } from "../utils/files.ts";
import type { LspClient } from "./lsp-client.ts";
import type { LuaExecutor } from "./lua-executor.ts";

/** Collaborators an attached editor lends to threads created while it is
 * attached. Threads keep the ones they were created with. */
export interface EditorCapabilities {
  neovimVersion: string;
  /** Per-thread, since LSP paths are resolved against the thread cwd. */
  createLspClient(cwd: Cwd, homeDir: HomeDir): LspClient;
  luaExecutor: LuaExecutor;
  /** Lets the editor reload buffers after an agent writes a file. */
  onFileWritten?(absPath: AbsFilePath): Promise<void>;
  /** Prompts for interactive provider logins (OAuth codes, CLI logins). */
  authUI?: AuthUI;
}

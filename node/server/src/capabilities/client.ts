import type { AuthUI } from "../auth-ui.ts";
import type { AgentInput } from "../providers/provider-types.ts";
import type { AbsFilePath, Cwd, HomeDir } from "../utils/files.ts";
import type { LspClient } from "./lsp-client.ts";
import type { LuaExecutor } from "./lua-executor.ts";

/** Collaborators an attached client lends to threads created while it is
 * attached. Threads keep the ones they were created with. */
export interface ClientCapabilities {
  neovimVersion: string;
  /** Per-thread, since LSP paths are resolved against the thread cwd. */
  createLspClient(cwd: Cwd, homeDir: HomeDir): LspClient;
  luaExecutor: LuaExecutor;
  /** Lets the editor reload buffers after an agent writes a file. */
  onFileWritten?(absPath: AbsFilePath): Promise<void>;
  /** Prompts for interactive provider logins (OAuth codes, CLI logins). */
  authUI?: AuthUI;
  /** Expands a client-state command (`@buf`, `@qf`, `@diag`, ...) against the
   * client's current state. Serializable: name and matched text in. */
  expandClientCommand(
    command: ClientCommandName,
    match: string,
  ): Promise<AgentInput[]>;
}
export type ClientCommandName =
  | "buf"
  | "buffers"
  | "qf"
  | "quickfix"
  | "diag"
  | "diagnostics";

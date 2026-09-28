import type { EditorCapabilities } from "@magenta/server";
import type { Lsp } from "../capabilities/lsp.ts";
import { NvimLspClient } from "../capabilities/lsp-client-adapter.ts";
import { NvimLuaExecutor } from "../capabilities/nvim-lua-executor.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { reloadBufferIfOpen } from "../utils/buffers.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";

/** The collaborators this Neovim instance lends to threads while attached. */
export async function createNvimEditor({
  nvim,
  lsp,
  cwd,
  homeDir,
}: {
  nvim: Nvim;
  lsp: Lsp;
  cwd: NvimCwd;
  homeDir: HomeDir;
}): Promise<EditorCapabilities> {
  const neovimVersion = String(await nvim.call("nvim_eval", ["v:version"]));
  return {
    neovimVersion,
    createLspClient: (threadCwd, threadHomeDir) =>
      new NvimLspClient(lsp, nvim, threadCwd, threadHomeDir),
    luaExecutor: new NvimLuaExecutor(nvim),
    onFileWritten: (absPath) =>
      reloadBufferIfOpen({ nvim, cwd, homeDir }, absPath),
  };
}

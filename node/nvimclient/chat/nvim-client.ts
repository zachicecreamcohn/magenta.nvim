import type {
  ClientEffectHandler,
  ClientNotification,
  ClientRequest,
  ClientResponse,
  JsonValue,
  LspRequest,
} from "@magenta/server";
import { NvimAuthUI } from "../auth/auth-ui.ts";
import type { Lsp } from "../capabilities/lsp.ts";
import { NvimLspClient } from "../capabilities/lsp-client-adapter.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { reloadBufferIfOpen } from "../utils/buffers.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { expandClientCommand } from "./commands/client-commands.ts";

/** Handles the effects the server requests of this Neovim instance. */
export async function createNvimClient({
  nvim,
  lsp,
  cwd,
  homeDir,
}: {
  nvim: Nvim;
  lsp: Lsp;
  cwd: NvimCwd;
  homeDir: HomeDir;
}): Promise<ClientEffectHandler> {
  const neovimVersion = String(await nvim.call("nvim_eval", ["v:version"]));
  const authUI = new NvimAuthUI(nvim);

  function lspRequest(req: LspRequest) {
    const client = new NvimLspClient(lsp, nvim, req.cwd, req.homeDir);
    switch (req.kind) {
      case "hover":
        return client.requestHover(req.filePath, req.position);
      case "references":
        return client.requestReferences(req.filePath, req.position);
      case "definition":
        return client.requestDefinition(req.filePath, req.position);
      case "typeDefinition":
        return client.requestTypeDefinition(req.filePath, req.position);
    }
  }

  async function handle(
    req: ClientRequest,
  ): Promise<ClientResponse<ClientRequest>> {
    switch (req.type) {
      case "lsp":
        return lspRequest(req);
      case "lua":
        return ((await nvim.call("nvim_exec_lua", [req.code, []])) ??
          null) as JsonValue;
      case "expandClientCommand":
        return expandClientCommand(req.command, { nvim, cwd, homeDir });
      case "oauth":
        return { code: await authUI.showOAuthFlow(req.authUrl) };
      case "fileWritten":
        await reloadBufferIfOpen({ nvim, cwd, homeDir }, req.absPath);
        return undefined;
    }
  }

  return {
    info: { neovimVersion, supportsAuthUI: true, notifiesFileWritten: true },
    // `handle` switches on `type`, which fixes the response type per request.
    request: <R extends ClientRequest>(req: R) =>
      handle(req) as Promise<ClientResponse<R>>,
    notify(n: ClientNotification) {
      switch (n.type) {
        case "loginProgress":
          return authUI.showLoginProgress(n.chunk);
        case "authError":
          return authUI.showError(n.message);
      }
    },
  };
}

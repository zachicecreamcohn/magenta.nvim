import type { ClientEffectHandler } from "../protocol/client.ts";
import type { AbsFilePath, Cwd, HomeDir } from "../utils/files.ts";
import type { LspClient } from "./lsp-client.ts";
import type { LuaExecutor } from "./lua-executor.ts";

export type ClientCommandName =
  | "buf"
  | "buffers"
  | "qf"
  | "quickfix"
  | "diag"
  | "diagnostics";

/** Adapts client requests to the `LspClient` tools use; LSP paths resolve
 * against the thread cwd. */
export function clientLspClient(
  client: ClientEffectHandler,
  cwd: Cwd,
  homeDir: HomeDir,
): LspClient {
  const base = { type: "lsp" as const, cwd, homeDir };
  return {
    requestHover: (filePath, position) =>
      client.request({ ...base, kind: "hover" as const, filePath, position }),
    requestReferences: (filePath, position) =>
      client.request({
        ...base,
        kind: "references" as const,
        filePath,
        position,
      }),
    requestDefinition: (filePath, position) =>
      client.request({
        ...base,
        kind: "definition" as const,
        filePath,
        position,
      }),
    requestTypeDefinition: (filePath, position) =>
      client.request({
        ...base,
        kind: "typeDefinition" as const,
        filePath,
        position,
      }),
  };
}

export function clientLuaExecutor(client: ClientEffectHandler): LuaExecutor {
  return { execLua: (code) => client.request({ type: "lua", code }) };
}

export function clientFileWritten(
  client: ClientEffectHandler,
): ((absPath: AbsFilePath) => Promise<void>) | undefined {
  if (!client.info.notifiesFileWritten) return undefined;
  return (absPath) => client.request({ type: "fileWritten", absPath });
}

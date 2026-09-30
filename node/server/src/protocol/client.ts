import type { ClientCommandName } from "../capabilities/client.ts";
import type {
  LspDefinitionResponse,
  LspHoverResponse,
  LspReferencesResponse,
} from "../capabilities/lsp-client.ts";
import type { AgentInput } from "../providers/provider-types.ts";
import type { AbsFilePath, Cwd, HomeDir } from "../utils/files.ts";
import type { JsonValue } from "../utils/json.ts";

export type ClientInfo = {
  neovimVersion: string;
  supportsAuthUI: boolean;
  notifiesFileWritten: boolean;
};

export type LspRequestKind =
  | "hover"
  | "references"
  | "definition"
  | "typeDefinition";

export type LspRequest = {
  type: "lsp";
  kind: LspRequestKind;
  cwd: Cwd;
  homeDir: HomeDir;
  filePath: AbsFilePath;
  position: { line: number; character: number };
};

export type ClientRequest =
  | LspRequest
  | { type: "lua"; code: string }
  | { type: "expandClientCommand"; command: ClientCommandName; match: string }
  | { type: "oauth"; authUrl: string }
  | { type: "fileWritten"; absPath: AbsFilePath };

type LspResponseMap = {
  hover: LspHoverResponse;
  references: LspReferencesResponse;
  definition: LspDefinitionResponse;
  typeDefinition: LspDefinitionResponse;
};

export type ClientResponse<R extends ClientRequest> = R extends {
  type: "lsp";
  kind: infer K extends LspRequestKind;
}
  ? LspResponseMap[K]
  : R extends { type: "lua" }
    ? JsonValue
    : R extends { type: "expandClientCommand" }
      ? AgentInput[]
      : R extends { type: "oauth" }
        ? { code: string }
        : R extends { type: "fileWritten" }
          ? undefined
          : never;

export type ClientNotification =
  | { type: "loginProgress"; chunk: string }
  | { type: "authError"; message: string };

/** The attached client, as data in both directions. Every capability the
 * server borrows from a client is a `ClientRequest` handled here. */
export interface ClientEffectHandler {
  info: ClientInfo;
  /** Rejection surfaces as the caller's error. Cancellation is a later
   * `cancel` request by id once there is a transport; in-process the server
   * drops the result. */
  request<R extends ClientRequest>(req: R): Promise<ClientResponse<R>>;
  notify(n: ClientNotification): void;
}

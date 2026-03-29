import type { ThreadId, ThreadType } from "../chat-types.ts";
import type {
  ProviderToolSpec as MCPProviderToolSpec,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import type { ToolRequest, ToolRequestId } from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import * as BashCommand from "./bashCommand.ts";
import * as Diagnostics from "./diagnostics.ts";
import * as Edl from "./edl.ts";
import * as FindReferences from "./findReferences.ts";
import * as GetFile from "./getFile.ts";
import * as Hover from "./hover.ts";
import * as SpawnSubagents from "./spawn-subagents.ts";
import * as ThreadTitle from "./thread-title.ts";
import {
  CHAT_STATIC_TOOL_NAMES,
  COMPACT_STATIC_TOOL_NAMES,
  DOCKER_ROOT_STATIC_TOOL_NAMES,
  type StaticToolName,
  SUBAGENT_STATIC_TOOL_NAMES,
  TOOL_REQUIRED_CAPABILITIES,
  type ToolCapability,
} from "./tool-registry.ts";

import * as YieldToParent from "./yield-to-parent.ts";

export type { CompletedToolInfo, ToolRequestId } from "../tool-types.ts";

export interface MCPToolManager {
  getToolSpecs(): MCPProviderToolSpec[];
}

export type StaticToolMap = {
  get_file: { input: GetFile.Input };
  hover: { input: Hover.Input };
  find_references: { input: FindReferences.Input };
  diagnostics: { input: Diagnostics.Input };
  bash_command: { input: BashCommand.Input };
  thread_title: { input: ThreadTitle.Input };
  spawn_subagents: { input: SpawnSubagents.Input };
  yield_to_parent: { input: YieldToParent.Input };
  edl: { input: Edl.Input };
};

export type StaticToolRequest = {
  [K in keyof StaticToolMap]: {
    id: ToolRequestId;
    toolName: K;
    input: StaticToolMap[K]["input"];
  };
}[keyof StaticToolMap];

export type Msg = {
  type: "init-tool-use";
  threadId: ThreadId;
  request: ToolRequest;
};

const TOOL_SPEC_MAP: {
  [K in StaticToolName]: ProviderToolSpec;
} = {
  get_file: GetFile.spec,

  hover: Hover.spec,
  find_references: FindReferences.spec,

  bash_command: BashCommand.spec,
  diagnostics: Diagnostics.spec,
  thread_title: ThreadTitle.spec,
  spawn_subagents: SpawnSubagents.spec,
  yield_to_parent: YieldToParent.spec,

  edl: Edl.spec,
};

export function getToolSpecs(
  threadType: ThreadType,
  mcpToolManager: MCPToolManager,
  availableCapabilities?: Set<ToolCapability>,
): ProviderToolSpec[] {
  let staticToolNames: StaticToolName[] = [];
  switch (threadType) {
    case "subagent_default":
    case "subagent_fast":
    case "subagent_explore":
      staticToolNames = SUBAGENT_STATIC_TOOL_NAMES;
      break;
    case "compact":
      staticToolNames = COMPACT_STATIC_TOOL_NAMES;
      break;
    case "docker_root":
      staticToolNames = DOCKER_ROOT_STATIC_TOOL_NAMES;
      break;
    case "root":
    case "conductor":
      staticToolNames = CHAT_STATIC_TOOL_NAMES;
      break;
    default:
      assertUnreachable(threadType);
  }
  const filteredToolNames =
    availableCapabilities !== undefined
      ? staticToolNames.filter((toolName) => {
          const required = TOOL_REQUIRED_CAPABILITIES[toolName];
          for (const cap of required) {
            if (!availableCapabilities.has(cap)) {
              return false;
            }
          }
          return true;
        })
      : staticToolNames;
  return [
    ...filteredToolNames.map((toolName) => TOOL_SPEC_MAP[toolName]),
    ...mcpToolManager.getToolSpecs(),
  ];
}

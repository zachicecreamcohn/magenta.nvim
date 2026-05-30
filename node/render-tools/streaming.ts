import {
  type AgentStreamingBlock,
  assertUnreachable,
  extractPartialJsonStringValue,
  SpawnSubagents,
  type StaticToolName,
  splitScriptByFile,
} from "@magenta/core";
import { d, type VDOMNode, withCode } from "../tea/view.ts";
import { renderSpawnLayout } from "./spawn-subagents.ts";

export function renderStreamdedTool(
  streamingBlock: Extract<AgentStreamingBlock, { type: "tool_use" }>,
): string | VDOMNode {
  if (streamingBlock.name.startsWith("mcp_")) {
    return d`Invoking mcp tool ${streamingBlock.name}`;
  }

  const name = streamingBlock.name as StaticToolName;
  switch (name) {
    case "get_file":
    case "hover":
    case "find_references":
    case "bash_command":
    case "thread_title":
    case "yield_to_parent":
    case "docs":
      break;
    case "spawn_subagents": {
      const input = SpawnSubagents.parsePartialSpawnSubagentsInput(
        streamingBlock.inputJson,
      );
      return d`🤖 spawn_subagents:\n${renderSpawnLayout(input)}`;
    }
    case "edl": {
      const script = extractPartialJsonStringValue(
        streamingBlock.inputJson,
        "script",
      );
      if (script !== undefined) {
        const segments = splitScriptByFile(script);
        const lines = script.split("\n");
        const tail = lines.slice(-10).join("\n");
        if (segments.length > 0) {
          const fileList = segments.map((s) => `  ${s.path}`).join("\n");
          return d`📝 edl: editing ${String(segments.length)} file${segments.length !== 1 ? "s" : ""}:\n${fileList}\n${withCode(d`${tail}`)}`;
        }
        return d`📝 edl:\n${withCode(d`${tail}`)}`;
      }
      break;
    }
    default:
      assertUnreachable(name);
  }

  return d`Invoking tool ${streamingBlock.name}\n`;
}

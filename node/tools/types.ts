import type { VDOMNode } from "../tea/view";

export type ToolRequestId = string & { __toolRequestId: true };

/** Opaque toolName type. Internally we'll differentiate between static tools and mcp tools, but external to the tool
 * manager, we'll use opaque types.
 */
export type ToolName = string & { __toolName: true };

export type ToolRequest = {
  id: ToolRequestId;
  toolName: ToolName;
  input: unknown;
};

export interface Tool {
  abort(): void;
  view(): VDOMNode;
}
export type ToolManagerToolMsg = {
  type: "tool-msg";
  msg: {
    id: ToolRequestId;
    toolName: ToolName;
    msg: ToolMsg;
  };
};
/** Opaque tool message for external consumption
 */
export type ToolMsg = { __toolMsg: true };

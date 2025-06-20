import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { MCPServerConfig } from "../../options.ts";
import type { Nvim } from "../../nvim/nvim-node";
import type { ProviderToolResultContent } from "../../providers/provider.ts";
import { assertUnreachable } from "../../utils/assertUnreachable.ts";

export type MCPToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type MCPToolName = string & { __MCPToolName: true };
export type MCPToolRequestParams = {} & { __MCPTooRequestParams: true };

export class MCPClient {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private isConnected: boolean = false;
  private tools: Tool[] = [];

  constructor(
    public serverName: string,
    private config: MCPServerConfig,
    private context: {
      nvim: Nvim;
    },
  ) {}

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      // Create transport and client
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      for (const [key, value] of Object.entries(this.config.env || {})) {
        env[key] = value;
      }

      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env,
      });

      this.client = new Client({
        name: `magenta-mcp-client-${this.serverName}`,
        version: "1.0.0",
      });

      // Connect client to transport
      await this.client.connect(this.transport);

      // Discover available tools
      await this.loadTools();

      this.isConnected = true;
    } catch (error) {
      this.disconnect().catch((e) =>
        this.context.nvim.logger?.error(
          `Error disconnecting MCP client: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
      throw new Error(
        `Failed to connect to MCP server ${this.serverName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;

    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        console.error(`Error closing MCP client ${this.serverName}:`, error);
      }
      this.client = undefined;
    }

    if (this.transport) {
      try {
        await this.transport.close();
      } catch (error) {
        console.error(`Error closing MCP transport ${this.serverName}:`, error);
      }
      this.transport = undefined;
    }

    this.tools = [];
  }

  private async loadTools(): Promise<void> {
    if (!this.client) {
      throw new Error(`Client not connected for MCP server ${this.serverName}`);
    }

    try {
      const response = await this.client.listTools();
      this.tools = response.tools;
    } catch (error) {
      throw new Error(
        `Failed to load tools from MCP server ${this.serverName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  listTools(): MCPToolSchema[] {
    return this.tools.map((tool) => ({
      name: `mcp.${this.serverName}.${tool.name}`,
      description: tool.description ?? "",
      inputSchema: {
        type: "object",
        properties: tool.inputSchema.properties || {},
        required: tool.inputSchema.required || [],
      },
    }));
  }

  async callTool(
    toolName: MCPToolName,
    params: MCPToolRequestParams,
  ): Promise<ProviderToolResultContent[]> {
    if (!this.client || !this.isConnected) {
      throw new Error(`MCP client ${this.serverName} is not connected`);
    }

    // Remove the mcp.serverName. prefix from the tool name
    const expectedPrefix = `mcp.${this.serverName}.`;
    if (!toolName.startsWith(expectedPrefix)) {
      throw new Error(
        `Tool name ${toolName} does not match expected prefix ${expectedPrefix}`,
      );
    }

    const actualToolName = toolName.slice(expectedPrefix.length);

    const result: CallToolResult = await this.client.request(
      {
        method: actualToolName,
        params,
      },
      CallToolResultSchema,
    );

    return result.content.map((c): ProviderToolResultContent => {
      switch (c.type) {
        case "text":
          return {
            type: "text",
            text: c.text,
          };
        case "image":
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: c.mimeType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: c.data,
            },
          };
        case "audio":
          return {
            type: "text",
            text: `[MCP audio content type not supported yet]`,
          };
        case "resource_link":
          return {
            type: "text",
            text: `[MCP resource_link content type not supported yet]`,
          };
        case "resource":
          return {
            type: "text",
            text: `[MCP resource content type not supported yet]`,
          };
        default:
          assertUnreachable(c);
      }
    });
  }

  isToolAvailable(toolName: string): boolean {
    const expectedPrefix = `mcp.${this.serverName}.`;
    if (!toolName.startsWith(expectedPrefix)) {
      return false;
    }

    const actualToolName = toolName.slice(expectedPrefix.length);
    return this.tools.some((tool) => tool.name === actualToolName);
  }

  getConnectionStatus(): {
    connected: boolean;
    serverName: string;
    toolCount: number;
  } {
    return {
      connected: this.isConnected,
      serverName: this.serverName,
      toolCount: this.tools.length,
    };
  }
}

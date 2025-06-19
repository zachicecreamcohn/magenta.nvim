# MCP Tool Support Implementation Plan

## Context

The goal is to integrate Model Context Protocol (MCP) tool support into magenta.nvim. This will allow the plugin to connect to external MCP servers (like GitHub, Slack, databases, etc.) and make their tools available to AI agents alongside the existing in-code tools.

Key requirements:

- Only stdio MCP transport initially
- Tools namespaced as `mcp.server.toolName`
- Static configuration (no dynamic server discovery)
- Maintain existing tool architecture patterns
- transition to Tool concept being opaque outside tool manager
- Support both plugin-level and project-level configuration
- Strong typing for in-code tools while handling MCP tools generically

## Architecture Overview

The existing tool system uses:

- `ToolMap` type mapping tool names to their controllers/inputs/messages
- `ToolManager` class that manages tool lifecycle and routing messages
- `tool-registry.ts` and `tool-specs.ts` for tool registration
- Individual tool files implementing the tool pattern

For MCP integration, we'll:

- Add a new `MCPToolManager` that handles MCP server connections and tool discovery
- Extend the existing `ToolManager` to delegate MCP tool calls to `MCPToolManager`
- Add configuration schema for MCP servers in options
- Create a generic MCP tool wrapper that implements the existing tool interface
- Extend tool specs generation to include MCP tools discovered at thread creation time

## Key Types and Files

Relevant files:

- `node/tools/toolManager.ts`: Core tool management - handles tool creation and message routing
- `node/tools/tool-registry.ts`: Tool name constants and registry
- `node/tools/tool-specs.ts`: Tool specifications for LLM providers
- `node/tools/types.ts`: Tool interface definition
- `node/options.ts`: Plugin configuration structure
- `node/chat/thread.ts`: Thread creation where tool lists are generated
- `node/chat/chat.ts`: Chat initialization and thread creation

Key interfaces to extend:

- `MagentaOptions`: Add MCP server configuration
- `ToolMap`: Extend to include MCP tools dynamically
- `ToolManager`: Add MCP tool delegation
- `ProviderToolSpec`: Use for MCP tool specifications

## Implementation

### Phase 1: Core MCP Infrastructure

- [ ] Install MCP SDK dependency

  - [ ] Add `@modelcontextprotocol/sdk` to package.json dependencies
  - [ ] Run `npm install` and verify installation

- [ ] Create MCP server configuration schema

  - [ ] Extend `MagentaOptions` type in `node/options.ts` to include `mcpServers` field as `Record<string, MCPServerConfig>`
  - [ ] Add `MCPServerConfig` type with fields: `command: string`, `args: string[]`, `env?: Record<string, string>`
  - [ ] Update `parseOptions` and `parseProjectOptions` to handle MCP server configuration
  - [ ] Update `mergeOptions` to merge MCP servers from base and project options (merge at server name key level)
  - [ ] Iterate until type checks pass

- [ ] Create MCP client wrapper class

  - [ ] Create `node/tools/mcp/client.ts` with `MCPClient` class
  - [ ] Implement stdio transport connection to MCP servers
  - [ ] Add methods: `connect()`, `disconnect()`, `listTools()`, `callTool()`
  - [ ] Handle connection lifecycle and error recovery
  - [ ] Add proper TypeScript types for MCP tool schemas
  - [ ] Iterate until type checks pass

- [ ] Create generic MCP tool wrapper
  - [ ] Create `node/tools/mcp/tool.ts` with `MCPTool` class that implements `ToolInterface`
  - [ ] Handle tool execution by delegating to `MCPClient`
  - [ ] Implement proper state management (pending, processing, done, error)
  - [ ] Add view rendering for MCP tool status
  - [ ] Add input validation and error handling
  - [ ] Iterate until type checks pass

### Phase 2: Prepare tool manager

- [ ] We're going to prepare the codebase to make the Tool more opaque
  - [ ] outside of the toolManager, toolName should be an opaque, branded `string & {__toolName: true}` type.
  - [ ] outside of the toolManager, toolRequests and toolResponses should be opaque
  - [ ] outside of the toolManager, tool Msg should be opaque
  - [ ] this means we expose just a branded type to chat, thread, message, etc...

### Phase 3: Integration with Existing Tool System

- [ ] Create a MCPToolManager in `node/tools/mcp/manager.ts`.

  - [ ] this should have a static create method that accepts a config
  - [ ] the static method should make requests to all the configured servers and discover their tools
  - [ ] it should then construct the actual MCPToolManager class from the results

- [ ] Extend tool manager for MCP tool support

  - [ ] Modify `ToolManager` constructor to accept `MCPToolManager` instance
  - [ ] Add logic to check if a tool request is for an MCP tool (starts with "mcp.")
  - [ ] Delegate MCP tool requests to `MCPToolManager` instead of handling locally
  - [ ] Update error handling to account for MCP tool failures
  - [ ] Ensure existing in-code tools continue to work unchanged
  - [ ] Ensure that we still have strict types for standard tools and exhaustive type checks
  - [ ] Check for compilation errors and iterate until resolved

- [ ] Update tool registry for dynamic MCP tools
  - [ ] Update `allowedTools` and `getToolSpecs()` flows to instead live on the tool manager and depend on the mcp manager state
  - [ ] Check for type errors and iterate until resolved

### Phase 4: Thread Integration and Tool Discovery

- [ ] Integrate MCP tool discovery in thread creation
  - [ ] Modify `Thread` constructor to accept `MCPToolManager` instance
  - [ ] Modify `Chat` class constructor to create `MCPToolManager` instance from options
  - [ ] Pass `MCPToolManager` to `Thread` constructor in `createThreadWithContext()`
  - [ ] Handle MCP configuration loading from both plugin and project settings
  - [ ] Add error handling for MCP initialization failures
  - [ ] Check for type errors and iterate until resolved

## Configuration Example

The final MCP configuration in options would look like:

```typescript
// Plugin-level configuration (lua/magenta/options.lua)
mcpServers: {
  filesystem: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"],
    env: {}
  },
  git: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-git", "--repository", "/path/to/repo"],
    env: {}
  }
}

// Project-level configuration (.magenta/options.json)
{
  "mcpServers": {
    "postgres": {
      "command": "mcp-server-postgres",
      "args": ["--connection-string", "postgresql://localhost/mydb"],
      "env": {
        "DATABASE_URL": "postgresql://localhost/mydb"
      }
    }
  }
}
```


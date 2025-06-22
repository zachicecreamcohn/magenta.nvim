# Copilot Integration Architecture

This document explains how avante.nvim integrates with GitHub Copilot, covering API endpoint discovery, model availability detection, and authentication handling.

## Overview

The Copilot provider (`lua/avante/providers/copilot.lua`) inherits from the OpenAI provider but implements GitHub's OAuth-based authentication system. It provides access to all Copilot models including Claude and Gemini through a unified OpenAI-compatible interface.

## Authentication Flow

### OAuth Token Discovery

The provider discovers existing Copilot installations by checking for OAuth tokens in standard locations:

```lua
-- Checks for tokens in:
-- ~/.config/github-copilot/hosts.json (copilot.lua)
-- ~/.config/github-copilot/apps.json (copilot.vim)
-- Windows: ~/AppData/Local/github-copilot/
```

### Token Exchange Process

1. **OAuth Token Retrieval**: Reads the stored OAuth token from existing Copilot installation
2. **GitHub API Token Exchange**: Exchanges OAuth token for temporary GitHub API token via:
   ```
   POST https://api.github.com/copilot_internal/v2/token
   Authorization: token {oauth_token}
   ```
3. **Token Storage**: Stores the received token in `{stdpath("data")}/avante/github-copilot.json`

### Token Management

The provider implements sophisticated token lifecycle management:

- **Automatic Refresh**: Refreshes tokens 2 minutes before expiration
- **Background Timers**: Uses 28-minute refresh intervals after initial setup
- **Multi-Instance Coordination**: Uses lockfiles to prevent multiple Neovim instances from refreshing simultaneously
- **File Watching**: Monitors token file for external changes
- **Process Locking**: Prevents race conditions during token refresh

```lua
-- Timer setup for token refresh
local initial_interval = math.max(0, (time_until_expiry - 120) * 1000)
local repeat_interval = 28 * 60 * 1000 -- 28 minutes
```

## API Endpoint Discovery

### Dynamic Endpoint Resolution

Unlike traditional providers with fixed endpoints, Copilot uses dynamic endpoints discovered through the token exchange:

1. **Token Response Contains Endpoints**: The GitHub API token response includes an `endpoints` object:

   ```json
   {
     "token": "...",
     "endpoints": {
       "api": "https://api.githubcopilot.com",
       "origin-tracker": "...",
       "proxy": "...",
       "telemetry": "..."
     }
   }
   ```

2. **Chat Completion URL Construction**:

   ```lua
   function H.chat_completion_url(base_url)
     return Utils.url_join(base_url, "/chat/completions")
   end
   ```

3. **Runtime Endpoint Usage**: All API calls use the dynamically discovered endpoint:
   ```lua
   url = H.chat_completion_url(M.state.github_token.endpoints.api)
   ```

## Model Discovery

### Models List API

The provider discovers available models through a dedicated endpoint:

```lua
function M:models_list()
  -- GET {github_token.endpoints.api}/models
  -- Authorization: Bearer {github_token.token}
end
```

### Model Filtering and Transformation

Raw model data is filtered and transformed for avante compatibility:

1. **Capability Filtering**: Only includes models with `capabilities.type == "chat"`
2. **Paygo Exclusion**: Excludes models ending with "paygo"
3. **Policy Validation**: Checks that model policy is enabled
4. **Data Transformation**: Converts to avante's model format:
   ```lua
   {
     id = model.id,
     display_name = model.name,
     name = "copilot/" .. model.name .. " (" .. model.id .. ")",
     provider_name = "copilot",
     tokenizer = model.capabilities.tokenizer,
     max_input_tokens = model.capabilities.limits.max_prompt_tokens,
     max_output_tokens = model.capabilities.limits.max_output_tokens,
     policy = model.policy.state == "enabled",
     version = model.version,
   }
   ```

### Model Caching

Results are cached in `M._model_list_cache` to avoid repeated API calls during the session.

## Request Construction

### Headers and Authentication

Every request includes Copilot-specific headers:

```lua
headers = {
  ["Authorization"] = "Bearer " .. M.state.github_token.token,
  ["Copilot-Integration-Id"] = "vscode-chat",
  ["Editor-Version"] = "Neovim/{major}.{minor}.{patch}",
  ["Content-Type"] = "application/json"
}
```

### Token Validation

Before each request, the provider ensures token validity:

```lua
-- Synchronous token refresh if expired
H.refresh_token(false, false)
```

### OpenAI Compatibility

Despite the OAuth complexity, requests maintain OpenAI format compatibility:

```lua
body = {
  model = provider_conf.model,
  messages = self:parse_messages(prompt_opts),
  stream = true,
  tools = tools, -- Transformed from avante's tool format
}
```

## Setup and Initialization

### Validation

The provider validates Copilot availability before setup:

```lua
function M.is_env_set()
  local ok = pcall(function() H.get_oauth_token() end)
  return ok
end
```

### Initialization Process

1. **OAuth Token Discovery**: Locates existing Copilot installation
2. **Token File Loading**: Attempts to load cached GitHub token
3. **Timer Management**: Sets up refresh timers with process coordination
4. **File Watching**: Monitors token file for external changes
5. **Tokenizer Setup**: Initializes tokenizer for the default model

### Cleanup

Proper cleanup on Neovim exit:

- Stops all timers
- Removes lockfiles if process was the manager
- Closes file watchers
- Registered via `VimLeavePre` autocmd

## Security Considerations

- **Token Isolation**: Each provider instance manages its own token state
- **File Permissions**: Relies on system file permissions for token security
- **Process Coordination**: Prevents token corruption through lockfile mechanism
- **Automatic Expiry**: Tokens have built-in expiration for security

This architecture allows avante to seamlessly integrate with GitHub Copilot while handling the complexity of OAuth authentication, dynamic endpoint discovery, and multi-model support behind a unified interface.

# magenta.nvim

```
  ___ ___
/' __` __`\
/\ \/\ \/\ \
\ \_\ \_\ \_\
 \/_/\/_/\/_/
 magenta is for agentic flow
```

Magenta provides transparent tools to empower AI workflows in neovim. It allows fluid shifting of control between the developer and the AI, from targeted context-powered inline edits to AI automation and agent-led feature planning and development.

Developed by [dlants.me](https://dlants.me): I was tempted by other editors due to lack of high-quality agentic coding support in neovim. I missed neovim a lot, though, so I decided to go back and implement my own. I now happily code in neovim using magenta, and find that it's just as good as cursor, windsurf, ampcode & claude code.

I sometimes write about AI, neovim and magenta specifically:

- [AI whiplash, and neovim in the age of AI](https://dlants.me/ai-whiplash.html)
- [AI is not mid](https://dlants.me/ai-mid.html)

**Note**: I mostly develop using the Anthropic provider, so Claude Sonnet 3.7 or 4 are recommended. Other providers are supported but may be less stable. Contributions welcome!

📖 **Documentation**: Run `:help magenta.nvim` in Neovim for complete documentation.

## Demos

![next-edit-prediction July 2025](https://github.com/user-attachments/assets/2bebf6bb-9552-4396-94ce-f3f694b7265d)

![completion commands (July 2025)](https://github.com/user-attachments/assets/70eb1ddc-a592-47cb-a803-19414829c5d2)

[![June 2025 demo](https://img.youtube.com/vi/W_YctNT20NQ/0.jpg)](https://www.youtube.com/watch?v=W_YctNT20NQ)

## Features

- Chat sidebar with multi-threading support
- Inline edits with visual selection support
- Edit prediction based on recent changes
- Sub-agents for parallel task processing
- Web search with citations
- MCP (Model Context Protocol) support
- Smart context tracking with automatic diffing
- Prompt caching for efficiency

## Roadmap

- Local code embedding & indexing for semantic code search

# Updates

<details>
<summary>Recent updates (click to expand)</summary>

## Dec 2025

- Enhanced command permissions system with argument validation and path checking
- Improved file discovery with `rg` and `fd` support

## Nov 2025

- System reminders for persistent context
- Skills support (`.claude/skills` directory)

## Aug 2025

- PDF page-by-page reading
- Claude Max OAuth authentication
- Configurable chime volume
- `@fork` for thread forking with context retention

## Jul 2025

- Edit prediction (`<S-C-l>`)
- Input buffer completions with nvim-cmp
- Thinking/reasoning support
- Remote MCP support (HTTP/SSE)
- Fast models and `@fast` modifier
- Inline edit replay (`<leader>m.`)
- `spawn_foreach` for parallel sub-agents

## Jun 2025

- Sub-agents for parallel task delegation
- Image and PDF support
- Copilot provider

## May 2025

- Thread compaction/forking
- Smart context diffing
- Streaming tool previews
- Web search and citations

## Earlier

- [![Jan 2025 demo](https://img.youtube.com/vi/BPnUO_ghMJQ/0.jpg)](https://www.youtube.com/watch?v=BPnUO_ghMJQ)
- [![Dec 2024 demo](https://img.youtube.com/vi/i4YYvZwCMxM/0.jpg)](https://www.youtube.com/watch?v=i4YYvZwCMxM)

</details>

# Installation

**Requirements:** Node.js v20+ (`node --version`), [nvim-cmp](https://github.com/hrsh7th/nvim-cmp)

**Recommended:** [fd](https://github.com/sharkdp/fd) and [ripgrep](https://github.com/BurntSushi/ripgrep) for better file discovery

## Using lazy.nvim

```lua
{
    "dlants/magenta.nvim",
    lazy = false,
    build = "npm ci --production",
    opts = {},
},
```

## Using vim-plug

```lua
local vim = vim
local Plug = vim.fn['plug#']

vim.call('plug#begin')
Plug('dlants/magenta.nvim', {
  ['do'] = 'npm ci --production',
})
vim.call('plug#end')

require('magenta').setup({})
```

# Configuration

For complete configuration documentation, run `:help magenta-config` in Neovim.

## Quick Setup

```lua
require('magenta').setup({
  profiles = {
    {
      name = "claude-sonnet",
      provider = "anthropic",
      model = "claude-sonnet-4-5",
      fastModel = "claude-haiku-4-5",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    }
  }
})
```

## Supported Providers

- **anthropic** - Claude models via [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript)
- **openai** - GPT models via [OpenAI SDK](https://github.com/openai/openai-node)
- **bedrock** - Claude via [AWS Bedrock](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-bedrock-runtime/)
- **ollama** - Local models via [Ollama](https://ollama.com)
- **copilot** - Via GitHub Copilot subscription (no API key needed)

See `:help magenta-providers` for detailed provider configuration.

## Project Settings

Create `.magenta/options.json` for project-specific configuration:

```json
{
  "profiles": [...],
  "autoContext": ["README.md", "docs/*.md"],
  "skillsPaths": [".claude/skills"],
  "mcpServers": { ... }
}
```

See `:help magenta-project-settings` for details.

# Usage

| Keymap       | Description                    |
| ------------ | ------------------------------ |
| `<leader>mt` | Toggle chat sidebar            |
| `<leader>mf` | Pick files to add to context   |
| `<leader>mi` | Start inline edit              |
| `<leader>mn` | Create new thread              |
| `<S-C-l>`    | Trigger/accept edit prediction |

**Input commands:** `@fork`, `@file:`, `@diff:`, `@diag`, `@buf`, `@qf`, `@fast`

For complete documentation:

- `:help magenta-commands` - All commands and keymaps
- `:help magenta-input-commands` - Input buffer @ commands
- `:help magenta-tools` - Tools and sub-agents
- `:help magenta-mcp` - MCP server configuration

# Why it's cool

- It uses the new [rpc-pased remote plugin setup](https://github.com/dlants/magenta.nvim/issues/1). This means more flexible plugin development (can easily use both lua and typescript), and no need for `:UpdateRemotePlugins`! (h/t [wallpants](https://github.com/wallpants/bunvim)).
- The state of the plugin is managed via an elm-inspired architecture (The Elm Architecture or [TEA](https://github.com/evancz/elm-architecture-tutorial)) [code](https://github.com/dlants/magenta.nvim/blob/main/node/tea/tea.ts). I think this makes it fairly easy to understand and lays out a clear pattern for extending the feature set, as well as [eases testing](https://github.com/dlants/magenta.nvim/blob/main/node/chat/chat.spec.ts). It also unlocks some cool future features (like the ability to persist a structured chat state into a file).
- I spent a considerable amount of time figuring out a full end-to-end testing setup. Combined with typescript's async/await, it makes writing tests fairly easy and readable. The plugin is already fairly well-tested [code](https://github.com/dlants/magenta.nvim/blob/main/node/magenta.spec.ts#L8).
- In order to use TEA, I had to build a VDOM-like system for rendering text into a buffer. This makes writing view code declarative. [code](https://github.com/dlants/magenta.nvim/blob/main/node/tea/view.ts#L141) [example defining a tool view](https://github.com/dlants/magenta.nvim/blob/main/node/tools/getFile.ts#L139)
- We can leverage existing sdks to communicate with LLMs, and async/await to manage side-effect chains, which greatly speeds up development. For example, streaming responses was pretty easy to implement, and I think is typically one of the trickier parts of other LLM plugins. [code](https://github.com/dlants/magenta.nvim/blob/main/node/anthropic.ts#L49)
- Smart prompt caching. Pinned files only move up in the message history when they change, which means the plugin is more likely to be able to use caching. I also implemented anthropic's prompt caching [pr](https://github.com/dlants/magenta.nvim/pull/30) using an cache breakpoints.
- I made an effort to expose the raw tool use requests and responses, as well as the stop reasons and usage info from interactions with each model. This should make debugging your workflows a lot more straightforward.
- Robust file snapshots system automatically captures file state before edits, allowing for accurate before/after comparison and better review experiences.

# How is this different from other coding assistant plugins?

I think the closest plugins to this one are [avante.nvim](https://github.com/yetone/avante.nvim) and [codecompanion.nvim](https://github.com/olimorris/codecompanion.nvim)

## compared to codecompanion:

Codecompanion has a single buffer, while magenta.nvim has separate input & display buffers. This makes it easier to add some interactivity to the display buffer (since it's not directly editable). I think this makes it nicer for situations when the LLM uses multiple tools at once. So for example, in codecompanion when the LLM needs permission to open a file, or proposes a change, this takes over your editor, which isn't a nice workflow when the tool needs to edit multiple files.

## compared to avante:

I think it's fairly similar. However, magenta.nvim is written in typescript and uses the sdks to implement streaming, which I think makes it more stable. I think the main advantage is the architecture is very clean so it should be easy to extend the functionality. Between typescript, sdks and the architecture, I think my velocity is really high.

## compared to both:

magenta.nvim includes capabilities that neither plugin offers:

- **Web search tools**: Agents can search the internet for current information, documentation, and solutions, and cite these in their responses.
- **Sub-agents**: Complex tasks can be broken down and delegated to specialized agents that work in parallel with focused context and system prompts.
- **User-friendly, context-aware inline edits**: apply inline edits at a cursor position or to a selection. Dot-repeat to replay promtps against new locations.
- **Smart context tracking**: The plugin automatically tracks the state of files on disk, in buffers, and what the agent has seen, sending only diffs when files change. This enables better cache utilization and more efficient communication while sending only diffs to the agent.

# Contributions

See [the contributions guide](https://github.com/dlants/magenta.nvim/blob/main/CONTRIBUTING.md)

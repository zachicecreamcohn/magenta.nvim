# magenta.nvim

```
   ________
  ╱        ╲
 ╱         ╱
╱         ╱
╲__╱__╱__╱
Magenta is for agents.
```

`magenta.nvim` is a plugin for leveraging LLM agents in neovim. It provides a chat window where you can talk to your AI coding assistant, as well as tools to populate context and perform inline edits. It's similar to copilot agent, claude code, cursor compose, ampcode or windsurf.

(Developed by [dlants.me](https://dlants.me). I was tempted by other editors due to lack of high-quality agentic coding support in neovim. I missed neovim a lot, though, so I decided to go back and implement my own. I now happily code in neovim using magenta, and find that it's just as good!)

(Note - I mostly develop using the Anthropic provider, so claude sonnet 3.7 or 4 are recommended. The OpenAI provider is supported, but with limitations. Contributions are welcome! See for example https://github.com/dlants/magenta.nvim/issues/82 and https://github.com/dlants/magenta.nvim/issues/84 )

# Roadmap

- Sub-agents. A new tool where the agent can delegate tasks to sub-agents with a specified toolset. Similar to claude code
- MCP support
- local code embedding & indexing via chroma db, to support a semantic code search tool

# Updates

## May 2025

I implemented thread compaction that intelligently analyzes your next prompt and extracts only the relevant parts of the conversation history. This makes it easier to continue long conversations without hitting context limits while ensuring all important information is preserved. I also updated the magenta header to give you an estimate of the token count for your current conversation.

I updated the architecture around context following. We now track the state of the file on disk, and the buffer, as well as the current view that the agent has of the file. When these diverge, we send just the diff of the changes to the agent. This allows for better use of the cache, and more efficient communication since we do not have to re-send the full file contents when a small thing changes.

I updated the architecture around streaming, so we now process partial tool calls, which means we can preview Insert and Replace commands gradually as they stream in. This makes the tool feel a lot more responsive. I also added support for anthropic web search and citations!

I made a significant architectural shift in how magenta.nvim handles edits. Instead of merely proposing changes that require user confirmation, the agent can now directly apply edits to files with automatic snapshots for safety. Combined with the recent PR that implemented robust bash command execution, this creates a powerful iteration loop capability: agents can now modify files, run tests through bash, analyze results, and make further changes - all without user intervention.

I also started implementing multi-thread support, a basic version of which is now available.

<details>
<summary>Previous updates</summary>

## Jan 2025

[![video of Jan 2025 update](https://img.youtube.com/vi/BPnUO_ghMJQ/0.jpg)](https://www.youtube.com/watch?v=BPnUO_ghMJQ)

- inline mode
- context management
- prompt caching
- port to node

## Dec 2024

[![video demo of the plugin](https://img.youtube.com/vi/i4YYvZwCMxM/0.jpg)](https://www.youtube.com/watch?v=i4YYvZwCMxM)

- chat window
- tools
- context pinning
- architecture overview
</details>

# Installation

Make sure you have [node](https://nodejs.org/en/download) installed, at least `v20`:

```
node --version
```

The plugin uses profiles to configure provider access. Each profile specifies:

- name: identifier for the profile
- provider: "anthropic", "openai", "bedrock".
- model: the specific model to use.
- apiKeyEnvVar: environment variable containing the API key
- baseUrl: (optional) custom API endpoint

## Using lazy.nvim

```lua
{
    "dlants/magenta.nvim",
    lazy = false, -- you could also bind to <leader>mt
    build = "npm install --frozen-lockfile",
    opts = {},
},
```

## Using vim-plug

```lua
local vim = vim
local Plug = vim.fn['plug#']

vim.call('plug#begin')
Plug('dlants/magenta.vim', {
  ['do'] = 'npm install --frozen-lockfile',
})
vim.call('plug#end')

require('magenta').setup()
```

# Config

<details>
<summary>Default options</summary>

```lua
require('magenta').setup({
  profiles = {
    {
      name = "claude-3-7",
      provider = "anthropic",
      model = "claude-3-7-sonnet-latest",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    },
    {
      name = "gpt-4o",
      provider = "openai",
      model = "gpt-4o",
      apiKeyEnvVar = "OPENAI_API_KEY"
    }
  },
  -- open chat sidebar on left or right side
  sidebarPosition = "left",
  -- can be changed to "telescope" or "snacks"
  picker = "fzf-lua",
  -- enable default keymaps shown below
  defaultKeymaps = true,
  -- keymaps for the sidebar input buffer
  sidebarKeymaps = {
    normal = {
      ["<CR>"] = ":Magenta send<CR>",
    }
  },
  -- keymaps for the inline edit input buffer
  -- if keymap is set to function, it accepts a target_bufnr param
  inlineKeymaps =  {
    normal = {
      ["<CR>"] = function(target_bufnr)
        vim.cmd("Magenta submit-inline-edit " .. target_bufnr)
      end,
    },
  }
})
```

</details>

If `default_keymaps` is set to true, the plugin will configure the following global keymaps:

<details>
<summary>Default keymaps</summary>

```lua
local Actions = require("magenta.actions")

vim.keymap.set(
  "n",
  "<leader>mn",
  ":Magenta new-thread<CR>",
  {silent = true, noremap = true, desc = "Create new Magenta thread"}
)

vim.keymap.set(
  "n",
  "<leader>mc",
  ":Magenta clear<CR>",
  {silent = true, noremap = true, desc = "Clear Magenta state"}
)

vim.keymap.set(
  "n",
  "<leader>ma",
  ":Magenta abort<CR>",
  {silent = true, noremap = true, desc = "Abort current Magenta operation"}
)

vim.keymap.set(
  "n",
  "<leader>mt",
  ":Magenta toggle<CR>",
  {silent = true, noremap = true, desc = "Toggle Magenta window"}
)

vim.keymap.set(
  "n",
  "<leader>mi",
  ":Magenta start-inline-edit<CR>",
  {silent = true, noremap = true, desc = "Inline edit"}
)

vim.keymap.set(
  "v",
  "<leader>mi",
  ":Magenta start-inline-edit-selection<CR>",
  {silent = true, noremap = true, desc = "Inline edit selection"}
)

vim.keymap.set(
  "v",
  "<leader>mp",
  ":Magenta paste-selection<CR>",
  {silent = true, noremap = true, desc = "Send selection to Magenta"}
)

vim.keymap.set(
  "n",
  "<leader>mb", -- like "magenta buffer"?
  Actions.add_buffer_to_context,
  { noremap = true, silent = true, desc = "Add current buffer to Magenta context" }
)

vim.keymap.set(
  "n",
  "<leader>mf",
  Actions.pick_context_files,
  { noremap = true, silent = true, desc = "Select files to add to Magenta context" }
)

vim.keymap.set(
  "n",
  "<leader>mp",
  Actions.pick_provider,
  { noremap = true, silent = true, desc = "Select provider and model" }
)
```

</details>

<details>
<summary>Set up fzf-lua as your selector</summary>

In order to use fzf-lua as your selector for certain commands, like `<leader>mp` for `:Magenta provider`, you should
set it as the default selector for neovim, by running `register_ui_select` at some point during initialization.

```lua
  {
    "ibhagwan/fzf-lua",
    lazy = false,
    config = function()
      require("fzf-lua").setup({
       -- ...
      })
      require("fzf-lua").register_ui_select()
    end,
  -- ...
    }
```

</details>

# Usage

### Chat

- `<leader>mt` is for `:Magenta toggle`. This will open a sidebar where you can chat with the model. You can add files to the context with `Magenta context-files` (`<leader>mf`), or paste your current visual selection with `Magenta paste-selection` (`<leader>mp`)

### Multi-threading

Magenta now supports multiple concurrent chat threads:

- `<leader>mn` is for `:Magenta new-thread`. This creates a new independent chat thread.
- When in the display buffer, press `-` to view the thread overview screen.
- Current active thread is highlighted with `*` in the thread list.
- Press `Enter` on any thread in the overview to make it active.

### Inline edit

- `<leader>mi` is for `:Magenta start-inline-edit`, or `start-inline-edit-selection` in visual mode. This will bring up a new split where you can write a prompt to edit the current buffer. Magenta will force a find-and-replace tool use for normal mode, or force a replace tool use for the selection in visual mode.

Inline edit uses your chat history so far, so a great workflow is to build up context in the chat panel, and then use it to perform inline edits in a buffer.

### display buffer

The display buffer is not modifiable, however you can interact with some parts of the display buffer by pressing `<CR>`. For example, you can expand the tool request and responses to see their details, and you can trigger a diff to appear on file edits.

- hit `enter` on a [review] message to pull up the diff to try and edit init
- hit `enter` on a tool to see the details of the request & result. Enter again on any part of the expanded view to collapse it.
- hit `enter` on a context file to open it
- hit `d` on a context file to remove it
- hit `enter` on a diff to see a detailed side-by-side comparison between the original file snapshot and proposed changes
- hit `t` on a running bash command to terminate it (SIGTERM)

### Thread compaction

Thread compaction allows you to retain relevant pieces of context as you shift focus to new tasks.

1. Type `@compact` followed by your next prompt in the input buffer
2. Press Enter to send the compaction request
3. Magenta will:
   - Analyze your next prompt to understand what you're trying to achieve
   - Extract only the parts of the current thread directly relevant to your prompt
   - Identify which context files are still needed
   - Create a new thread with this focused context and your prompt

This smart compaction ensures that only information specifically relevant to your next task is carried forward, while irrelevant parts of the conversation are summarized or removed.

Example usage:

```
@compact Now let's implement unit tests for the new feature we just discussed
```

### profiles

The first profile in your `profiles` list is used as the default when the plugin starts. You can switch between profiles using `:Magenta pick-provider` (bound to `<leader>mp` by default).

For example, you can set up multiple profiles for different providers or API endpoints:

```lua
profiles = {
  {
    name = "claude-3-7",
    provider = "anthropic",
    model = "claude-3-7-sonnet-latest",
    apiKeyEnvVar = "ANTHROPIC_API_KEY"
  },
  {
    name = "custom",
    provider = "anthropic",
    model = "claude-3-7-sonnet-latest",
    apiKeyEnvVar = "CUSTOM_API_KEY_ENV_VAR",
    baseUrl = "custom anthropic endpoint"
  }
}
```

Currently supported providers are `openai`, `anthropic`, `bedrock`, and `ollama`. The `model` parameter must be compatible with the SDK used for each provider:

- For `anthropic`: [Anthropic Node SDK](https://github.com/anthropics/anthropic-sdk-typescript) - supports models like `claude-3-7-sonnet-latest`, `claude-3-5-sonnet-20240620`
- For `openai`: [OpenAI Node SDK](https://github.com/openai/openai-node) - supports models like `gpt-4o`, `o1`
- For `bedrock`: [AWS SDK for Bedrock Runtime](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-bedrock-runtime/) - supports models like `anthropic.claude-3-5-sonnet-20241022-v2:0`
- For `ollama`: [Ollama Node SDK](https://github.com/ollama/ollama-js) - supports models like `qwen3:14b` which have been insalled locally. ([Ollama models](https://ollama.com/search))

Any provider that has a node SDK and supports tool use should be easy to add. Contributions are welcome.

### command allowlist

Magenta includes a security feature for the bash_command tool that requires user approval before running shell commands. To improve the workflow, you can configure a list of regex patterns that define which commands are pre-approved to run without confirmation.

The `commandAllowlist` option takes an array of regex patterns. When the LLM tries to execute a shell command, it's checked against these patterns. If any pattern matches, the command runs without approval. Otherwise, you'll be prompted to allow or deny it.

Regex patterns should be carefully designed to avoid security risks. You can find the default allowlist patterns in [lua/magenta/options.lua](lua/magenta/options.lua).

#### terminating running commands

When a bash command is running, you can press the `t` key in the display buffer while your cursor is over the executing command to terminate it immediately. This is useful for long-running commands or commands that have entered an undesired state. When terminated, the command will display a message indicating it was terminated by user with SIGTERM.

## tools available to the LLM

See the most up-to-date list of implemented tools [here](https://github.com/dlants/magenta.nvim/tree/main/node/tools).

- [x] run bash command
- [x] list a directory (only in cwd, excluding hidden and gitignored files)
- [x] list current buffers (only buffers in cwd, excluding hidden and gitignored files)
- [x] get the contents of a file (requires user approval if not in cwd or hidden/gitignored)
- [x] get lsp diagnostics
- [x] get lsp references for a symbol in a buffer
- [x] get lsp "hover" info for a symbol in a buffer
- [x] insert or replace in a file with automatic file snapshots for comparison

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

I think it's fairly similar. However, magenta.nvim is written in typescript and uses the sdks to implement streaming, which I think makes it more stable. I think the main advantage is the architecture is very clean so it should be easy to extend the functionality. Between typescript, sdks and the architecture, I think my velocity is pretty high. I haven't used avante in a while so I'm not sure how close I got feature-wise, but it should be fairly close, and only after a couple of weeks of development time.

## compared to both:

AFAIK both avante and codecompanion roll their own tool system, so the tools are defined in-prompt, and they do the parsing of the tool use themselves. I'm instead using the providers tool capabilities, like the one in [anthropic](https://docs.anthropic.com/en/docs/build-with-claude/tool-use). In practice I think this makes the tool use a lot more robust.

I'm not doing any treesitter analysis of symbols, dependencies, or repository summarization / repomap construction. As I mentioned in the intro, I'm opting instead to rely on the agent to explore the repo using the tools available to it. Right now that's occasionally worse than the repomap approach, but I think with time it will matter less and less.

Another thing that's probably glaringly missing is model selection and customization of keymappings, etc... I'll probably do some of this eventually, but if you use a different picker / completion plugin, or you would like to make something configurable that is not currently, I would welcome contributions.

# Contributions

See [the contributions guide](https://github.com/dlants/magenta.nvim/blob/main/CONTRIBUTING.md)

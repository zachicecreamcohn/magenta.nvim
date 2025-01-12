# magenta.nvim

[![video demo of the plugin](https://img.youtube.com/vi/i4YYvZwCMxM/0.jpg)](https://www.youtube.com/watch?v=i4YYvZwCMxM)

magenta.nvim is a plugin for leveraging LLM agents in neovim. Think cursor-compose, cody or windsurf.

Rather than writing complex code to compress your repo and send it to the LLM (like a repomap, etc...), magenta is built around the idea that the LLM can ask for what it needs to via tools.
Flagship models will continue to get better at tools use, and as this happens, the gap between tools like magenta and other agentic tools will grow smaller.

# Installation (lazy.nvim)

Make sure you have [node](https://nodejs.org/en/download) installed, at least `v20`:

```
node --version
```

```lua
{
    "dlants/magenta.nvim",
    lazy = false, -- you could also bind to <leader>mt
    build = "npm install --frozen-lockfile",
    opts = {},
},
```

The plugin will look for configuration for providers in the following env variables:

- anthropic: ANTHROPIC_API_KEY
- openai: OPENAI_API_KEY, OPENAI_BASE_URL

# Usage

## keymaps

Global keymaps are set [here](https://github.com/dlants/magenta.nvim/blob/main/lua/magenta/init.lua#L12).

Input and display buffer keymaps are set [here](https://github.com/dlants/magenta.nvim/blob/main/node/sidebar.ts#L87).

Commands are all nested under `:Magenta <cmd>`, and can be found [here](https://github.com/dlants/magenta.nvim/blob/main/node/magenta.ts#L54).

TLDR:

- `<leader>mt` is for `:Magenta toggle`, will toggle the sidebar on and off.
- `<leader>mp` is for `:Magenta paste-selection`. In visual mode it will take the current selection and paste it into the input buffer.
- `<leader>mc` is for `:Magenta context-files` with your _current_ file. It will pin the current file to your context.
- `<leader>mf` is for `:Magenta context-files` it allows you to select files via fzf-lua, and will pin those files to your context. This requires that fzf-lua is installed.
- `<leader>mc` is for `:Magenta clear`, which will clear the current chat.
- `<leader>ma` is for `:Magenta abort`, which will abort the current in-flight request.

The display buffer is not modifiable, however you can interact with some parts of the display buffer by pressing `<CR>`. For example, you can expand the tool request and responses to see their details, and you can trigger a diff to appear on file edits.

- hit enter on a [review] message to pull up the diff to try and edit init
- hit enter on a tool to see the details of the request & result. Enter again on any part of the expanded view to collapse it.
- hit enter on a piece of context to remove it

## tools available to the LLM

See the most up-to-date list of implemented tools [here](https://github.com/dlants/magenta.nvim/tree/main/node/tools).

- [x] list a directory (only in cwd, excluding hidden and gitignored files)
- [x] list current buffers (only buffers in cwd, excluding hidden and gitignored files)
- [x] get the contents of a file (requires user approval if not in cwd or hidden/gitignored)
- [x] get lsp diagnostics
- [x] get lsp "hover" info for a symbol in a buffer
- [x] insert or replace in a file (the user can then review the changes via neovim's [diff mode](https://neovim.io/doc/user/diff.html))

# Why it's cool

- It uses the new [rpc-pased remote plugin setup](https://github.com/dlants/magenta.nvim/issues/1). This means more flexible plugin development (can easily use both lua and typescript), and no need for `:UpdateRemotePlugins`! (h/t [wallpants](https://github.com/wallpants/bunvim)).
- The state of the plugin is managed via an elm-inspired architecture (The Elm Architecture or [TEA](https://github.com/evancz/elm-architecture-tutorial)) [code](https://github.com/dlants/magenta.nvim/blob/main/node/tea/tea.ts). I think this makes it fairly easy to understand and lays out a clear pattern for extending the feature set, as well as [eases testing](https://github.com/dlants/magenta.nvim/blob/main/node/chat/chat.spec.ts). It also unlocks some cool future features (like the ability to persist a structured chat state into a file).
- I spent a considerable amount of time figuring out a full end-to-end testing setup. Combined with typescript's async/await, it makes writing tests fairly easy and readable. The plugin is already fairly well-tested [code](https://github.com/dlants/magenta.nvim/blob/main/node/magenta.spec.ts#L8).
- In order to use TEA, I had to build a VDOM-like system for rendering text into a buffer. This makes writing view code declarative. [code](https://github.com/dlants/magenta.nvim/blob/main/node/tea/view.ts#L141) [example defining a tool view](https://github.com/dlants/magenta.nvim/blob/main/node/tools/getFile.ts#L139)
- we can leverage existing sdks to communicate with LLMs, and async/await to manage side-effect chains, which greatly speeds up development. For example, streaming responses was pretty easy to implement, and I think is typically one of the trickier parts of other LLM plugins. [code](https://github.com/dlants/magenta.nvim/blob/main/node/anthropic.ts#L49)

# How is this different from other coding assistant plugins?

I think the closest plugins to this one are [avante.nvim](https://github.com/yetone/avante.nvim) and [codecompanion.nvim](https://github.com/olimorris/codecompanion.nvim)

## compared to codecompanion:

Codecompanion has a single buffer, while magenta.nvim has separate input & display buffers. This makes it easier to add some interactivity to the display buffer (since it's not directly editable). I think this makes it nicer for situations when the LLM uses multiple tools at once. So for example, in codecompanion when the LLM needs permission to open a file, or proposes a change, this takes over your editor, which isn't a nice workflow when the tool needs to edit multiple files.

## compared to avante:

I think it's fairly similar. However, magenta.nvim is written in typescript and uses the sdks to implement streaming, which I think makes it more stable. I think the main advantage is the architecture is very clean so it should be easy to extend the functionality. Between typescript, sdks and the architecture, I think my velocity is pretty high. I haven't used avante in a while so I'm not sure how close I got feature-wise, but it should be fairly close, and only after a couple of weeks of development time.

## compared to both:

AFAIK both avante and codecompanion roll their own tool system, so the tools are defined in-prompt, and they do the parsing of the tool use themselves. I'm instead using the providers tool capabilities, like the one in [anthropic](https://docs.anthropic.com/en/docs/build-with-claude/tool-use). In practice I think this makes the tool use a lot more robust.

One feature that I don't have yet is "inline mode", but it's definitely on my roadmap and shouldn't be hard to add. [#16](https://github.com/dlants/magenta.nvim/issues/16).

I'm not doing any treesitter analysis of symbols, dependencies, or repository summarization / repomap construction. As I mentioned in the intro, I'm opting instead to rely on the agent to explore the repo using the tools available to it. Right now that's occasionally worse than the repomap approach, but I think with time it will matter less and less.

Another thing that's probably glaringly missing is model selection and customization of keymappings, etc... I'll probably do some of this soon.

# Contributions

See [the contributions guide](https://github.com/dlants/magenta.nvim/blob/main/CONTRIBUTING.md)

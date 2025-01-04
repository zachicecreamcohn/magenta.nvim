# magenta.nvim

<img width="1376" alt="Screenshot 2024-12-22 at 3 40 02 PM" src="https://github.com/user-attachments/assets/df372c55-8c30-468d-8bd2-47047534fe92" />
<img width="1658" alt="Screenshot 2024-12-22 at 4 22 44 PM" src="https://github.com/user-attachments/assets/45c0e90a-0944-4e9e-8f2b-c0d779542d45" />

magenta.nvim is a plugin for leveraging LLM agents in neovim. Think cursor-compose, cody or windsurf, but open source.

Rather than writing complex code to compress your repo and send it to the LLM (like a repomap, etc...), magenta is built around the idea that the LLM can get ask for what it needs to via tools. Flagship models will continue to get better at tools use.

Alongside general tools like reading or editing a file, and listing a directory, this plugin also grants the LLM access to the language server via nvim's lsp client.

See the [implemented tools](https://github.com/dlants/magenta.nvim/tree/main/bun/tools).

# Installation (lazy.nvim)

Install [bun](https://bun.sh/)

```lua
{
    "dlants/magenta.nvim",
    lazy = false, -- you could also bind to <leader>m
    build = "bun install --frozen-lockfile",
    config = function()
      require('magenta').setup()
    end
},
```

The plugin will look for env variables for providers in the following env variables:
anthropic: ANTHROPIC_API_KEY
openai: OPENAI_API_KEY

# Usage

By default, `<leader>m` will toggle the input and display the magenta side panel. The chat window submits your query on `<CR>` in normal mode.

The display window is not modifiable, however you can interact with some parts of the chat by pressing `<CR>`. For example, you can expand the tool request and responses to see their details, and you can trigger a diff to appear on file edits.

Currently there's not a way to invoke context-gathering commands yourself (#TODO), but you can ask the LLM to gather context via tools. For example: "I have some buffers open, could you see if you can change abc to xyz?".

You can see

# Why it's cool

Some cool things I've gotten to work so far:

- It uses [bun](https://bun.sh/) for faster startup, a lower memory footprint, and ease of development with Typescript.
- It uses the new [rpc-pased remote plugin setup](https://github.com/dlants/magenta.nvim/issues/1). This means more flexible plugin development (can easily use both lua and typescript), and no need for :UpdateRemotePlugins! (h/t [wallpants](https://github.com/wallpants/bunvim)).
- The state of the plugin is managed via an elm-inspired architecture (The Elm Architecture or [TEA](https://github.com/evancz/elm-architecture-tutorial)) [code](https://github.com/dlants/magenta.nvim/blob/main/bun/tea/tea.ts). This makes it very predictable for code generation, and makes adding new functionality really easy and robust, as well as [eases testing](https://github.com/dlants/magenta.nvim/blob/main/bun/chat/chat.spec.ts) and makes some cool future features possible (like the ability to save a chat state into a file and restore previous chats from file on startup).
- In order to use TEA, I had to build a VDOM-like system for rendering text into a buffer. [code](https://github.com/dlants/magenta.nvim/blob/main/bun/tea/view.ts#L141) [example defining a tool view](https://github.com/dlants/magenta.nvim/blob/main/bun/tools/getFile.ts#L139)
- since it's mostly written in Typescript, we can leverage existing libraries to communicate with LLMs, and async/await to manage side-effect chains, which greatly speeds up development [code](https://github.com/dlants/magenta.nvim/blob/main/bun/anthropic.ts#L49)

If you'd like to contribute, please reach out to me. My email is listed at my blog: dlants.me

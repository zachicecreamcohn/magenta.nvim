<img width="1376" alt="Screenshot 2024-12-22 at 3 40 02 PM" src="https://github.com/user-attachments/assets/df372c55-8c30-468d-8bd2-47047534fe92" />

magenta.nvim is a plugin for agent-assisted LLM development in neovim.

Rather than writing complex code to automatically provide context to the LLM, magenta is built around the idea that you can just expose tools to the LLM and have it decide what it needs to do. I'm banking on the fact that flagship models will get better and better at tool use, though eventually pairing this with a model that's tuned for tool use and editing 

See the tools available to the agent in https://github.com/dlants/magenta.nvim/tree/main/rplugin/node/magenta/src/tools

As of Dec 22, 2024, I've finished implementing some basic context gathering tools:
- list active buffers
- get file in cwd using relative filePath
- insert code into a buffer after a given line
- replace code in a buffer

I am currently working on granting the agent access to nvim's LSP for type definition, finding references, and reading diagnostics.

Some tools are automated and auto-respond without user intervention, while others require user approval.

Some cool things I've gotten to work so far:
- The state of the plugin is managed via an elm-inspired architecture (The Elm Architecture or [TEA](https://github.com/evancz/elm-architecture-tutorial)) [code](https://github.com/dlants/magenta.nvim/blob/main/rplugin/node/magenta/src/tea/tea.ts). This makes it very predictable for code generation, and makes adding new functionality really easy and robust, as well as [eases testing](https://github.com/dlants/magenta.nvim/blob/main/rplugin/node/magenta/src/chat/chat.spec.ts) and makes some cool future features possible (like the ability to save a chat state into a file and restore previous chats from file on startup).
- In order to use TEA, I had to build a VDOM-like system for rendering text into a buffer. [code](https://github.com/dlants/magenta.nvim/blob/main/rplugin/node/magenta/src/tea/view.ts#L141) [example defining a tool view](https://github.com/dlants/magenta.nvim/blob/main/rplugin/node/magenta/src/tools/getFile.ts#L139)
- since it's mostly written as a node rplugin, I can use libraries and promises to communicate to LLMs, and async/await to manage side-effect chains, which greatly speeds up development [code](https://github.com/dlants/magenta.nvim/blob/main/rplugin/node/magenta/src/anthropic.ts#L49)

If you'd like to contribute, please reach out to me. My email is listed at my blog: dlants.me

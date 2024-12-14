magenta.nvim is a plugin for agent-assisted LLM development in neovim.

Rather than writing complex code to automatically provide context to the LLM, magenta is built around the idea that you
can just expose tools to the LLM and have it decide what it needs to do.

The initial offering will start with basic tools:

- get_file
- list_directory
- edit file
- run terminal command

Eventually I'd like to add more advanced tools:

- list symbols for file
- list diagnostics
- get definition or "summary" info for a symbol
- find symbol references

The general idea is that some of these will be automated and not require user intervention, while others will require
user approval. (for example, getting the type definition of a symbol may be automated, while reading a dotfile will require
user permission).

I'm also hoping to eventually implement an inline diff / edit confirmation system like windsurf or avante.

This project is still in its early days and this is my first neovim plugin so it will probably be a while until it's useful to anyone. But I am investing some time in building a robust framework and testing system so that
it is easier to contribute to in the future. If you'd like to help, please reach out. You can find my contact info at my blog - dlants.me

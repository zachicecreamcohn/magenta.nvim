# A Neovim Plugin Template

![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/ellisonleao/nvim-plugin-template/lint-test.yml?branch=main&style=for-the-badge)
![Lua](https://img.shields.io/badge/Made%20with%20Lua-blueviolet.svg?style=for-the-badge&logo=lua)

A template repository for Neovim plugins.

## Using it

Via `gh`:

```
$ gh repo create my-plugin -p ellisonleao/nvim-plugin-template
```

Via github web page:

Click on `Use this template`

![](https://docs.github.com/assets/cb-36544/images/help/repository/use-this-template-button.png)

## Installation

Choose your preferred package manager:

### [lazy.nvim](https://github.com/folke/lazy.nvim)
```lua
{
    "denislantsman/magenta.nvim",
    dependencies = {
        "MunifTanjim/nui.nvim"
    }
}
```

### [packer.nvim](https://github.com/wbthomason/packer.nvim)
```lua
use {
    'denislantsman/magenta.nvim',
    requires = {
        'MunifTanjim/nui.nvim'
    }
}
```

### [vim-plug](https://github.com/junegunn/vim-plug)
```vim
Plug 'MunifTanjim/nui.nvim'
Plug 'denislantsman/magenta.nvim'
```

## Features and structure

- 100% Lua
- Github actions for:
  - running tests using [plenary.nvim](https://github.com/nvim-lua/plenary.nvim) and [busted](https://olivinelabs.com/busted/)
  - check for formatting errors (Stylua)
  - vimdocs autogeneration from README.md file
  - luarocks release (LUAROCKS_API_KEY secret configuration required)

## Requirements

- Neovim >= 0.8.0
- [nui.nvim](https://github.com/MunifTanjim/nui.nvim) - UI Component Library for Neovim

### Plugin structure

```
.
├── lua
│   ├── plugin_name
│   │   └── module.lua
│   └── plugin_name.lua
├── Makefile
├── plugin
│   └── plugin_name.lua
├── README.md
├── tests
│   ├── minimal_init.lua
│   └── plugin_name
│       └── plugin_name_spec.lua
```

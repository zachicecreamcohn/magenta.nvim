local root = vim.fn.getcwd()
local deps_path = root .. "/deps"

-- Ensure dependencies are installed
local function ensure_deps()
    if vim.fn.isdirectory(deps_path) == 0 then
        vim.fn.mkdir(deps_path, "p")
    end

    local deps = {
        ["plenary.nvim"] = "https://github.com/nvim-lua/plenary.nvim",
        ["nui.nvim"] = "https://github.com/MunifTanjim/nui.nvim"
    }

    for name, url in pairs(deps) do
        local dep_path = deps_path .. "/" .. name
        if vim.fn.isdirectory(dep_path) == 0 then
            print(string.format("Installing %s...", name))
            vim.fn.system({"git", "clone", "--depth", "1", url, dep_path})
        end
    end
end

ensure_deps()

-- Add plugin and deps to rtp
vim.opt.rtp:prepend(root)
vim.opt.rtp:prepend(deps_path .. "/plenary.nvim")
vim.opt.rtp:prepend(deps_path .. "/nui.nvim")

-- Load test framework
vim.cmd("runtime plugin/plenary.vim")
require("plenary.busted")

-- Setup plugin
require("magenta").setup()

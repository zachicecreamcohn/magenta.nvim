local M = {}

---@class Config
---@field sidebar_width number Width of the sidebar
---@field position string Position of the sidebar ("left" or "right")
-- Default configuration
local default_config = {
    sidebar_width = 30,
    position = "left"
}

-- Store the user's configuration
M.config = {}

-- Store the sidebar instance
local sidebar = nil

-- Initialize the plugin with user config
function M.setup(opts)
    M.config = vim.tbl_deep_extend("force", default_config, opts or {})

    -- Safely require nui components
    local ok, err = pcall(function()
        -- Try to load all required nui components
        local Popup = require("nui.popup")
        local Split = require("nui.split")

        -- Store the components globally in M for other modules to use
        M.components = {
            Popup = Popup,
            Split = Split
        }
    end)

    if not ok then
        vim.notify(
            "Failed to load nui.nvim components. Please ensure nui.nvim is installed.\nError: " .. err,
            vim.log.levels.ERROR
        )
        return
    end
end

-- Function to create and show the sidebar
function M.show_sidebar()
    if not M.components then
        vim.notify("Plugin not initialized. Please call require('magenta').setup()", vim.log.levels.ERROR)
        return
    end

    if sidebar then
        sidebar:unmount()
    end

    sidebar = M.components.Split({
        relative = "editor",
        position = M.config.position,
        size = M.config.sidebar_width,
        buf_options = {
            modifiable = true,
            readonly = false,
        },
        win_options = {
            wrap = false,
            number = false,
            cursorline = true,
        },
    })

    -- Mount the split
    sidebar:mount()

    -- Add some example content
    local content = { "Magenta Sidebar", "============", "", "Item 1", "Item 2", "Item 3" }
    vim.api.nvim_buf_set_lines(sidebar.bufnr, 0, -1, false, content)
end

-- Function to hide the sidebar
function M.hide_sidebar()
    if sidebar then
        sidebar:unmount()
        sidebar = nil
    end
end

-- Function to toggle the sidebar
function M.toggle_sidebar()
    if sidebar then
        M.hide_sidebar()
    else
        M.show_sidebar()
    end
end

return M

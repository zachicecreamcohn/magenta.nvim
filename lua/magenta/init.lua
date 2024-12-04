local log = require('magenta.log')

local M = {}

---@class Config
---@field sidebar_width number Width of the sidebar
---@field position string Position of the sidebar ("left" or "right")
---@field anthropic table Configuration for the Anthropic client
-- Default configuration
local default_config = {
  sidebar_width = 80,
  position = "left",
  anthropic = {
    api_key = nil, -- Will be fetched from environment if not set
    model = "claude-3-sonnet-20240229",
    system_prompt = "You are an AI assistant helping with code-related tasks in Neovim."
  }
}

-- Store the user's configuration
M.config = {}

-- Store the sidebar instance and components
local sidebar = nil
local input_area = nil
local main_area = nil
local anthropic_client = nil

-- Initialize the plugin with user config
function M.setup(opts)
  log.debug("Setting up magenta with opts:", opts)
  M.config = vim.tbl_deep_extend("force", default_config, opts or {})

  -- Initialize Anthropic client
  anthropic_client = require("magenta.anthropic").new(M.config.anthropic)

  -- Safely require nui components
  local ok, err = pcall(function()
    -- Try to load all required nui components
    local Layout = require("nui.layout")
    local Split = require("nui.split")

    -- Store the components globally in M for other modules to use
    M.components = {
      Layout = Layout,
      Split = Split
    }
    log.debug("Successfully loaded nui components")
  end)

  if not ok then
    log.error("Failed to load nui.nvim components:", err)
    vim.notify(
      "Failed to load nui.nvim components. Please ensure nui.nvim is installed.\nError: " .. err,
      vim.log.levels.ERROR
    )
    return
  end

  -- Add command to view logs
  vim.api.nvim_create_user_command("MagentaLogs", function()
    -- Get log file path
    local log_file = vim.fn.stdpath("cache") .. "/magenta.log"

    -- Open log file in a new split
    vim.cmd("vsplit " .. log_file)

    -- Configure buffer for logs
    local buf = vim.api.nvim_get_current_buf()
    vim.api.nvim_buf_set_option(buf, "buftype", "nofile")
    vim.api.nvim_buf_set_option(buf, "modifiable", true)

    -- Auto-reload setup
    local group = vim.api.nvim_create_augroup("MagentaLogs", { clear = true })
    vim.api.nvim_create_autocmd("BufEnter", {
      group = group,
      buffer = buf,
      callback = function()
        -- Read the file content
        local lines = vim.fn.readfile(log_file)
        -- Update buffer content
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
        -- Move cursor to end
        vim.api.nvim_win_set_cursor(0, { #lines, 0 })
      end
    })
  end, {})

  -- Register the MagentaSend command
  -- vim.api.nvim_create_user_command("MagentaSend", function()
  --   M.send_message()
  -- end, {})
end

-- Function to append text to the main area
---@param text string Text to append
local function append_to_main(text)
  if not main_area or not main_area.bufnr then
    log.error("Cannot append to main area - not initialized")
    return
  end

  local lines = vim.split(text, '\n', {})
  if #lines == 0 then return end

  local last_line = vim.api.nvim_buf_get_lines(main_area.bufnr, -2, -1, false)[1] or ""

  vim.api.nvim_buf_set_option(main_area.bufnr, 'modifiable', true)
  vim.api.nvim_buf_set_lines(main_area.bufnr, -2, -1, false, { last_line .. lines[1] })

  if #lines > 1 then
    vim.api.nvim_buf_set_lines(main_area.bufnr, -1, -1, false, vim.list_slice(lines, 2))
  end

  vim.api.nvim_buf_set_option(main_area.bufnr, 'modifiable', false)

  -- Scroll to bottom
  local final_line = vim.api.nvim_buf_line_count(main_area.bufnr)
  vim.api.nvim_win_set_cursor(main_area.winid, { final_line, 0 })
end

-- Function to send message to Anthropic
function M.send_message()
  if not input_area or not input_area.bufnr then
    log.error("Input area not initialized")
    vim.notify("Input area not initialized", vim.log.levels.ERROR)
    return
  end

  log.debug("Sending message from input area")
  -- Get input text
  local lines = vim.api.nvim_buf_get_lines(input_area.bufnr, 0, -1, false)
  local message = table.concat(lines, "\n")

  log.debug("Message content:", message)
  -- Clear input area
  vim.api.nvim_buf_set_lines(input_area.bufnr, 0, -1, false, { "" })

  -- Add user message to main area
  append_to_main("\nUser: " .. message .. "\n\nAssistant: ")

  -- Send to Anthropic with streaming
  anthropic_client:request({
    message = message,
    stream = true
  }, {
    callback = function(err, text)
      if err then
        log.error("Anthropic API error:", err)
        append_to_main("\nError: " .. err .. "\n")
        return
      end

      log.debug("Received stream text:", text)
      append_to_main(text)
    end,
    done = function()
      log.debug("Request completed")
    end
  })
end

-- Function to create and show the sidebar
function M.show_sidebar()
  if not M.components then
    log.error("Plugin not initialized")
    vim.notify("Plugin not initialized. Please call require('magenta').setup()", vim.log.levels.ERROR)
    return
  end

  log.debug("Showing sidebar")
  if sidebar then
    log.debug("Unmounting existing sidebar")
    sidebar:unmount()
  end

  local Layout = require("nui.layout")
  local Split = require("nui.split")

  main_area = Split({
    relative = "editor",
    size = M.config.sidebar_width,
    win_options = {
      wrap = true, -- Changed to true for better text display
      number = false,
      cursorline = true,
    },
  })

  input_area = Split({
    relative = "editor",
    size = M.config.sidebar_width,
    win_options = {
      wrap = true,
      number = false,
    },
  })

  sidebar = Layout(
    {
      relative = "editor",
      position = M.config.position,
      size = M.config.sidebar_width,
    },
    Layout.Box({
      Layout.Box(main_area, { size = "80%" }),
      Layout.Box(input_area, { size = "20%" }),
    }, { dir = "col" })
  )

  log.debug("Mounting sidebar")
  sidebar:mount()

  local content = { "Magenta Sidebar", "============", "", "Content 1" }
  vim.api.nvim_buf_set_lines(main_area.bufnr, 0, -1, false, content)
  vim.bo[main_area.bufnr].modifiable = false

  vim.api.nvim_buf_set_lines(input_area.bufnr, 0, -1, false, { "Enter text here..." })

  -- Set up buffer-local command in the input buffer
  log.debug("Setting up buffer-local command in input buffer")
  vim.api.nvim_buf_create_user_command(input_area.bufnr, "MagentaSend", function()
    M.send_message()
  end, {})
end

-- Function to hide the sidebar
function M.hide_sidebar()
  if sidebar then
    log.debug("Hiding sidebar")
    sidebar:unmount()
    sidebar = nil
    input_area = nil
    main_area = nil
  else
    log.debug("No sidebar to hide")
  end
end

return M

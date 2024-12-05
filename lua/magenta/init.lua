local log = require('magenta.log').log;

local M = {}

---@class Config
---@field sidebar_width number Width of the sidebar
---@field position string Position of the sidebar ("left" or "right")
---@field anthropic table Configuration for the Anthropic client
local default_config = {
  sidebar_width = 80,
  position = "left",
  anthropic = {
    api_key = nil, -- Will be fetched from environment if not set
    model = "claude-3-sonnet-20240229",
    system_prompt = "You are an AI assistant helping with code-related tasks in Neovim."
  }
}

M.config = vim.tbl_deep_extend("force", default_config, {})


---@type AnthropicClient
local anthropic_client = nil
local sidebar = nil

-- Initialize the plugin with user config
function M.setup(opts)
  log.debug("Setting up magenta with opts:", opts)
  M.config = vim.tbl_deep_extend("force", default_config, opts or {})

  anthropic_client = require("magenta.anthropic").new(M.config.anthropic)
  sidebar = require('magenta.sidebar')
  sidebar.setup()

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


function M.show_sidebar()
  if not sidebar then
    log.error("sidebar not initialized")
    vim.notify("Input area not initialized", vim.log.levels.ERROR)
    return
  end

  local input_area = sidebar.show_sidebar()
  log.debug("Setting up buffer-local command in input buffer")
  vim.api.nvim_buf_create_user_command(input_area.bufnr, "MagentaSend", function()
    M.send_message()
  end, {})
end

function M.hide_sidebar()
  if sidebar then
    sidebar.hide_sidebar()
  end
end

function M.send_message()
  log.debug("Sending message from input area")
  if not sidebar then
    log.error("sidebar not initialized")
    vim.notify("Input area not initialized", vim.log.levels.ERROR)
    return
  end
  local message = sidebar.pop_message()

  -- Add user message to main area
  sidebar.append_to_main { text = "\nUser: " .. message .. "\n\nAssistant: ", scrolltop = true }

  -- Send to Anthropic with streaming
  anthropic_client:request({
    message = message,
    stream = true
  }, {
    callback = function(err, text)
      if err then
        log.error("Anthropic API error:", err)
        sidebar.append_to_main { text = "\nError: " .. err .. "\n" }
        return
      end

      if text then
        log.debug("Received stream text:", text)
        sidebar.append_to_main({ text = text })
      end
    end,
    done = function()
      log.debug("Request completed")
    end
  })
end

return M

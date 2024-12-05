local log = require('magenta.log').log;

local M = {}

local default_config = {
  sidebar_width = 80,
  position = "left",
}

M.sidebar = nil
M.input_area = nil
M.main_area = nil


M.config = vim.tbl_deep_extend("force", default_config, {})

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", default_config, opts or {})

  local ok, err = pcall(function()
    local Layout = require("nui.layout")
    local Split = require("nui.split")

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
end

function M.append_to_main(opts)
  if not M.main_area or not M.main_area.bufnr then
    log.error("Cannot append to main area - not initialized")
    return
  end

  local lines = vim.split(opts.text, '\n', {})
  if #lines == 0 then return end


  local top_line = vim.api.nvim_buf_line_count(M.main_area.bufnr);
  local last_line = vim.api.nvim_buf_get_lines(M.main_area.bufnr, -2, -1, false)[1] or ""

  vim.api.nvim_buf_set_option(M.main_area.bufnr, 'modifiable', true)
  vim.api.nvim_buf_set_lines(M.main_area.bufnr, -2, -1, false, { last_line .. lines[1] })

  if #lines > 1 then
    vim.api.nvim_buf_set_lines(M.main_area.bufnr, -1, -1, false, vim.list_slice(lines, 2))
  end

  vim.api.nvim_buf_set_option(M.main_area.bufnr, 'modifiable', false)

  if opts.scrolltop then
    local offset = #lines > 1 and 1 or 0
    require('magenta.util.scroll_buffer').scroll_buffer(M.main_area.bufnr, top_line + offset)
  else
    local final_line = vim.api.nvim_buf_line_count(M.main_area.bufnr)
    vim.api.nvim_win_set_cursor(M.main_area.winid, { final_line, 0 })
  end
end

function M.pop_message()
  if not M.input_area then
    return ""
  end

  local lines = vim.api.nvim_buf_get_lines(M.input_area.bufnr, 0, -1, false)
  local message = table.concat(lines, "\n")

  log.debug("Message content:", message)
  -- Clear input area
  vim.api.nvim_buf_set_lines(M.input_area.bufnr, 0, -1, false, { "" })

  return message
end

function M.show_sidebar()
  if not M.components then
    log.error("Plugin not initialized")
    vim.notify("Plugin not initialized. Please call require('magenta').setup()", vim.log.levels.ERROR)
    return
  end

  log.debug("Showing sidebar")
  if M.sidebar then
    log.debug("showing existing sidebar")
    M.sidebar:show()
    return
  end

  local Layout = M.components.Layout
  local Split = M.components.Split

  M.main_area = Split({
    relative = "editor",
    size = M.config.sidebar_width,
    win_options = {
      wrap = true,
      number = false,
      relativenumber = false,
      cursorline = true,
    },
  })

  M.input_area = Split({
    relative = "editor",
    size = M.config.sidebar_width,
    win_options = {
      wrap = true,
      number = false,
      relativenumber = false,
    },
  })

  M.sidebar = Layout(
    {
      relative = "editor",
      position = M.config.position,
      size = M.config.sidebar_width,
    },
    Layout.Box({
      Layout.Box(M.main_area, { size = "80%" }),
      Layout.Box(M.input_area, { size = "20%" }),
    }, { dir = "col" })
  )

  log.debug("Mounting sidebar")
  M.sidebar:mount()

  local content = { "Magenta Sidebar", "============", ""}
  vim.api.nvim_buf_set_lines(M.main_area.bufnr, 0, -1, false, content)
  vim.bo[M.main_area.bufnr].modifiable = false

  vim.api.nvim_buf_set_lines(M.input_area.bufnr, 0, -1, false, { "Enter text here..." })

  return M.input_area
end

function M.hide_sidebar()
  if M.sidebar then
    log.debug("Hiding sidebar")
    M.sidebar:hide()
  else
    log.debug("No sidebar to hide")
  end
end


return M

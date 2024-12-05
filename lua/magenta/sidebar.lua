local log = require('magenta.log').log;

---@class SidebarModule
---@field config table Configuration options
---@field sidebar Sidebar The Sidebar class
---@field setup fun(opts: table?) Set up the sidebar with optional config
local M = {}

local default_config = {
  sidebar_width = 80,
  position = "left",
}

M.config = vim.tbl_deep_extend("force", default_config, {})

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", default_config, opts or {})
end

---@class Sidebar
---@field sidebar NuiLayout|nil The main layout container
---@field input_area NuiSplit|nil The bottom input split
---@field main_area NuiSplit|nil The main content split
local Sidebar = {}
Sidebar.__index = Sidebar

M.Sidebar = Sidebar

---Creates a new Sidebar instance
---@return Sidebar
function Sidebar.new()
  local self = setmetatable({}, Sidebar)
  self.sidebar = nil
  self.input_area = nil
  self.main_area = nil
  return self
end

---@param opts {text: string, scrolltop: boolean?} Options for appending text
function Sidebar:append_to_main(opts)
  if not self.main_area or not self.main_area.bufnr then
    log.error("Cannot append to main area - not initialized")
    return
  end

  local lines = vim.split(opts.text, '\n', {})
  if #lines == 0 then return end


  local top_line = vim.api.nvim_buf_line_count(self.main_area.bufnr);
  local last_line = vim.api.nvim_buf_get_lines(self.main_area.bufnr, -2, -1, false)[1] or ""

  vim.api.nvim_buf_set_option(self.main_area.bufnr, 'modifiable', true)
  vim.api.nvim_buf_set_lines(self.main_area.bufnr, -2, -1, false, { last_line .. lines[1] })

  if #lines > 1 then
    vim.api.nvim_buf_set_lines(self.main_area.bufnr, -1, -1, false, vim.list_slice(lines, 2))
  end

  vim.api.nvim_buf_set_option(self.main_area.bufnr, 'modifiable', false)

  if opts.scrolltop then
    local offset = #lines > 1 and 1 or 0
    require('magenta.util.scroll_buffer').scroll_buffer(self.main_area.bufnr, top_line + offset)
  else
    local final_line = vim.api.nvim_buf_line_count(self.main_area.bufnr)
    vim.api.nvim_win_set_cursor(self.main_area.winid, { final_line, 0 })
  end
end

---@return string The current message text
function Sidebar:pop_message()
  if not self.input_area then
    return ""
  end

  local lines = vim.api.nvim_buf_get_lines(self.input_area.bufnr, 0, -1, false)
  local message = table.concat(lines, "\n")

  log.debug("Message content:", message)
  -- Clear input area
  vim.api.nvim_buf_set_lines(self.input_area.bufnr, 0, -1, false, { "" })

  return message
end

---@return NuiSplit Returns the input area split if successful
function Sidebar:show_sidebar()
  log.debug("Showing sidebar")
  if self.sidebar then
    self:hide_sidebar()
  end

  local Layout = require('nui.layout')
  local Split = require('nui.split')

  self.main_area = Split({
    relative = "editor",
    size = M.config.sidebar_width,
    win_options = {
      wrap = true,
      number = false,
      relativenumber = false,
      cursorline = true,
    },
  })

  self.input_area = Split({
    relative = "editor",
    size = M.config.sidebar_width,
    win_options = {
      wrap = true,
      number = false,
      relativenumber = false,
    },
  })

  self.sidebar = Layout(
    {
      relative = "editor",
      position = M.config.position,
      size = M.config.sidebar_width,
    },
    Layout.Box({
      Layout.Box(self.main_area, { size = "80%" }),
      Layout.Box(self.input_area, { size = "20%" }),
    }, { dir = "col" })
  )

  log.debug("Mounting sidebar")
  self.sidebar:mount()

  local content = { "Magenta Sidebar", "============", ""}
  vim.api.nvim_buf_set_lines(self.main_area.bufnr, 0, -1, false, content)
  vim.bo[self.main_area.bufnr].modifiable = false

  vim.api.nvim_buf_set_lines(self.input_area.bufnr, 0, -1, false, { "Enter text here..." })

  return self.input_area
end

function Sidebar:hide_sidebar()
  if not self.sidebar then
    log.debug("Sidebar not visible")
    return
  end
  log.debug("unmounting sidebar")
  self.sidebar:unmount()
  self.sidebar = nil
  self.input_area = nil
  self.main_area = nil
end


return M

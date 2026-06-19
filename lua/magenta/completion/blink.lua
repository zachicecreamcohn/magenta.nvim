-- blink.cmp source for magenta input-buffer completions.
--
-- This adapts the existing per-feature completion sources (keywords, @file:,
-- @diff:, @staged:) - which expose an nvim-cmp style `:complete(params, cb)`
-- interface - into a single blink.cmp source. nvim-cmp remains supported via
-- `magenta.completion.source`; this module is the blink.cmp equivalent.
--
-- Register it in your blink.cmp config, e.g.:
--   sources = {
--     default = { 'magenta', ... },
--     providers = {
--       magenta = { name = 'magenta', module = 'magenta.completion.blink' },
--     },
--   }
-- magenta also auto-registers this provider on startup when blink.cmp is found.

local constants = require('magenta.completion.constants')

local SUBSOURCE_MODULES = {
  'magenta.completion.keywords',
  'magenta.completion.file_buffers',
  'magenta.completion.file_files',
  'magenta.completion.diff_files',
  'magenta.completion.staged_files',
}

--- @class blink.cmp.Source
local source = {}

function source.new(_)
  local self = setmetatable({}, { __index = source })
  self.subsources = {}
  for _, mod in ipairs(SUBSOURCE_MODULES) do
    local ok, m = pcall(require, mod)
    if ok and type(m.create_source) == 'function' then
      table.insert(self.subsources, m.create_source())
    end
  end
  return self
end

function source:enabled()
  local buf_name = vim.api.nvim_buf_get_name(vim.api.nvim_get_current_buf())
  return constants.is_magenta_input_buffer(buf_name)
end

function source:get_trigger_characters()
  return { '@', ':' }
end

-- The underlying sources emit a bare-prefix item (e.g. label '@file:' with
-- data.path == nil) purely to keep nvim-cmp's menu open while async jobs run.
-- blink.cmp handles async via is_incomplete, so these keep-alive placeholders
-- are just noise. Informational items (e.g. '@diff:no-unstaged-changes') carry
-- a non-prefix label and are kept.
local function is_keepalive_placeholder(item)
  return type(item) == 'table'
    and item.data ~= nil
    and item.data.path == nil
    and type(item.label) == 'string'
    and item.label:match('^@%w+:$') ~= nil
end

function source:get_completions(_, callback)
  local row, col = unpack(vim.api.nvim_win_get_cursor(0))
  local line = vim.api.nvim_get_current_line()
  local cursor_before_line = line:sub(1, col)

  -- All magenta completions are anchored on an `@token`. Find where it starts
  -- so we can both feed the cmp-style `offset` and build a textEdit range.
  local token_start = cursor_before_line:find('@%S*$')
  local params = {
    context = { cursor_before_line = cursor_before_line },
    offset = token_start or (#cursor_before_line + 1),
  }

  local range
  if token_start then
    range = {
      start = { line = row - 1, character = token_start - 1 },
      ['end'] = { line = row - 1, character = col },
    }
  end

  local seen = {}
  local emitted_once = false

  local function to_blink_item(item)
    local copy = vim.deepcopy(item)
    if range and not copy.textEdit then
      copy.textEdit = {
        range = range,
        newText = copy.insertText or copy.label,
      }
      copy.insertText = nil
    end
    -- The nvim-cmp sources set `filterText` to the entire typed token (e.g.
    -- '@di') on every item, which is identical across items and defeats
    -- blink.cmp's fuzzy matching (blink strips the leading '@'/'@kind:' from the
    -- query). Drop it so blink matches the query against the item's label.
    copy.filterText = nil
    return copy
  end

  -- blink.cmp's list appends across callback invocations, so we forward only
  -- items we haven't sent yet (deduped by label) and let blink accumulate them.
  local function forward(result)
    local items = (type(result) == 'table' and result.items) or {}
    local fresh = {}
    for _, item in ipairs(items) do
      if type(item) == 'table'
        and type(item.label) == 'string'
        and not seen[item.label]
        and not is_keepalive_placeholder(item)
      then
        seen[item.label] = true
        table.insert(fresh, to_blink_item(item))
      end
    end

    if #fresh == 0 and emitted_once then
      return
    end
    emitted_once = true
    callback({
      items = fresh,
      is_incomplete_forward = true,
      is_incomplete_backward = true,
    })
  end

  for _, subsource in ipairs(self.subsources) do
    pcall(function()
      subsource:complete(params, forward)
    end)
  end

  return function() end
end

return source

local M = {}

local has_cmp, cmp = pcall(require, 'cmp')
if not has_cmp then
  return M
end

-- Keywords completion source
local source = {}

-- Static keywords for completion
local KEYWORDS = {
  { label = '@qf',          kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add quickfix entries to context' },
  { label = '@diag',        kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add diagnostics to context' },
  { label = '@buf',         kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add current buffer to context' },
  { label = '@buffers',     kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add all open buffers to context' },
  { label = '@quickfix',    kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add quickfix entries to context' },
  { label = '@diagnostics', kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add diagnostics to context' },
  { label = '@fork',        kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Fork the thread' },
  { label = '@file:',       kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add file to context (supports fuzzy path completion)' },
  { label = '@staged:',     kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add staged file to context (supports file completion)' },
  { label = '@diff:',       kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add unstaged/untracked file to context (supports file completion)' },
}

function source:is_available()
  local bufnr = vim.api.nvim_get_current_buf()
  local buf_name = vim.api.nvim_buf_get_name(bufnr)
  return buf_name:match('%[Magenta Input%]') ~= nil
end

function source:get_debug_name()
  return 'magenta_keywords'
end

function source:get_trigger_characters()
  return { '@' }
end

function source:get_keyword_pattern()
  return [[@\w*]]
end

function source:complete(params, callback)
  local cursor_before_line = params.context.cursor_before_line
  local filter_text = cursor_before_line:sub(params.offset)

  -- Only complete when user types standalone @ or @word (no colon)
  if not filter_text:match('^@%w*$') then
    callback({ items = {}, isIncomplete = false })
    return
  end

  callback({
    items = vim.tbl_map(function(item)
      return vim.tbl_extend('force', item, {
        filterText = filter_text
      })
    end, KEYWORDS),
    isIncomplete = false
  })
end

function M.create_source()
  return source
end

return M

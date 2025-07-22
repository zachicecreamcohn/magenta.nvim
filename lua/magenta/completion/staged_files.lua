local M = {}

local has_cmp, cmp = pcall(require, 'cmp')
if not has_cmp then
  return M
end

local git = require('magenta.completion.git')
local jobctl = require('magenta.completion.jobctl')

-- Staged files completion source
local source = {}

-- Create job state for this source
local job_state = jobctl.create_job_state()

function source:is_available()
  local bufnr = vim.api.nvim_get_current_buf()
  local buf_name = vim.api.nvim_buf_get_name(bufnr)
  return buf_name:match('%[Magenta Input%]') ~= nil
end

function source:get_debug_name()
  return 'magenta_staged_files'
end

function source:get_trigger_characters()
  return { ':' }
end

function source:get_keyword_pattern()
  return [[@staged:\S*]]
end

function source:complete(params, callback)
  local cursor_before_line = params.context.cursor_before_line
  local filter_text = cursor_before_line:sub(params.offset)
  
  -- Only complete @staged: patterns
  local staged_pattern = filter_text:match('^@staged:(.*)$')
  if not staged_pattern then
    callback({ items = {}, isIncomplete = false })
    return
  end

  local search_term = staged_pattern

  local git_status = git.get_git_status()

  if not git_status or not git_status.in_git_repo then
    callback({
      items = { {
        label = '@staged:',
        filterText = filter_text,
        data = { path = nil, score = -1000 },
        kind = cmp.lsp.CompletionItemKind.Text
      } },
      isIncomplete = false
    })
    return
  end

  local git_files = git_status.files and git_status.files.staged or {}

  if #git_files == 0 then
    callback({
      items = { {
        label = '@staged:no-staged-changes',
        filterText = filter_text,
        data = { path = nil, score = -1000 },
        kind = cmp.lsp.CompletionItemKind.Text
      } },
      isIncomplete = true
    })
  else
    git.create_git_completion_items_async(job_state, git_files, search_term, filter_text, '@staged:', callback)
  end
end

function M.create_source()
  return source
end

return M
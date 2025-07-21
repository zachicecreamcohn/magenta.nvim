local M = {}

local has_cmp, cmp = pcall(require, 'cmp')
if not has_cmp then
  return M
end

local fzf = require('magenta.completion.fzf')
local jobctl = require('magenta.completion.jobctl')

-- File files completion source
local source = {}

-- Create job state for this source
local job_state = jobctl.create_job_state()

function source:is_available()
  local bufnr = vim.api.nvim_get_current_buf()
  local buf_name = vim.api.nvim_buf_get_name(bufnr)
  return buf_name:match('%[Magenta Input%]') ~= nil
end

function source:get_debug_name()
  return 'magenta_file_files'
end

function source:get_trigger_characters()
  return { ':' }
end

function source:get_keyword_pattern()
  return [[@file:\S*]]
end

function source:complete(params, callback)
  local cursor_before_line = params.context.cursor_before_line
  local filter_text = cursor_before_line:sub(params.offset)

  -- Only complete @file: patterns
  local file_pattern = filter_text:match('^@file:(.*)$')
  if not file_pattern then
    callback({ items = {}, isIncomplete = false })
    return
  end

  local search_term = file_pattern

  callback({
    items = { {
      label = '@file:',
      filterText = filter_text,
      data = { path = nil, is_buffer = false },
      kind = cmp.lsp.CompletionItemKind.Text
    } },
    isIncomplete = true
  })

  local items = {}

  local file_cmd = fzf.create_file_fzf_command(search_term)
  jobctl.run_job_with_timeout(job_state, {
    command = file_cmd,
    timeout = jobctl.TIMEOUT_MS,
    on_results = function(lines)
      if not lines or #lines == 0 or (#lines == 1 and lines[1] == '') then
        return
      end
      for _, file_path in ipairs(lines) do
        if file_path and file_path ~= '' then
          -- Clean up file path (remove leading './')
          file_path = file_path:gsub('^%./', '')

          if file_path ~= '' then
            local file_kind = cmp.lsp.CompletionItemKind.File
            local stat = vim.loop and vim.loop.fs_stat(file_path)
            if stat and stat.type == 'directory' then
              file_kind = cmp.lsp.CompletionItemKind.Folder
            end


            table.insert(items, {
              label = '@file:' .. file_path,
              detail = '[file]',
              kind = file_kind,
              filterText = filter_text,
              sortText = '1000', -- sort files below buffers
              data = {
                path = file_path,
              }
            })
          end
        end
      end
    end,
    on_completion = function()
      if #items == 0 then
        callback({
          items = { {
            label = '@file:',
            filterText = filter_text,
            data = { path = nil },
            kind = cmp.lsp.CompletionItemKind.Text
          } },
          isIncomplete = true
        })
      else
        callback({ items = items, isIncomplete = true })
      end
    end
  })
end

function M.create_source()
  return source
end

return M

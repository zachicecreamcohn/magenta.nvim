local M = {}

local has_cmp, cmp = pcall(require, 'cmp')
if not has_cmp then
  return M
end

local fzf = require('magenta.completion.fzf')
local jobctl = require('magenta.completion.jobctl')

-- File buffers completion source
local source = {}

-- Create job state for this source
local job_state = jobctl.create_job_state()

function source:is_available()
  local bufnr = vim.api.nvim_get_current_buf()
  local buf_name = vim.api.nvim_buf_get_name(bufnr)
  return buf_name:match('%[Magenta Input%]') ~= nil
end

function source:get_debug_name()
  return 'magenta_file_buffers'
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
      data = { path = nil, is_buffer = true },
      kind = cmp.lsp.CompletionItemKind.Text
    } },
    isIncomplete = true
  })

  local items = {}

  local buffer_cmd = fzf.create_buffer_fzf_command(search_term)
  if buffer_cmd then
    jobctl.run_job_with_timeout(job_state, {
      command = buffer_cmd,
      timeout = jobctl.TIMEOUT_MS,
      on_results = function(lines)
        if not lines or #lines == 0 or (#lines == 1 and lines[1] == '') then
          return
        end
        for _, file_path in ipairs(lines) do
          if file_path and file_path ~= '' then
            file_path = file_path:gsub('^%./', '')

            if file_path ~= '' then
              local file_kind = cmp.lsp.CompletionItemKind.File
              local stat = vim.loop and vim.loop.fs_stat(file_path)
              if stat and stat.type == 'directory' then
                file_kind = cmp.lsp.CompletionItemKind.Folder
              end

              table.insert(items, {
                label = '@file:' .. file_path,
                detail = '[buffer]',
                kind = file_kind,
                filterText = filter_text,
                sortText = '0000', -- sort buffers above files
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
              detail = '[buffer]',
              filterText = filter_text,
              data = { path = nil, is_buffer = true },
              kind = cmp.lsp.CompletionItemKind.File
            } },
            isIncomplete = true
          })
        else
          callback({ items = items, isIncomplete = true })
        end
      end
    })
  else
    callback({
      items = {},
      isIncomplete = true
    })
  end
end

function M.create_source()
  return source
end

return M


local M = {}

local has_cmp, cmp = pcall(require, 'cmp')
if not has_cmp then
  vim.notify('nvim-cmp not found, magenta completion unavailable', vim.log.levels.WARN)
  return M
end

local fzf = require('magenta.completion.fzf')
local git = require('magenta.completion.git')
local jobctl = require('magenta.completion.jobctl')

-- Completion source for Magenta input buffers
local source = {}

-- Static keywords for completion
local KEYWORDS = {
  { label = '@qf',          kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add quickfix entries to context' },
  { label = '@diag',        kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add diagnostics to context' },
  { label = '@buf',         kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add current buffer to context' },
  { label = '@buffers',     kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add all open buffers to context' },
  { label = '@quickfix',    kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add quickfix entries to context' },
  { label = '@diagnostics', kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add diagnostics to context' },
  { label = '@compact',     kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Use compact context format' },
  { label = '@file:',       kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add file to context (supports fuzzy path completion)' },
  { label = '@staged:',     kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add staged file to context (supports file completion)' },
  { label = '@diff:',       kind = cmp.lsp.CompletionItemKind.Keyword, documentation = 'Add unstaged/untracked file to context (supports file completion)' },
}

-- Check if a path is an open buffer (using cached buffer paths)
local function is_open_buffer(path, buffer_paths_set)
  return buffer_paths_set[path] == true
end

-- Check if current buffer is a magenta input buffer
function source:is_available()
  local bufnr = vim.api.nvim_get_current_buf()
  local buf_name = vim.api.nvim_buf_get_name(bufnr)

  -- Check if buffer name matches magenta input pattern
  if buf_name:match('%[Magenta Input%]') then
    return true
  end

  -- Check for buffer variable (backup identification method)
  local ok, is_magenta = pcall(vim.api.nvim_buf_get_var, bufnr, 'magenta_input_buffer')
  return ok and is_magenta
end

function source:get_debug_name()
  return 'magenta'
end

function source:get_trigger_characters()
  return { ':', '@' }
end

function source:get_keyword_pattern()
  return [[@\w*\%(:\S*\)\?]]
end

-- Detect what type of completion is needed based on cursor position
local function detect_completion_type(cursor_before_line, offset)
  local pattern_text = cursor_before_line:sub(offset)

  -- Check for standalone @ (keyword completion)
  if pattern_text == '@' then
    return { type = 'keywords', search_term = '' }
  end

  -- Check for @word: patterns
  local colon_pos = pattern_text:find(':')
  if colon_pos then
    local prefix = pattern_text:sub(2, colon_pos - 1)
    local search_term = pattern_text:sub(colon_pos + 1)

    if prefix == 'file' then
      return { type = 'files', search_term = search_term }
    elseif prefix == 'diff' then
      return { type = 'diff', search_term = search_term }
    elseif prefix == 'staged' then
      return { type = 'staged', search_term = search_term }
    end
  end

  return nil
end


function source:complete(params, callback)
  local cursor_before_line = params.context.cursor_before_line
  local completion_info = detect_completion_type(cursor_before_line, params.offset)

  if not completion_info then
    callback({ items = {}, isIncomplete = false })
    return
  end

  local filter_text = cursor_before_line:sub(params.offset)

  if completion_info.type == 'keywords' then
    -- Return all keywords when user types standalone @
    callback({
      items = vim.tbl_map(function(item)
        return vim.tbl_extend('force', item, {
          filterText = filter_text
        })
      end, KEYWORDS),
      isIncomplete = false
    })
    return
  end

  if completion_info.type == 'diff' or completion_info.type == 'staged' then
    -- Git-based completions
    local git_status = git.get_git_status()

    if not git_status or not git_status.in_git_repo then
      callback({
        items = { {
          label = '@' .. completion_info.type .. ':',
          filterText = filter_text,
          data = { path = nil, score = -1000 },
          kind = cmp.lsp.CompletionItemKind.Text
        } },
        isIncomplete = false
      })
      return
    end

    local git_files = {}
    if git_status and git_status.files then
      if completion_info.type == 'diff' then
        -- Include unstaged and untracked files
        if git_status.files.unstaged then
          vim.list_extend(git_files, git_status.files.unstaged)
        end
        if git_status.files.untracked then
          vim.list_extend(git_files, git_status.files.untracked)
        end
      elseif completion_info.type == 'staged' then
        git_files = git_status.files.staged or {}
      end
    end

    if #git_files == 0 then
      local no_files_msg = completion_info.type == 'diff' and '@diff:no-unstaged-changes' or '@staged:no-staged-changes'
      callback({
        items = { {
          label = no_files_msg,
          filterText = filter_text,
          data = { path = nil, score = -1000 },
          kind = cmp.lsp.CompletionItemKind.Text
        } },
        isIncomplete = true
      })
    else
      git.create_git_completion_items_async(git_files, completion_info.search_term, filter_text,
        '@' .. completion_info.type .. ':', callback)
    end
    return
  end

  if completion_info.type == 'files' then
    local items = {}

    callback({
      items = { {
        label = '@file:',
        filterText = filter_text,
        data = { path = nil, is_buffer = false },
        kind = cmp.lsp.CompletionItemKind.Text
      } },
      isIncomplete = true
    })

    -- Two-phase approach: buffers first with high priority, then files
    local buffer_paths_set = fzf.create_buffer_paths_set()
    local completed_jobs = { buffers = false, files = false }

    -- only sends results when both sub-jobs are done
    local function try_to_send_results()
      if not (completed_jobs.buffers and completed_jobs.files) then
        return
      end

      if #items == 0 then
        callback({
          items = { {
            label = '@file:',
            filterText = filter_text,
            data = { path = nil, is_buffer = false },
            kind = cmp.lsp.CompletionItemKind.Text
          } },
          isIncomplete = true
        })
      else
        -- De-duplicate items by path, keeping buffers over non-buffers
        local seen_paths = {}
        local deduped_items = {}

        for _, item in ipairs(items) do
          local path = item.data and item.data.path
          if path then
            local existing = seen_paths[path]
            if not existing or (item.data.is_buffer and not existing.data.is_buffer) then
              seen_paths[path] = item
            end
          else
            -- Items without paths (like fallbacks) are always included
            table.insert(deduped_items, item)
          end
        end

        -- Collect all unique items
        for _, item in pairs(seen_paths) do
          table.insert(deduped_items, item)
        end

        -- Sort by is_buffer (buffers first) then alphabetically
        table.sort(deduped_items, function(a, b)
          local is_buffer_a = a.data and a.data.is_buffer or false
          local is_buffer_b = b.data and b.data.is_buffer or false
          if is_buffer_a ~= is_buffer_b then
            return is_buffer_a -- true sorts before false
          end
          return a.label < b.label
        end)

        callback({ items = deduped_items, isIncomplete = true })
      end
    end

    local function add_file_item(file_path, is_buffer_override)
      -- Clean up file path (remove leading './')
      file_path = file_path:gsub('^%./', '')

      if file_path ~= '' then
        -- Determine file type for appropriate icon
        local file_kind = cmp.lsp.CompletionItemKind.File
        local stat = vim.loop and vim.loop.fs_stat(file_path)
        if stat and stat.type == 'directory' then
          file_kind = cmp.lsp.CompletionItemKind.Folder
        end

        -- Determine detail and sortText
        local detail = nil
        local sort_text
        local is_buffer = is_buffer_override or is_open_buffer(file_path, buffer_paths_set)
        if is_buffer then
          detail = '[buffer]'
          sort_text = '0000' -- Sort buffers first
        else
          sort_text = '1000' -- Sort regular files after buffers
        end

        table.insert(items, {
          label = '@file:' .. file_path,
          detail = detail,
          kind = file_kind,
          filterText = filter_text,
          sortText = sort_text,
          data = {
            path = file_path,
            is_buffer = is_buffer
          }
        })
      end
    end

    -- Start buffer search
    local buffer_cmd = fzf.create_buffer_fzf_command(completion_info.search_term)
    if buffer_cmd then
      jobctl.run_job_with_timeout({
        command = buffer_cmd,
        timeout = jobctl.TIMEOUT_MS,
        on_results = function(lines)
          if not lines or #lines == 0 or (#lines == 1 and lines[1] == '') then
            return
          end
          for _, file_path in ipairs(lines) do
            if file_path and file_path ~= '' then
              add_file_item(file_path, true) -- Mark as buffer
            end
          end
        end,
        on_completion = function()
          completed_jobs.buffers = true
          try_to_send_results()
        end,
        cancel_pending_jobs = true
      })
    else
      completed_jobs.buffers = true
    end

    -- Start file search
    local file_cmd = fzf.create_file_fzf_command(completion_info.search_term)
    jobctl.run_job_with_timeout({
      command = file_cmd,
      timeout = jobctl.TIMEOUT_MS,
      on_results = function(lines)
        if not lines or #lines == 0 or (#lines == 1 and lines[1] == '') then
          return
        end
        for _, file_path in ipairs(lines) do
          if file_path and file_path ~= '' then
            add_file_item(file_path, false) -- Let function determine if it's a buffer
          end
        end
      end,
      on_completion = function()
        completed_jobs.files = true
        try_to_send_results()
      end,
      cancel_pending_jobs = false -- this and the buffers command should run in parallel
    })

    return
  end

  -- Fallback for unknown completion types
  callback({
    items = { {
      label = 'Unknown completion type',
      filterText = filter_text,
      data = { path = nil, score = -1000 },
      kind = cmp.lsp.CompletionItemKind.Text
    } },
    isIncomplete = false
  })
end

-- Initialize the completion source
function M.setup()
  -- Register the completion source globally (required by nvim-cmp architecture)
  -- The source will only be active in buffers where we explicitly configure it
  cmp.register_source('magenta', source)

  -- Set up buffer-specific completion configuration for magenta input buffers
  vim.api.nvim_create_autocmd('BufEnter', {
    pattern = '*',
    callback = function()
      local bufnr = vim.api.nvim_get_current_buf()
      local buf_name = vim.api.nvim_buf_get_name(bufnr)

      -- Only activate magenta completion for magenta input buffers
      if buf_name:match('%[Magenta Input%]') then
        -- Set buffer variable for identification (used by is_available() as backup)
        vim.api.nvim_buf_set_var(bufnr, 'magenta_input_buffer', true)

        -- Get existing sources and append magenta source
        local existing_sources = cmp.get_config().sources or {}
        local sources_with_magenta = vim.deepcopy(existing_sources)

        -- Check if magenta source is already in the list
        local has_magenta = false
        for _, existingSource in ipairs(sources_with_magenta) do
          if existingSource.name == 'magenta' then
            has_magenta = true
            break
          end
        end

        -- Add magenta source at the beginning for higher priority
        if not has_magenta then
          table.insert(sources_with_magenta, 1, { name = 'magenta' })
        end

        -- Configure nvim-cmp to use existing sources plus magenta for this buffer
        cmp.setup.buffer({
          sources = cmp.config.sources(sources_with_magenta)
        })
      end
    end,
    group = vim.api.nvim_create_augroup('MagentaCompletion', { clear = true })
  })
end

return M

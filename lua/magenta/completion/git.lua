local M = {}

local jobctl = require('magenta.completion.jobctl')
local fzf = require('magenta.completion.fzf')

local has_cmp, cmp = pcall(require, 'cmp')
if not has_cmp then
  return M
end

-- Git status cache
local git_cache = {
  last_check = 0,
  ttl = 5000, -- 5 seconds
  status = nil
}

-- Get git status with caching
M.get_git_status = function()
  local now = vim.uv.now()

  -- Return cached result if still valid
  if git_cache.status and (now - git_cache.last_check) < git_cache.ttl then
    return git_cache.status
  end

  -- Check if git is available and we're in a git repo
  if vim.fn.executable('git') ~= 1 then
    return { files = {}, in_git_repo = false }
  end

  -- Check if we're in a git repository
  vim.fn.system('git rev-parse --is-inside-work-tree 2>/dev/null')
  if vim.v.shell_error ~= 0 then
    return { files = {}, in_git_repo = false }
  end

  -- Get git status
  local output = vim.fn.system('git status --porcelain')
  if vim.v.shell_error ~= 0 then
    return { files = {}, in_git_repo = true }
  end

  local files = {
    staged = {},
    unstaged = {},
    untracked = {}
  }

  -- Parse git status output
  if output then
    for line in output:gmatch('[^\r\n]+') do
      if line and #line >= 3 then
        local staged_status = line:sub(1, 1)
        local unstaged_status = line:sub(2, 2)
        local file_path = line:sub(4)

        -- Handle renamed files (format: "old -> new")
        if file_path and file_path:find(' -> ') then
          local renamed_path = file_path:match(' -> (.+)')
          if renamed_path then
            file_path = renamed_path
          end
        end

        -- Categorize files based on status
        if file_path and staged_status ~= ' ' and staged_status ~= '?' then
          table.insert(files.staged, {
            path = file_path,
            status = staged_status,
            kind = cmp.lsp.CompletionItemKind.File
          })
        end

        if file_path and unstaged_status ~= ' ' then
          if unstaged_status == '?' then
            table.insert(files.untracked, {
              path = file_path,
              status = 'untracked',
              kind = cmp.lsp.CompletionItemKind.File
            })
          else
            table.insert(files.unstaged, {
              path = file_path,
              status = unstaged_status,
              kind = cmp.lsp.CompletionItemKind.File
            })
          end
        end
      end
    end
  end

  -- Cache the result
  git_cache.status = { files = files, in_git_repo = true }
  git_cache.last_check = now

  return git_cache.status
end

-- Create completion items from git files (async with fzf)
M.create_git_completion_items_async = function(git_files, search_term, filter_text, prefix, callback)
  local items = {}
  local git_file_map = {}

  -- Create lookup map for git file metadata
  for _, file in ipairs(git_files) do
    git_file_map[file.path] = file
  end

  -- Show "Searching..." immediately for user feedback
  callback({
    items = { {
      label = prefix,
      filterText = filter_text,
      data = { path = nil, score = -1000 },
      kind = cmp.lsp.CompletionItemKind.Text
    } },
    isIncomplete = true
  })

  local search_cmd = fzf.create_git_fzf_command(git_files, search_term)

  jobctl.run_job_with_timeout({
    command = search_cmd,
    timeout = jobctl.TIMEOUT_MS,
    on_results = function(lines)
      if not lines or #lines == 0 or (#lines == 1 and lines[1] == '') then
        return
      end

      for _, file_path in ipairs(lines) do
        if file_path and file_path ~= '' then
          local git_file = git_file_map[file_path]
          if git_file then
            local status_indicator = git_file.status == 'untracked' and '[?]' or '[' .. git_file.status .. ']'

            table.insert(items, {
              label = prefix .. file_path,
              detail = status_indicator,
              kind = git_file.kind,
              filterText = filter_text,
              data = {
                path = file_path,
                status = git_file.status,
                score = 100 -- Higher than placeholder items
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
            label = prefix,
            filterText = filter_text,
            data = { path = nil, score = -1000 },
            kind = cmp.lsp.CompletionItemKind.Text
          } },
          isIncomplete = true
        })
      else
        -- Sort by score (for fzf) or alphabetically
        table.sort(items, function(a, b)
          local score_a = a.data and a.data.score or 0
          local score_b = b.data and b.data.score or 0
          if score_a ~= score_b then
            return score_a > score_b
          end
          return a.label < b.label
        end)

        callback({ items = items, isIncomplete = true })
      end
    end,
    cancel_pending_jobs = true
  })
end

return M

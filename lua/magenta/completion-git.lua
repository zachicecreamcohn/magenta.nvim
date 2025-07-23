local M = {}
local text_utils = require('magenta.text-utils')

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
    local lines = text_utils.split_lines(output)
    for _, line in ipairs(lines) do
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

return M

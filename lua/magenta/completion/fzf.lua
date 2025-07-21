local M = {}

-- Create fzf command for git files
M.create_git_fzf_command = function(git_files, search_term)
  -- Create a temporary list of file paths
  local file_paths = {}
  for _, file in ipairs(git_files) do
    table.insert(file_paths, file.path)
  end

  local files_input = table.concat(file_paths, '\n')

  if search_term == '' then
    -- No search term, return all files
    return string.format("printf '%s'", files_input:gsub("'", "'\"'\"'"))
  end

  -- Use fzf for fuzzy filtering
  if vim.fn.executable('fzf') == 1 then
    return string.format("printf '%s' | fzf --filter='%s'",
      files_input:gsub("'", "'\"'\"'"), search_term:gsub("'", "'\"'\"'"))
  else
    -- Fallback to grep for simple substring filtering
    return string.format("printf '%s' | grep -i '%s'",
      files_input:gsub("'", "'\"'\"'"), search_term:gsub("'", "'\"'\"'"))
  end
end

-- File discovery command selection (adapted from fzf-lua patterns)
M.get_file_discovery_command = function()
  -- Try external tools in order of preference (these respect .gitignore by default)
  if vim.fn.executable('fdfind') == 1 then
    return 'fdfind --type f --hidden'
  elseif vim.fn.executable('fd') == 1 then
    return 'fd --type f --hidden'
  elseif vim.fn.executable('rg') == 1 then
    return 'rg --files --hidden'
  else
    -- Fallback to find with basic exclusions (find doesn't support .gitignore)
    return [[find . -type f ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/.*']]
  end
end

-- Get list of open buffer paths
M.get_open_buffer_paths = function()
  local buffer_paths = {}
  local buffers = vim.api.nvim_list_bufs()

  for _, bufnr in ipairs(buffers) do
    -- Only include loaded, listed buffers with names
    if vim.api.nvim_buf_is_loaded(bufnr) and vim.bo[bufnr].buflisted then
      local buf_name = vim.api.nvim_buf_get_name(bufnr)
      if buf_name and buf_name ~= '' then
        -- Convert to relative path from cwd
        local relative_path = vim.fn.fnamemodify(buf_name, ':.')
        -- Remove leading './' if present
        relative_path = relative_path:gsub('^%./', '')
        if relative_path ~= '' then
          table.insert(buffer_paths, relative_path)
        end
      end
    end
  end

  return buffer_paths
end

-- Create a set from buffer paths for faster lookups
M.create_buffer_paths_set = function()
  local buffer_paths = M.get_open_buffer_paths()
  local buffer_set = {}

  for _, buf_path in ipairs(buffer_paths) do
    buffer_set[buf_path] = true
  end

  return buffer_set
end

-- Create fzf command for buffer search only
M.create_buffer_fzf_command = function(search_term)
  local buffer_paths = M.get_open_buffer_paths()

  if #buffer_paths == 0 then
    return nil
  end

  -- Use printf to properly handle newlines, escape each path individually
  local escaped_paths = {}
  for _, path in ipairs(buffer_paths) do
    -- Escape single quotes in paths (capture only the string, not the count)
    local escaped_path = path:gsub("'", "'\"'\"'")
    table.insert(escaped_paths, escaped_path)
  end
  local buffer_list = table.concat(escaped_paths, '\\n')
  local buffer_cmd = string.format("printf '%s\\n'", buffer_list)

  if search_term == '' then
    return buffer_cmd
  end

  -- Use fzf for fuzzy filtering
  if vim.fn.executable('fzf') == 1 then
    return string.format("(%s) | fzf --filter='%s'", buffer_cmd, search_term:gsub("'", "'\"'\"'"))
  else
    -- Fallback to grep for simple substring filtering
    return string.format("(%s) | grep -i '%s'", buffer_cmd, search_term:gsub("'", "'\"'\"'"))
  end
end

-- Create fzf command for file search
M.create_file_fzf_command = function(search_term)
  local files_cmd = M.get_file_discovery_command()

  if search_term == '' then
    return files_cmd
  end

  -- Use fzf for fuzzy filtering
  if vim.fn.executable('fzf') == 1 then
    return string.format("(%s) | fzf --filter='%s'", files_cmd, search_term:gsub("'", "'\"'\"'"))
  else
    -- Fallback to grep for simple substring filtering
    return string.format("(%s) | grep -i '%s'", files_cmd, search_term:gsub("'", "'\"'\"'"))
  end
end

return M

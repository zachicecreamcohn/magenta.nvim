local M = {}

---@param bufnr integer Buffer number
---@param line integer Line number to scroll to (1-based)
function M.scroll_buffer(bufnr, line)
  -- Save current window
  local current_win = vim.api.nvim_get_current_win()

  -- Find window containing our buffer
  local target_win = nil
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_buf(win) == bufnr then
      target_win = win
      break
    end
  end

  if target_win then
    -- Switch to window
    vim.api.nvim_set_current_win(target_win)
    -- Move cursor and scroll
    vim.api.nvim_win_set_cursor(target_win, { line, 0 })
    vim.cmd('normal! zt')
    -- Switch back
    vim.api.nvim_set_current_win(current_win)
  end
end

return M

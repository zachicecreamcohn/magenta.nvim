local M = {}

---@param log_level string
M.log_exit = function(log_level)
  if not log_level then
    return
  end
  return function(job_id, exit_code)
    vim.print("++++++++++++++++")
    vim.print("job# " .. job_id .. ":")
    vim.print("exit_code: " .. exit_code)
  end
end

---@param log_level string
M.log_job = function(log_level, is_stderr)
  if not log_level then
    return
  end

  local lines = {""}
  return function(job_id, data)
    local eof = #data > 0 and data[#data] == ""
    lines[#lines] = lines[#lines] .. data[1]
    for i = 2, #data do
      table.insert(lines, data[i])
    end
    if eof then
      local prefix = is_stderr and "[ERROR]" or "[INFO]"
      vim.print("----------------")
      vim.print(string.format("%s job# %d:", prefix, job_id))
      for _, line in ipairs(lines) do
        vim.print(line)
      end
      lines = {""}
    end
  end
end

M.write_buffer = function(bufnr)
  vim.api.nvim_buf_call(bufnr, function()
    vim.print("before cmd")
    vim.cmd("silent! write")
    vim.print("after cmd")
  end)
end

return M

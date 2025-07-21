local M = {}

M.TIMEOUT_MS = 500

-- Job state for file completion
local file_completion_state = {
  active_jobs = {},
  timeout_ms = M.TIMEOUT_MS
}

M.run_job_with_timeout = function(opts)
  local command = opts.command
  local timeout = opts.timeout
  local on_results = opts.on_results
  local on_completion = opts.on_completion
  local cancel_pending_jobs = opts.cancel_pending_jobs

  -- Helper function to clean up all pending jobs
  local function cleanup_all_jobs()
    for _, active_job_id in ipairs(file_completion_state.active_jobs) do
      pcall(vim.fn.jobstop, active_job_id)
    end
    file_completion_state.active_jobs = {}
  end

  -- Helper function to remove a specific job from the list
  local function remove_job(id)
    for i, active_id in ipairs(file_completion_state.active_jobs) do
      if active_id == id then
        table.remove(file_completion_state.active_jobs, i)
        break
      end
    end
  end

  if cancel_pending_jobs then
    cleanup_all_jobs()
  end

  -- Declare job_id variable before use
  local job_id

  -- Start new job
  job_id = vim.fn.jobstart({ 'sh', '-c', command }, {
    stdout_buffered = false,
    cwd = vim.fn.getcwd(),
    on_exit = function(_, _, _)
      remove_job(job_id)
      on_completion()
    end,
    on_stdout = function(_, lines, _)
      on_results(lines)
    end
  })

  -- Add to active jobs list
  table.insert(file_completion_state.active_jobs, job_id)

  -- Set up timeout
  vim.fn.timer_start(timeout, function()
    remove_job(job_id)
    on_completion()
  end)

  return job_id
end

return M

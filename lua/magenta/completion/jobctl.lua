local M = {}

M.TIMEOUT_MS = 500

-- Create a new job state for a completion source
function M.create_job_state()
  return {
    active_job = nil,
    timeout_timer = nil
  }
end

M.run_job_with_timeout = function(job_state, opts)
  local command = opts.command
  local timeout = opts.timeout
  local on_results = opts.on_results
  local on_completion = opts.on_completion

  -- Clean up any existing job
  M.cleanup_job(job_state)

  -- Start new job
  job_state.active_job = vim.fn.jobstart({ 'sh', '-c', command }, {
    stdout_buffered = false,
    cwd = vim.fn.getcwd(),
    on_exit = function(_, _, _)
      job_state.active_job = nil
      if job_state.timeout_timer then
        vim.fn.timer_stop(job_state.timeout_timer)
        job_state.timeout_timer = nil
      end
      on_completion()
    end,
    on_stdout = function(_, lines, _)
      on_results(lines)
    end
  })

  -- Set up timeout
  job_state.timeout_timer = vim.fn.timer_start(timeout, function()
    M.cleanup_job(job_state)
    on_completion()
  end)

  return job_state.active_job
end

-- Clean up any active job and timer for this job state
function M.cleanup_job(job_state)
  if job_state.active_job then
    pcall(vim.fn.jobstop, job_state.active_job)
    job_state.active_job = nil
  end
  if job_state.timeout_timer then
    vim.fn.timer_stop(job_state.timeout_timer)
    job_state.timeout_timer = nil
  end
end

return M

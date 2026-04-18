local M = {}

M.enabled = vim.env.MAGENTA_TIMINGS ~= nil

local nvim_start_time_ms = nil
local entries = {}

local function now_epoch_ms()
  local sec, usec = vim.uv.gettimeofday()
  return sec * 1000 + usec / 1000
end

-- Initialize the reference timestamp (nvim start time, in epoch ms).
-- If start_ms is nil, falls back to vim.g.nvim_start_time_ms, then to now.
function M.init(start_ms)
  if nvim_start_time_ms ~= nil then
    return
  end
  nvim_start_time_ms = start_ms or vim.g.nvim_start_time_ms or now_epoch_ms()
end

function M.get_nvim_start_time_ms()
  return nvim_start_time_ms
end

function M.record(label)
  if not M.enabled then
    return
  end
  table.insert(entries, { label = label, time_ms = now_epoch_ms() })
end

-- Merge entries from the node process. Each entry must be {label = ..., time_ms = ...}.
function M.add_entries(new_entries)
  if not M.enabled then
    return
  end
  for _, e in ipairs(new_entries) do
    table.insert(entries, { label = e.label, time_ms = e.time_ms })
  end
end

-- Print a single unified summary to :messages, sorted by time_ms, showing:
--   +relative_ms (Δdelta_ms)  label
function M.report()
  if not M.enabled then
    return
  end
  if nvim_start_time_ms == nil then
    return
  end

  table.sort(entries, function(a, b)
    return a.time_ms < b.time_ms
  end)

  local lines = { "[magenta-timings] (all times relative to nvim start)" }
  local prev_ms = nvim_start_time_ms
  for _, e in ipairs(entries) do
    local rel = e.time_ms - nvim_start_time_ms
    local delta = e.time_ms - prev_ms
    table.insert(lines, string.format("  +%8.1fms  Δ%+8.1fms  %s", rel, delta, e.label))
    prev_ms = e.time_ms
  end

  vim.notify(table.concat(lines, "\n"), vim.log.levels.INFO)
end

return M

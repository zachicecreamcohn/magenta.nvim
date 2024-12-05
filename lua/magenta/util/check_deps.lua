local M = {}

function M.check_deps(deps)
  local missing = {}
  for _, path in ipairs(deps) do
    local ok = pcall(require, path)
    if not ok then
      table.insert(missing, path)
    end
  end

  if #missing > 0 then
    error(string.format(
      "Magenta requires the following plugins: %s\nPlease install them to continue.",
      table.concat(missing, ", ")
    ))
  end
end

return M

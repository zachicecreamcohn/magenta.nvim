-- Must match MAGENTA_INPUT_BUFFER_PREFIX in node/buffer-manager.ts
local M = {
  INPUT_BUFFER_PREFIX = 'Magenta Input',
}

function M.is_magenta_input_buffer(buf_name)
  return buf_name:find(M.INPUT_BUFFER_PREFIX, 1, true) ~= nil
end

return M

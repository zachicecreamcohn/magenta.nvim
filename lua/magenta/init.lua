local Utils = require("magenta.utils")
local M = {}

M.setup = function()
  M.start(true)
end

M.start = function(silent)
  if not silent then
    vim.notify("magenta: init", vim.log.levels.INFO)
  end

  local __filename = debug.getinfo(1, "S").source:sub(2)
  local plugin_root = vim.fn.fnamemodify(__filename, ":p:h:h:h") .. "/bun/"

  local env = {
    IS_DEV = false,
    LOG_LEVEL = "debug"
  }

  vim.fn.jobstart(
    "bun run start",
    {
      cwd = plugin_root,
      stdin = "null",
      on_exit = Utils.log_exit(env.LOG_LEVEL),
      on_stdout = Utils.log_job(env.LOG_LEVEL),
      on_stderr = Utils.log_job(env.LOG_LEVEL),
      env = env
    }
  )
end

M.bridge = function(channelId)
  vim.api.nvim_create_user_command(
    "Magenta",
    function(opts)
      vim.rpcnotify(channelId, "magentaCommand", opts.args)
    end,
    {nargs = 1}
  )
end

M.lsp_response = function(channelId, requestId, response)
  vim.rpcnotify(channelId, "magentaLspResponse", {requestId, response})
end

return M

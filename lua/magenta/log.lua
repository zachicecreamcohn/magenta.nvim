local M = {}

local plenary_log = require('plenary.log')
M.log = plenary_log.new({
    plugin = 'magenta',
    level = "trace",
})

return M

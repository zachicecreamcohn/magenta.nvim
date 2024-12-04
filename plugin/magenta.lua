-- Create user commands for magenta
local magenta = require("magenta")

vim.api.nvim_create_user_command("MagentaShow", function() 
    magenta.show_sidebar()
end, {})

vim.api.nvim_create_user_command("MagentaHide", function()
    magenta.hide_sidebar()
end, {})

vim.api.nvim_create_user_command("MagentaSend", function()
    magenta.send_message()
end, {})

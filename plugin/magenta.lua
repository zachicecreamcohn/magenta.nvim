-- Create user commands for magenta
vim.api.nvim_create_user_command("MagentaShow", require("magenta").show_sidebar, {})
vim.api.nvim_create_user_command("MagentaHide", require("magenta").hide_sidebar, {})
vim.api.nvim_create_user_command("MagentaToggle", require("magenta").toggle_sidebar, {})

local M = {}

local defaults = {
  profiles = {
    {
      name = "claude-3-7",
      provider = "anthropic",
      model = "claude-3-7-sonnet-latest",
      api_key_env_var = "ANTHROPIC_API_KEY"
    },
    {
      name = "gpt-4o",
      provider = "openai",
      model = "gpt-4o",
      api_key_env_var = "OPENAI_API_KEY"
    }
  },
  picker = "fzf-lua",
  sidebar_position = "left",
  default_keymaps = true,
  sidebar_keymaps = {
    normal = {
      ["<CR>"] = ":Magenta send<CR>",
    }
  },
  inline_keymaps = {
    normal = {
      ["<CR>"] = function(target_bufnr)
        vim.cmd("Magenta submit-inline-edit " .. target_bufnr)
      end,
    },
  },
  command_allowlist = {
    "^ls( [^;&|()<>]*)?$",
    "^pwd$",
    "^echo( [^;&|()<>]*)?$",
    "^git (status|log|diff|show|add|commit|push|reset|restore|branch|checkout|switch|fetch|pull|merge|rebase|tag|stash)( [^;&|()<>]*)?$",
    "^ls [^;&()<>]* | grep [^;&|()<>]*$",
    "^echo [^;&|()<>]* > [a-zA-Z0-9_\\-.]+$",
    "^grep( -[A-Za-z]*)? [^;&|()<>]*$"
  }
}

M.options = defaults

M.set_options = function(opts)
  M.options = vim.tbl_deep_extend("force", defaults, opts or {})
  if opts.picker == nil then
    local pickers = { "fzf-lua", "telescope", "snacks" }
    for _, picker in ipairs(pickers) do
      local success, _ = pcall(require, picker)
      if success then
        M.options.picker = picker
        break
      end
    end
  end
end

return M

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
  }
}

M.options = defaults

M.set_options = function(opts)
  M.options = vim.tbl_deep_extend("force", defaults, opts or {})
  if (opts.picker == nil) then
    local success, _ = pcall(require, "fzf-lua")
    if success then
      M.options.picker = "fzf-lua"
    else
      success, _ = pcall(require, "telescope")
      if success then
        M.options.picker = "telescope"
      end
    end
  end
end

return M

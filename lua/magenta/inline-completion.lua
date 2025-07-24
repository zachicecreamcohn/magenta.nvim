local M = {}

-- Namespace for extmarks
M.ns_id = vim.api.nvim_create_namespace("magenta_inline_completion")

-- Set up highlight groups for inline completion
M.setup_highlight_groups = function()
  -- Create a custom highlight group for inline completions
  -- Use a subtle gray color that's dimmer than comments
  vim.cmd([[
    highlight default MagentaInlineCompletion ctermfg=8 guifg=#606060 gui=italic cterm=italic
    
    " Also create a link for compatibility
    highlight default link MagentaGhostText MagentaInlineCompletion
  ]])
end
-- Check if there's an active inline completion for a buffer
M.has_active_completion = function(bufnr)
  -- Check if there are any extmarks in our namespace for this buffer
  local extmarks = vim.api.nvim_buf_get_extmarks(
    bufnr, 
    M.ns_id, 
    0, 
    -1, 
    { details = false }
  )
  return #extmarks > 0
end

-- Set up keybindings for inline completion
M.setup_keybindings = function(opts)
  if not opts.inlineCompletion or not opts.inlineCompletion.enabled then
    return
  end

  -- Set up highlight groups first
  M.setup_highlight_groups()

  -- Set up accept/reject keybindings globally
  -- Primary keybindings (more intuitive)
  vim.keymap.set("i", "<Tab>", function()
    -- Check if there's an active inline completion
    local bufnr = vim.api.nvim_get_current_buf()
    local has_completion = M.has_active_completion(bufnr)
    
    if has_completion then
      vim.cmd("Magenta inline-accept")
    else
      -- Fall back to normal Tab behavior
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Tab>", true, false, true), "n", false)
    end
  end, { desc = "Magenta: Accept inline completion or insert tab" })

  -- Alternative keybindings (keep for compatibility)
  vim.keymap.set("i", "<C-y>", function()
    vim.cmd("Magenta inline-accept")
  end, { desc = "Magenta: Accept inline completion (alternative)" })

  -- Modified Escape behavior - reject completion but continue with normal Escape
  vim.keymap.set("i", "<Esc>", function()
    vim.cmd("Magenta inline-reject")
    -- Still want normal Escape behavior
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "n", false)
  end, { desc = "Magenta: Reject inline completion and exit insert mode" })
end

-- Set up auto-triggering events
M.setup_auto_trigger = function(opts)
  -- Always create the augroup, but clear it first
  local augroup = vim.api.nvim_create_augroup("MagentaInlineCompletion", { clear = true })
  
  -- If auto-trigger is disabled, just clear the augroup and return
  if not opts.inlineCompletion or not opts.inlineCompletion.enabled or not opts.inlineCompletion.autoTrigger then
    return
  end

  -- Track text changes in insert mode
  vim.api.nvim_create_autocmd({"TextChangedI"}, {
    group = augroup,
    callback = function()
      local bufnr = vim.api.nvim_get_current_buf()
      local pos = vim.api.nvim_win_get_cursor(0)
      local line = pos[1]
      local col = pos[2]
      
      -- Get the current line text
      local line_text = vim.api.nvim_buf_get_lines(bufnr, line - 1, line, false)[1] or ""
      
      -- Send buffer changed event
      vim.cmd("Magenta inline-buffer-changed " .. bufnr .. " " .. line .. " " .. col .. " " .. vim.fn.shellescape(line_text))
    end
  })

  -- Track cursor movements
  vim.api.nvim_create_autocmd({"CursorMovedI"}, {
    group = augroup,
    callback = function()
      local bufnr = vim.api.nvim_get_current_buf()
      local pos = vim.api.nvim_win_get_cursor(0)
      local line = pos[1]
      local col = pos[2]
      
      -- Send cursor moved event
      vim.cmd("Magenta inline-cursor-moved " .. bufnr .. " " .. line .. " " .. col)
    end
  })

  -- Clean up when leaving insert mode
  vim.api.nvim_create_autocmd({"InsertLeave"}, {
    group = augroup,
    callback = function()
      local bufnr = vim.api.nvim_get_current_buf()
      vim.cmd("Magenta inline-reject " .. bufnr)
    end
  })
end

-- Function to update auto-trigger settings at runtime
M.update_auto_trigger = function(enabled)
  -- Update the global options
  local Options = require("magenta.options")
  Options.options.inlineCompletion.autoTrigger = enabled
  
  -- Re-setup auto-trigger with the new settings
  M.setup_auto_trigger(Options.options)
end

return M
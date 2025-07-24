local M = {}

M.ns_id = vim.api.nvim_create_namespace("magenta_inline_completion")

local function should_enable_completion(bufnr)
	-- Check basic buffer properties
	if vim.bo[bufnr].buftype ~= "" or not vim.bo[bufnr].modifiable then
		return false
	end

	-- Check if this buffer is displayed in a magenta display window (but allow input buffer)
	local windows = vim.fn.win_findbuf(bufnr)
	for _, winid in ipairs(windows) do
		local magenta_display_var = vim.fn.getwinvar(winid, "magenta_display_window", vim.NIL)
		if magenta_display_var == true then
			return false -- This is a magenta display buffer, don't enable completion
		end
	end

	return true
end

M.setup_highlight_groups = function()
	vim.cmd([[
    highlight default MagentaInlineCompletion ctermfg=8 guifg=#606060 gui=italic cterm=italic

    highlight default link MagentaGhostText MagentaInlineCompletion
  ]])
end

M.has_active_completion = function(bufnr)
	local extmarks = vim.api.nvim_buf_get_extmarks(bufnr, M.ns_id, 0, -1, { details = false })
	return #extmarks > 0
end

M.setup_keybindings = function(opts)
	if not opts.inlineCompletion or not opts.inlineCompletion.enabled then
		return
	end

	M.setup_highlight_groups()

	vim.keymap.set("i", "<Tab>", function()
		local bufnr = vim.api.nvim_get_current_buf()

		if should_enable_completion(bufnr) then
			local has_completion = M.has_active_completion(bufnr)
			if has_completion then
				vim.cmd("Magenta inline-accept")
				return
			end
		end

		vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Tab>", true, false, true), "n", false)
	end, { desc = "Magenta: Accept inline completion or insert tab" })

	vim.keymap.set("i", "<C-y>", function()
		local bufnr = vim.api.nvim_get_current_buf()
		if should_enable_completion(bufnr) then
			vim.cmd("Magenta inline-accept")
		end
	end, { desc = "Magenta: Accept inline completion (alternative)" })

	vim.keymap.set("i", "<Esc>", function()
		local bufnr = vim.api.nvim_get_current_buf()
		if should_enable_completion(bufnr) then
			vim.cmd("Magenta inline-reject")
		end
		vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "n", false)
	end, { desc = "Magenta: Reject inline completion and exit insert mode" })
end

M.setup_auto_trigger = function(opts)
	local augroup = vim.api.nvim_create_augroup("MagentaInlineCompletion", { clear = true })

	if not opts.inlineCompletion or not opts.inlineCompletion.enabled or not opts.inlineCompletion.autoTrigger then
		return
	end

	vim.api.nvim_create_autocmd({ "TextChangedI" }, {
		group = augroup,
		callback = function()
			local bufnr = vim.api.nvim_get_current_buf()

			if not should_enable_completion(bufnr) then
				return
			end

			local pos = vim.api.nvim_win_get_cursor(0)
			local line = pos[1]
			local col = pos[2]

			local line_text = vim.api.nvim_buf_get_lines(bufnr, line - 1, line, false)[1] or ""

			vim.cmd(
				"Magenta inline-buffer-changed "
					.. bufnr
					.. " "
					.. line
					.. " "
					.. col
					.. " "
					.. vim.fn.shellescape(line_text)
			)
		end,
	})

	vim.api.nvim_create_autocmd({ "CursorMovedI" }, {
		group = augroup,
		callback = function()
			local bufnr = vim.api.nvim_get_current_buf()

			if not should_enable_completion(bufnr) then
				return
			end

			local pos = vim.api.nvim_win_get_cursor(0)
			local line = pos[1]
			local col = pos[2]

			vim.cmd("Magenta inline-cursor-moved " .. bufnr .. " " .. line .. " " .. col)
		end,
	})

	vim.api.nvim_create_autocmd({ "InsertLeave" }, {
		group = augroup,
		callback = function()
			local bufnr = vim.api.nvim_get_current_buf()
			vim.cmd("Magenta inline-reject " .. bufnr)
		end,
	})
end

M.update_auto_trigger = function(enabled)
	local Options = require("magenta.options")
	Options.options.inlineCompletion.autoTrigger = enabled

	M.setup_auto_trigger(Options.options)
end

return M

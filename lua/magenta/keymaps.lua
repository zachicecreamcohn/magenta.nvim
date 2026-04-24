local M = {}

local Actions = require("magenta.actions")
local Options = require("magenta.options")

M.default_keymaps = function()
  vim.keymap.set(
    "n",
    "<leader>mc",
    ":Magenta clear<CR>",
    { silent = true, noremap = true, desc = "Clear Magenta state" }
  )

  vim.keymap.set(
    "n",
    "<leader>ma",
    ":Magenta abort<CR>",
    { silent = true, noremap = true, desc = "Abort current Magenta operation" }
  )

  vim.keymap.set(
    "n",
    "<leader>mt",
    ":Magenta toggle<CR>",
    { silent = true, noremap = true, desc = "Toggle Magenta window" }
  )

  vim.keymap.set(
    "v",
    "<leader>mp",
    ":Magenta paste-selection<CR>",
    { silent = true, noremap = true, desc = "Send selection to Magenta" }
  )

  -- Global paste binding — routes clipboard (image or text) into the
  -- active thread's input buffer. Matches :Magenta paste; sidebar is
  -- auto-opened by node if it isn't already visible.
  vim.keymap.set("n", "<leader>mp", function()
    require("magenta.keymaps").do_paste()
  end, { silent = true, noremap = true, desc = "Magenta: paste clipboard into input buffer" })

  -- macOS/GUI-only convenience binding for the same action.
  vim.keymap.set({ "i", "n" }, "<D-v>", function()
    require("magenta.keymaps").do_paste()
  end, { silent = true, noremap = true, desc = "Magenta: paste clipboard into input buffer" })

  vim.keymap.set(
    "n",
    "<leader>mb", -- like "magenta buffer"?
    Actions.add_buffer_to_context,
    { silent = true, noremap = true, desc = "Add current buffer to Magenta context" }
  )

  vim.keymap.set(
    "n",
    "<leader>mf",
    Actions.pick_context_files,
    { silent = true, noremap = true, desc = "Select files to add to Magenta context" }
  )

  vim.keymap.set(
    "n",
    "<leader>mn",
    ":Magenta new-thread<CR>",
    { silent = true, noremap = true, desc = "Create a new thread" }
  )
  vim.keymap.set(
    "n",
    "<leader>mw",
    ":Magenta agent worktree<CR>",
    { silent = true, noremap = true, desc = "Create a new worktree orchestrator thread" }
  )

  vim.keymap.set(
    "n",
    "<leader>ms",
    ":Magenta sandbox-bypass<CR>",
    { silent = true, noremap = true, desc = "Toggle sandbox bypass for current thread tree" }
  )

end

local mode_to_keymap = {
  normal = "n",
  visual = "v",
  insert = "i",
  command = "c",
}

M.set_sidebar_buffer_keymaps = function(bufnr)
  for mode, values in pairs(Options.options.sidebarKeymaps) do
    for key, action in pairs(values) do
      vim.keymap.set(
        mode_to_keymap[mode],
        key,
        action,
        { buffer = bufnr, noremap = true, silent = true }
      )
    end
  end
end

-- Module-scoped state for paste handlers. We wrap vim.paste once (globally),
-- but only transform input in buffers we've registered here. This lets
-- multiple per-thread input buffers share the same wrapper.
local paste_input_bufnrs = {}
local original_paste = nil

-- Strip one pair of surrounding single/double quotes if present.
local function strip_outer_quotes(s)
  if #s >= 2 then
    local first = s:sub(1, 1)
    local last = s:sub(#s, #s)
    if (first == '"' and last == '"') or (first == "'" and last == "'") then
      return s:sub(2, #s - 1)
    end
  end
  return s
end

-- Shell-unescape: turn every `\<char>` into `<char>` literal. Not a full shell
-- parser, just enough to undo the escaping terminals apply when delivering a
-- dragged file path.
local function shell_unescape(s)
  local out = {}
  local i = 1
  while i <= #s do
    local ch = s:sub(i, i)
    if ch == "\\" and i < #s then
      out[#out + 1] = s:sub(i + 1, i + 1)
      i = i + 2
    else
      out[#out + 1] = ch
      i = i + 1
    end
  end
  return table.concat(out)
end

-- Produce an `@file:` reference using the same rules as node's formatFileRef.
local function format_file_ref(p)
  local has_ws = p:find("%s") ~= nil
  local has_tick = p:find("`") ~= nil
  if not has_ws and not has_tick then
    return "@file:" .. p
  end
  if not has_tick then
    return "@file:`" .. p .. "`"
  end
  local escaped = p:gsub("\\", "\\\\"):gsub("`", "\\`")
  return "@file:``" .. escaped .. "``"
end

local function try_detect_dropped_path(lines)
  if type(lines) ~= "table" or #lines == 0 then
    return nil
  end
  local joined = table.concat(lines, "\n")
  -- Trim surrounding whitespace.
  joined = joined:gsub("^%s+", ""):gsub("%s+$", "")
  if joined == "" then
    return nil
  end
  joined = strip_outer_quotes(joined)
  local unescaped = shell_unescape(joined)
  local stat = (vim.uv or vim.loop).fs_stat(unescaped)
  if stat and stat.type == "file" then
    return unescaped
  end
  return nil
end

-- Module-level channel_id. Stashed by the first set_paste_handlers call so
-- M.do_paste (invoked from the :Magenta dispatcher) can reach node.
local magenta_channel_id = nil

-- Shared paste routine used by :Magenta paste and the <D-v>/<leader>mp
-- keymaps. Probes the clipboard for an image and routes to node for
-- `@file:` insertion; otherwise forwards the clipboard text to node so it
-- can be appended to the active thread's input buffer (opening the sidebar
-- first if needed). Callable from any buffer — the node side addresses
-- `activeBuffers.inputBuffer` directly.
M.do_paste = function()
  if not magenta_channel_id then
    vim.api.nvim_err_writeln(
      "Magenta: input buffer not ready yet — is the node process running?")
    return
  end
  if vim.fn.has("mac") == 1 then
    local ok, result = pcall(vim.fn.system, "osascript -e 'clipboard info'")
    if ok and type(result) == "string" and result:find("class PNGf", 1, true) then
      vim.rpcnotify(magenta_channel_id, "magentaClipboardImagePaste", {})
      return
    end
  end
  local text = vim.fn.getreg("+")
  if text == nil or text == "" then
    return
  end
  vim.rpcnotify(magenta_channel_id, "magentaClipboardTextPaste", { text = text })
end

M.set_paste_handlers = function(bufnr, channel_id)
  paste_input_bufnrs[bufnr] = true
  magenta_channel_id = channel_id

  if not original_paste then
    original_paste = vim.paste
    vim.paste = function(lines, phase)
      local cur = vim.api.nvim_get_current_buf()
      if paste_input_bufnrs[cur] then
        local detected = try_detect_dropped_path(lines)
        if detected then
          return original_paste({ format_file_ref(detected) }, phase)
        end
      end
      return original_paste(lines, phase)
    end
  end

  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = bufnr,
    once = true,
    callback = function()
      paste_input_bufnrs[bufnr] = nil
    end,
  })
end

M.set_display_buffer_keymaps = function(bufnr)
  for mode, values in pairs(Options.options.displayKeymaps) do
    for key, action in pairs(values) do
      vim.keymap.set(
        mode_to_keymap[mode],
        key,
        action,
        { buffer = bufnr, noremap = true, silent = true }
      )
    end
  end
end

return M

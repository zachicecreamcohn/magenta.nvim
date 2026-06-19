-- LSP CompletionItemKind numeric constants.
-- Mirrors the values used by completion frontends (nvim-cmp's
-- cmp.lsp.CompletionItemKind / blink.cmp's types), so the magenta completion
-- sources don't need to depend on any particular completion plugin.
local M = {
  Text = 1,
  Keyword = 14,
  File = 17,
  Folder = 19,
}

return M

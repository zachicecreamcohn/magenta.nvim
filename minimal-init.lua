vim.opt.runtimepath:append(".")
require("magenta")

vim.api.nvim_create_autocmd(
  "FileType",
  {
    -- This handler will fire when the buffer's 'filetype' is "python"
    pattern = "typescript",
    callback = function(ev)
      vim.lsp.start(
        {
          name = "ts_ls",
          cmd = {"typescript-language-server", "--stdio"},
          root_dir = vim.fs.root(ev.buf, {"tsconfig.json", "package.json"})
        }
      )
    end
  }
)

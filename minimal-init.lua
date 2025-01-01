vim.opt.runtimepath:append(".")
require("magenta")

vim.api.nvim_create_autocmd(
  "FileType",
  {
    pattern = "typescript",
    callback = function(ev)
      vim.notify("FileType autocmd")
      local root_dir = vim.fs.root(ev.buf, {"tsconfig.json", "package.json"})
      if not root_dir then
        root_dir = vim.fn.getcwd()
      end

      -- Check if typescript-language-server is available
      local ts_server = vim.fn.exepath("typescript-language-server")
      vim.notify("typescript-language-server path: " .. (ts_server ~= "" and ts_server or "not found"))

      -- Capture any config validation errors
      local config = {
        name = "ts_ls",
        cmd = {"typescript-language-server", "--stdio"},
        root_dir = root_dir,
        on_init = function(client, initialize_result)
          vim.notify("LSP client initialized with capabilities: " .. vim.inspect(initialize_result.capabilities))
          return true
        end,
        on_exit = function(code, signal, client_id)
          vim.notify(string.format("LSP client exited with code %d, signal %s", code, signal))
        end,
        on_error = function(code, msg)
          vim.notify(string.format("LSP client error: %s (code: %s)", msg, code), vim.log.levels.ERROR)
        end
      }

      local ok, err =
        pcall(
        function()
          local client_id = vim.lsp.start(config)
          if client_id then
            vim.notify("Started LSP client with ID: " .. client_id)
            -- Check if client actually attached
            vim.defer_fn(
              function()
                local clients = vim.lsp.get_active_clients({bufnr = ev.buf})
                vim.notify("Active clients after start: " .. vim.inspect(clients))
              end,
              100
            )
          else
            vim.notify("Failed to start LSP client", vim.log.levels.ERROR)
          end
        end
      )

      if not ok then
        vim.notify("Error starting LSP: " .. tostring(err), vim.log.levels.ERROR)
      end
    end
  }
)

vim.api.nvim_create_autocmd(
  {"LspAttach", "LspDetach"},
  {
    callback = function(ev)
      vim.notify(
        string.format(
          "LSP %s - client: %s, bufnr: %d",
          ev.event,
          vim.lsp.get_client_by_id(ev.data.client_id).name,
          ev.buf
        )
      )
    end
  }
)

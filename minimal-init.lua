-- Get the directory where this init file is located (project root)
local init_file_path = debug.getinfo(1, "S").source:sub(2)
local project_root = vim.fn.fnamemodify(init_file_path, ":h")

-- Add project root to runtimepath so we can find the magenta module
vim.opt.runtimepath:append(project_root)
-- Also add current directory for any test-specific files
vim.opt.runtimepath:append(".")

-- Add test plugins directory if it exists
local test_plugins_dir = project_root .. "/test-plugins"
if vim.fn.isdirectory(test_plugins_dir) == 1 then
  vim.opt.runtimepath:append(test_plugins_dir .. "/nvim-cmp")

  -- Configure nvim-cmp for testing
  vim.defer_fn(function()
    local ok, cmp = pcall(require, 'cmp')
    if ok then
      cmp.setup({
        mapping = {
          ['<Down>'] = cmp.mapping.select_next_item(),
          ['<Up>'] = cmp.mapping.select_prev_item(),
          ['<CR>'] = cmp.mapping.confirm({ select = true }),
          ['<C-Space>'] = cmp.mapping.complete(),
        },
        sources = {
          { name = 'buffer', keyword_length = 1, option = { keyword_pattern = [[\k\+]] } },
        },
        completion = {
          autocomplete = { 'TextChanged', 'InsertEnter' },
        },
        enabled = function()
          -- Disable during command line and search modes
          if vim.api.nvim_get_mode().mode == 'c' then
            return false
          end
          return true
        end,
      })
    end
  end, 100)
end

-- Set default restrictive options for tests
_G.magenta_test_options = {
  profiles = {
    {
      name = "mock",
      provider = "mock"
    },
    {
      name = "mock2",
      provider = "mock"
    }
  },
  autoContext = {},
  chimeVolume = 0
}

-- Setup function that tests can call to configure options before bridge is established
_G.setup_test_options = function(options_json)
  -- Parse JSON string into a Lua table
  local options = vim.json.decode(options_json)

  -- Merge the provided options with existing test options
  -- All keys should be in camelCase to match TypeScript MagentaOptions
  for k, v in pairs(options) do
    _G.magenta_test_options[k] = v
  end

  -- Debug output to help troubleshoot option setting
  vim.notify("Test options set: " .. vim.inspect(_G.magenta_test_options))
end

require("magenta")

vim.api.nvim_create_autocmd(
  "FileType",
  {
    pattern = "typescript",
    callback = function(ev)
      vim.notify("FileType autocmd")
      local root_dir = vim.fs.root(ev.buf, { "tsconfig.json", "package.json" })
      if not root_dir then
        root_dir = vim.fn.getcwd()
      end

      -- Check if typescript-language-server is available
      local ts_server = vim.fn.exepath("typescript-language-server")
      vim.notify("typescript-language-server path: " .. (ts_server ~= "" and ts_server or "not found"))

      -- Capture any config validation errors
      local config = {
        name = "ts_ls",
        cmd = { "typescript-language-server", "--stdio" },
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
                    local clients = vim.lsp.get_clients({ bufnr = ev.buf })
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
  { "LspAttach", "LspDetach" },
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

local M = {}

local has_cmp, cmp = pcall(require, 'cmp')
if not has_cmp then
  vim.notify('nvim-cmp not found, magenta completion unavailable', vim.log.levels.WARN)
  return M
end

-- Import individual completion sources
local keywords = require('magenta.completion.keywords')
local file_buffers = require('magenta.completion.file_buffers')
local file_files = require('magenta.completion.file_files')
local diff_files = require('magenta.completion.diff_files')
local staged_files = require('magenta.completion.staged_files')

-- Initialize the completion sources
function M.setup()
  -- Register all individual completion sources
  cmp.register_source('magenta_keywords', keywords.create_source())
  cmp.register_source('magenta_file_buffers', file_buffers.create_source())
  cmp.register_source('magenta_file_files', file_files.create_source())
  cmp.register_source('magenta_diff_files', diff_files.create_source())
  cmp.register_source('magenta_staged_files', staged_files.create_source())

  -- Set up buffer-specific completion configuration for magenta input buffers
  vim.api.nvim_create_autocmd('BufEnter', {
    pattern = '*',
    callback = function()
      local bufnr = vim.api.nvim_get_current_buf()
      local buf_name = vim.api.nvim_buf_get_name(bufnr)

      -- Only activate magenta completion for magenta input buffers
      if buf_name:match('%[Magenta Input%]') then
        -- Set buffer variable for identification (used by is_available() as backup)
        vim.api.nvim_buf_set_var(bufnr, 'magenta_input_buffer', true)

        -- Get existing sources and append all magenta sources
        local existing_sources = cmp.get_config().sources or {}
        local sources_with_magenta = vim.deepcopy(existing_sources)

        -- List of all magenta sources
        local magenta_sources = {
          'magenta_keywords',
          'magenta_file_buffers',
          'magenta_file_files',
          'magenta_diff_files',
          'magenta_staged_files'
        }

        -- Check which magenta sources are already in the list
        local existing_source_names = {}
        for _, existingSource in ipairs(sources_with_magenta) do
          existing_source_names[existingSource.name] = true
        end

        -- Add missing magenta sources at the beginning for higher priority
        for i = #magenta_sources, 1, -1 do
          local source_name = magenta_sources[i]
          if not existing_source_names[source_name] then
            table.insert(sources_with_magenta, 1, { name = source_name })
          end
        end

        -- Configure nvim-cmp to use existing sources plus magenta sources for this buffer
        cmp.setup.buffer({
          sources = cmp.config.sources(sources_with_magenta)
        })
      end
    end,
    group = vim.api.nvim_create_augroup('MagentaCompletion', { clear = true })
  })
end

return M

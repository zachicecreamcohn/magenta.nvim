local text_utils = require('magenta.text-utils')

local LspServer = {}
LspServer.__index = LspServer

local capabilities = {
  textDocumentSync = {
    openClose = true, -- Need to track opens to get initial content
    change = 2,       -- Incremental changes
    save = false
  }
}

function LspServer.new(notify_fn, options)
  local self = setmetatable({}, LspServer)
  self.notify_fn = notify_fn
  self.client_id = nil
  self.documents = {} -- Track file contents { [filePath] = { lines = {}, version = number } }
  self.options = options or {}

  -- Manual debouncing setup
  self.change_buffer = {} -- Simple array of raw params
  self.flush_timer = nil
  self.debounce_interval = self.options.changeDebounceMs or 500

  return self
end

function LspServer:flush_changes()
  if not self.notify_fn or #self.change_buffer == 0 then
    return
  end

  if self.options.debug then
    print(string.format("[MAGENTA LSP] Flushing %d buffered change events", #self.change_buffer))
  end

  -- Group params by file path
  local files_to_process = {}
  for _, params in ipairs(self.change_buffer) do
    local uri = params.textDocument.uri
    local file_path = vim.uri_to_fname(uri)

    if not files_to_process[file_path] then
      files_to_process[file_path] = {}
    end
    table.insert(files_to_process[file_path], params)
  end

  for file_path, params_list in pairs(files_to_process) do
    local doc = self.documents[file_path]

    if not doc then
      -- Try to initialize from buffer if document not tracked
      local bufnr = vim.fn.bufnr(file_path)
      if bufnr ~= -1 and vim.api.nvim_buf_is_loaded(bufnr) then
        -- Use version from first params to initialize
        local first_params = params_list[1]
        doc = {
          lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false),
          version = first_params.textDocument.version - 1
        }
        self.documents[file_path] = doc
      else
        -- Skip this file if we can't track it
        goto continue
      end
    end

    -- Save initial document state before applying all changes
    local old_lines = {}
    for i = 1, #doc.lines do
      old_lines[i] = doc.lines[i]
    end

    -- Apply all buffered changes for this file in order
    for _, params in ipairs(params_list) do
      for _, change in ipairs(params.contentChanges) do
        if change.range then
          text_utils.apply_change(doc.lines, change.range, change.text)
        end
      end
      doc.version = params.textDocument.version
    end

    -- Extract the final diff after all changes
    local diff = text_utils.extract_diff(old_lines, doc.lines)

    -- Only include files that actually changed
    if diff.oldText ~= diff.newText then
      self.notify_fn({
        filePath = file_path,
        oldText = diff.oldText,
        newText = diff.newText,
        range = diff.range
      })
    end

    ::continue::
  end

  self.change_buffer = {}
end

function LspServer:schedule_flush()
  -- Cancel existing timer if it exists
  if self.flush_timer then
    vim.fn.timer_stop(self.flush_timer)
  end

  -- Schedule new flush
  self.flush_timer = vim.fn.timer_start(self.debounce_interval, function()
    self:flush_changes()
    self.flush_timer = nil
  end)
end

function LspServer:create_methods()
  local methods = {}

  function methods.initialize(_, callback)
    return callback(nil, { capabilities = capabilities })
  end

  function methods.shutdown(_, callback)
    return callback(nil, nil)
  end

  methods['textDocument/didOpen'] = function(params, _)
    local uri = params.textDocument.uri
    local file_path = vim.uri_to_fname(uri)
    local content = params.textDocument.text

    -- Initialize document tracking
    local lines = text_utils.split_lines(content)

    self.documents[file_path] = {
      lines = lines,
      version = params.textDocument.version
    }
  end

  methods['textDocument/didChange'] = function(params, _)
    if not self.notify_fn then return end
    table.insert(self.change_buffer, params)
    self:schedule_flush()
  end

  return methods
end

function LspServer:extract_range_text(lines, range)
  local start_line = range.start.line + 1 -- Lua is 1-indexed
  local start_char = range.start.character + 1
  local end_line = range['end'].line + 1
  local end_char = range['end'].character + 1

  if start_line == end_line then
    -- Single line change
    local line = lines[start_line] or ""
    return string.sub(line, start_char, end_char - 1)
  else
    -- Multi-line change
    local result = {}

    -- First line (from start_char to end)
    local first_line = lines[start_line] or ""
    table.insert(result, string.sub(first_line, start_char))

    -- Middle lines (complete lines)
    for i = start_line + 1, end_line - 1 do
      table.insert(result, lines[i] or "")
    end

    -- Last line (from start to end_char)
    if end_line <= #lines then
      local last_line = lines[end_line] or ""
      table.insert(result, string.sub(last_line, 1, end_char - 1))
    end

    return table.concat(result, "\n")
  end
end

function LspServer:create_server_cmd()
  local request_id = 0
  local methods = self:create_methods()

  return function()
    local server = {}

    function server.request(method, params, callback)
      local method_impl = methods[method]
      if method_impl then
        method_impl(params, callback)
      end
      request_id = request_id + 1
      return true, request_id
    end

    function server.notify(method, params)
      local method_impl = methods[method]
      if method_impl then
        method_impl(params, function() end)
      end
      return false
    end

    function server.is_closing()
      return false
    end

    function server.terminate()
      -- No cleanup needed
    end

    return server
  end
end

function LspServer:start()
  local cmd = self:create_server_cmd()

  self.client_id = vim.lsp.start({
    cmd = cmd,
    name = 'magenta-lsp',
    root_dir = vim.fn.getcwd(),
    flags = {
      allow_incremental_sync = true
    }
  }, {
    attach = false
  })

  return self.client_id
end

function LspServer:stop()
  -- Clean up timer if it exists
  if self.flush_timer then
    vim.fn.timer_stop(self.flush_timer)
    self.flush_timer = nil
  end

  -- Flush any remaining changes before stopping
  self:flush_changes()

  if self.client_id then
    vim.lsp.stop_client(self.client_id)
    self.client_id = nil
  end
end

return LspServer

local LspServer = {}
LspServer.__index = LspServer

local capabilities = {
  textDocumentSync = {
    openClose = true, -- Need to track opens to get initial content
    change = 2,       -- Incremental changes
    save = false
  }
}

function LspServer.new(notify_fn)
  local self = setmetatable({}, LspServer)
  self.notify_fn = notify_fn
  self.client_id = nil
  self.documents = {} -- Track file contents { [filePath] = { lines = {}, version = number } }
  return self
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
    local lines = {}
    for line in content:gmatch("[^\r\n]*") do
      table.insert(lines, line)
    end

    self.documents[file_path] = {
      lines = lines,
      version = params.textDocument.version
    }
  end

  methods['textDocument/didChange'] = function(params, _)
    if not self.notify_fn then return end

    local uri = params.textDocument.uri
    local file_path = vim.uri_to_fname(uri)
    local doc = self.documents[file_path]

    if not doc then
      -- Document not tracked, try to initialize from buffer
      local bufnr = vim.fn.bufnr(file_path)
      if bufnr ~= -1 and vim.api.nvim_buf_is_loaded(bufnr) then
        doc = {
          lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false),
          version = params.textDocument.version - 1
        }
        self.documents[file_path] = doc
      else
        return -- Can't track without initial content
      end
    end

    -- Save old document state
    local old_lines = {}
    for i = 1, #doc.lines do
      old_lines[i] = doc.lines[i]
    end

    -- Apply all changes to the document
    for _, change in ipairs(params.contentChanges) do
      if change.range then
        self:apply_change(doc.lines, change.range, change.text)
      end
    end

    -- Find minimal range by scanning from start and end
    local start_line = 1
    local min_len = math.min(#old_lines, #doc.lines)

    -- Scan from beginning until we find a difference
    while start_line <= min_len and old_lines[start_line] == doc.lines[start_line] do
      start_line = start_line + 1
    end

    -- Scan from end until we find a difference
    local old_end_line = #old_lines
    local new_end_line = #doc.lines
    while old_end_line >= start_line and new_end_line >= start_line and
      old_lines[old_end_line] == doc.lines[new_end_line] do
      old_end_line = old_end_line - 1
      new_end_line = new_end_line - 1
    end

    -- Extract the changed ranges
    local old_changed_lines = {}
    for i = start_line, old_end_line do
      table.insert(old_changed_lines, old_lines[i] or "")
    end

    local new_changed_lines = {}
    for i = start_line, new_end_line do
      table.insert(new_changed_lines, doc.lines[i] or "")
    end

    local old_text = table.concat(old_changed_lines, "\n")
    local new_text = table.concat(new_changed_lines, "\n")

    self.notify_fn({
      filePath = file_path,
      oldText = old_text,
      newText = new_text,
      range = {
        start = { line = start_line - 1, character = 0 }, -- Convert to 0-indexed
        ['end'] = { line = old_end_line, character = 0 }
      }
    })

    doc.version = params.textDocument.version
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

function LspServer:apply_change(lines, range, new_text)
  local start_line = range.start.line + 1 -- Lua is 1-indexed
  local start_char = range.start.character + 1
  local end_line = range['end'].line + 1
  local end_char = range['end'].character + 1

  -- Split new text into lines
  local new_lines = {}
  for line in new_text:gmatch("[^\r\n]*") do
    table.insert(new_lines, line)
  end
  if #new_lines == 0 then
    new_lines = { "" }
  end

  if start_line == end_line then
    -- Single line change
    local line = lines[start_line] or ""
    local before = string.sub(line, 1, start_char - 1)
    local after = string.sub(line, end_char)

    if #new_lines == 1 then
      -- Replace with single line
      lines[start_line] = before .. new_lines[1] .. after
    else
      -- Replace with multiple lines
      lines[start_line] = before .. new_lines[1]
      for i = 2, #new_lines - 1 do
        table.insert(lines, start_line + i - 1, new_lines[i])
      end
      table.insert(lines, start_line + #new_lines - 1, new_lines[#new_lines] .. after)
    end
  else
    -- Multi-line change
    local first_line = lines[start_line] or ""
    local last_line = lines[end_line] or ""
    local before = string.sub(first_line, 1, start_char - 1)
    local after = string.sub(last_line, end_char)

    -- Remove old lines
    for i = end_line, start_line, -1 do
      table.remove(lines, i)
    end

    -- Insert new lines
    for i = #new_lines, 1, -1 do
      local line_content = new_lines[i]
      if i == 1 then
        line_content = before .. line_content
      end
      if i == #new_lines then
        line_content = line_content .. after
      end
      table.insert(lines, start_line, line_content)
    end
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
      allow_incremental_sync = true,
      debounce_text_changes = 150 -- ms
    }
  }, {
    attach = false
  })

  return self.client_id
end

function LspServer:stop()
  if self.client_id then
    vim.lsp.stop_client(self.client_id)
    self.client_id = nil
  end
end

return LspServer


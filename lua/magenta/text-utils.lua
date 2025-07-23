-- Text manipulation utilities for LSP document changes
local M = {}

-- Split text into lines by scanning for \n characters
-- @param text string: The text to split
-- @return table: Array of lines
local function split_lines(text)
  if text == "" then
    return { "" }
  end

  local lines = {}
  local start = 1

  for i = 1, #text do
    if text:byte(i) == 10 then -- 10 is ASCII code for '\n'
      table.insert(lines, text:sub(start, i - 1))
      start = i + 1
    end
  end

  table.insert(lines, text:sub(start))

  return lines
end

-- Public function for splitting text into lines
-- @param text string: The text to split
-- @return table: Array of lines
M.split_lines = split_lines

-- Apply a text change to a document represented as an array of lines
-- @param lines table: Array of strings representing document lines (1-indexed)
-- @param range table: LSP range with start/end positions (0-indexed)
-- @param new_text string: The replacement text
function M.apply_change(lines, range, new_text)
  local start_line = range.start.line + 1 -- Convert to 1-indexed
  local start_char = range.start.character + 1
  local end_line = range['end'].line + 1
  local end_char = range['end'].character + 1

  -- Split new text into lines
  local new_lines = split_lines(new_text)

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

-- Extract the changed range between two versions of a document
-- @param old_lines table: Array of strings representing the old document lines
-- @param new_lines table: Array of strings representing the new document lines
-- @return table: { oldText = string, newText = string, range = { start = {line, character}, end = {line, character} } }
function M.extract_diff(old_lines, new_lines)
  -- Find the first changed line (scanning from top)
  local last_same_line = 0
  local num_old_lines = #old_lines
  local num_new_lines = #new_lines
  local max_lines = math.max(num_old_lines, num_new_lines)

  for i = 1, max_lines do
    local old_line = old_lines[i]
    local new_line = new_lines[i]

    if old_line == new_line then
      last_same_line = i
    else
      break
    end
  end

  -- Find the last same line (scanning from bottom)
  local last_same_offset = 0
  for i = 0, max_lines - 1 do
    local old_idx = num_old_lines - i
    local new_idx = num_new_lines - i
    local old_line = old_lines[old_idx]
    local new_line = new_lines[new_idx]

    if old_line == new_line then
      last_same_offset = i
    else
      break
    end
  end

  -- Calculate the actual end lines for extraction
  local old_end_line = num_old_lines - last_same_offset
  local new_end_line = num_new_lines - last_same_offset

  -- Add one line of context before and after, with boundary checks
  local old_start_line = math.max(1, last_same_line - 1)
  local new_start_line = math.max(1, last_same_line - 1)
  local old_extract_end = math.min(num_old_lines, old_end_line + 1)
  local new_extract_end = math.min(num_new_lines, new_end_line + 1)

  -- Handle the case where no changes were found
  if last_same_line == max_lines then
    -- All lines are the same, extract all lines
    old_start_line = 1
    new_start_line = 1
    old_extract_end = num_old_lines
    new_extract_end = num_new_lines
  end

  -- Extract the full changed lines from both old and new versions
  local old_changed_lines = {}
  for i = old_start_line, old_extract_end do
    table.insert(old_changed_lines, old_lines[i] or "")
  end

  local new_changed_lines = {}
  for i = new_start_line, new_extract_end do
    table.insert(new_changed_lines, new_lines[i] or "")
  end

  local old_text = table.concat(old_changed_lines, "\n")
  local new_text = table.concat(new_changed_lines, "\n")

  -- Calculate proper range bounds
  local range_start_line = math.max(0, old_start_line - 1)              -- Convert to 0-indexed
  local range_end_line = math.max(old_extract_end, new_extract_end) - 1 -- Convert to 0-indexed

  return {
    oldText = old_text,
    newText = new_text,
    range = {
      start = { line = range_start_line, character = 0 },
      ['end'] = { line = range_end_line, character = 0 }
    }
  }
end

return M

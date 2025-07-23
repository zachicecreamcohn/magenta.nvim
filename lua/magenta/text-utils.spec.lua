local text_utils = require('lua.magenta.text-utils')

-- Simple test framework
local tests = {}
local function test(name, fn)
  table.insert(tests, { name = name, fn = fn })
end

local function assert_equal(actual, expected, message)
  if actual ~= expected then
    error(string.format("Assertion failed: %s\nExpected: %s\nActual: %s",
      message or "", tostring(expected), tostring(actual)))
  end
end

local function assert_table_equal(actual, expected, message)
  if #actual ~= #expected then
    error(string.format("Assertion failed: %s\nTable lengths differ. Expected: %d, Actual: %d",
      message or "", #expected, #actual))
  end

  for i = 1, #expected do
    if actual[i] ~= expected[i] then
      error(string.format("Assertion failed: %s\nAt index %d - Expected: %s, Actual: %s",
        message or "", i, tostring(expected[i]), tostring(actual[i])))
    end
  end
end

-- Test cases
test("single line replacement", function()
  local lines = { "hello world" }
  local range = {
    start = { line = 0, character = 6 },
    ['end'] = { line = 0, character = 11 }
  }
  text_utils.apply_change(lines, range, "there")
  assert_table_equal(lines, { "hello there" }, "Should replace 'world' with 'there'")
end)

test("single line insertion", function()
  local lines = { "hello world" }
  local range = {
    start = { line = 0, character = 5 },
    ['end'] = { line = 0, character = 5 }
  }
  text_utils.apply_change(lines, range, " beautiful")
  assert_table_equal(lines, { "hello beautiful world" }, "Should insert ' beautiful' at position 5")
end)

test("single line deletion", function()
  local lines = { "hello beautiful world" }
  local range = {
    start = { line = 0, character = 5 },
    ['end'] = { line = 0, character = 15 }
  }
  text_utils.apply_change(lines, range, "")
  assert_table_equal(lines, { "hello world" }, "Should delete ' beautiful'")
end)

test("single line to multi-line replacement", function()
  local lines = { "hello world" }
  local range = {
    start = { line = 0, character = 6 },
    ['end'] = { line = 0, character = 11 }
  }
  text_utils.apply_change(lines, range, "there\neveryone")
  assert_table_equal(lines, { "hello there", "everyone" }, "Should split line at replacement")
end)

test("multi-line to single line replacement", function()
  local lines = { "hello", "world", "everyone" }
  local range = {
    start = { line = 0, character = 5 },
    ['end'] = { line = 2, character = 0 }
  }
  text_utils.apply_change(lines, range, " ")
  assert_table_equal(lines, { "hello everyone" }, "Should join lines with space")
end)

test("multi-line replacement", function()
  local lines = { "line 1", "line 2", "line 3" }
  local range = {
    start = { line = 0, character = 0 },
    ['end'] = { line = 2, character = 6 }
  }
  text_utils.apply_change(lines, range, "new content\nreplacement")
  assert_table_equal(lines, { "new content", "replacement" }, "Should replace all content")
end)

test("insert at beginning of file", function()
  local lines = { "existing" }
  local range = {
    start = { line = 0, character = 0 },
    ['end'] = { line = 0, character = 0 }
  }
  text_utils.apply_change(lines, range, "new\n")
  assert_table_equal(lines, { "new", "existing" }, "Should insert at beginning")
end)

test("insert at end of file", function()
  local lines = { "existing" }
  local range = {
    start = { line = 0, character = 8 },
    ['end'] = { line = 0, character = 8 }
  }
  text_utils.apply_change(lines, range, "\nnew")
  assert_table_equal(lines, { "existing", "new" }, "Should insert at end")
end)

test("empty replacement", function()
  local lines = { "hello world" }
  local range = {
    start = { line = 0, character = 5 },
    ['end'] = { line = 0, character = 11 }
  }
  text_utils.apply_change(lines, range, "")
  assert_table_equal(lines, { "hello" }, "Should delete specified range")
end)

test("replace with empty string in multiline", function()
  local lines = { "line 1", "line 2", "line 3" }
  local range = {
    start = { line = 1, character = 0 },
    ['end'] = { line = 1, character = 6 }
  }
  text_utils.apply_change(lines, range, "")
  assert_table_equal(lines, { "line 1", "", "line 3" }, "Should empty the middle line")
end)

-- Tests for extract_diff function
test("diff - single line change", function()
  local old_lines = { "hello world" }
  local new_lines = { "hello there" }
  local diff = text_utils.extract_diff(old_lines, new_lines)
  assert_equal(diff.oldText, "hello world", "Should extract old text")
  assert_equal(diff.newText, "hello there", "Should extract new text")
  assert_equal(diff.range.start.line, 0, "Should start at line 0")
  assert_equal(diff.range['end'].line, 0, "Should end at line 0")
end)

test("diff - single line addition", function()
  local old_lines = { "line 1" }
  local new_lines = { "line 1", "line 2" }
  local diff = text_utils.extract_diff(old_lines, new_lines)
  assert_equal(diff.oldText, "line 1", "Should extract old text")
  assert_equal(diff.newText, "line 1\nline 2", "Should extract new text with added line")
end)

test("diff - middle line change with context", function()
  local old_lines = { "first", "old middle", "last" }
  local new_lines = { "first", "new middle", "last" }
  local diff = text_utils.extract_diff(old_lines, new_lines)
  assert_equal(diff.oldText, "first\nold middle\nlast", "Should include context lines")
  assert_equal(diff.newText, "first\nnew middle\nlast", "Should include context lines")
end)

test("diff - no changes", function()
  local old_lines = { "same", "same", "same" }
  local new_lines = { "same", "same", "same" }
  local diff = text_utils.extract_diff(old_lines, new_lines)
  assert_equal(diff.oldText, "same\nsame\nsame", "Should extract all lines when no changes")
  assert_equal(diff.newText, "same\nsame\nsame", "Should extract all lines when no changes")
end)

test("diff - line deletion", function()
  local old_lines = { "line 1", "line 2", "line 3" }
  local new_lines = { "line 1", "line 3" }
  local diff = text_utils.extract_diff(old_lines, new_lines)
  assert_equal(diff.oldText, "line 1\nline 2\nline 3", "Should include deleted line")
  assert_equal(diff.newText, "line 1\nline 3", "Should show result after deletion")
end)

test("diff - multiple line changes", function()
  local old_lines = { "unchanged", "old 1", "old 2", "unchanged" }
  local new_lines = { "unchanged", "new 1", "new 2", "new 3", "unchanged" }
  local diff = text_utils.extract_diff(old_lines, new_lines)
  assert_equal(diff.oldText, "unchanged\nold 1\nold 2\nunchanged", "Should include context")
  assert_equal(diff.newText, "unchanged\nnew 1\nnew 2\nnew 3\nunchanged", "Should include context")
end)

test("diff - insert at beginning", function()
  local old_lines = { "original" }
  local new_lines = { "new first", "original" }
  local diff = text_utils.extract_diff(old_lines, new_lines)
  assert_equal(diff.oldText, "original", "Should extract original")
  assert_equal(diff.newText, "new first\noriginal", "Should show insertion at beginning")
end)

test("diff - insert at end", function()
  local old_lines = { "original" }
  local new_lines = { "original", "new last" }
  local diff = text_utils.extract_diff(old_lines, new_lines)
  assert_equal(diff.oldText, "original", "Should extract original")
  assert_equal(diff.newText, "original\nnew last", "Should show insertion at end")
end)

-- Test reproducing the character-by-character typing issue from change-tracker.spec.ts
-- Test document initialization from different sources
test("document initialization consistency", function()
  -- Test how we split content vs how nvim represents lines
  local content1 = "function hello() {\n  return 'world';\n}"

  -- Method 1: How didOpen splits content
  local lines1 = text_utils.split_lines(content1)

  -- Method 2: How nvim would represent the same content
  local lines2 = { "function hello() {", "  return 'world';", "}" }

  -- These should be equivalent
  assert_equal(#lines1, #lines2, "Line counts should match")
  for i = 1, #lines1 do
    assert_equal(lines1[i], lines2[i], string.format("Line %d should match", i))
  end
end)

test("document state consistency after changes", function()
  -- Start with a document like we'd see from the test
  local lines = { "function hello() {", "  return 'world';", "}" }
  local old_lines = {}
  for i = 1, #lines do
    old_lines[i] = lines[i]
  end

  text_utils.apply_change(lines, {
    start = { line = 1, character = 10 },
    ['end'] = { line = 1, character = 15 }
  }, "")

  -- Then insert characters one by one starting at position 11 (where 'world' was)
  local chars = { "u", "n", "i", "v", "e", "r", "s", "e" }
  local pos = 10 -- Start at position where 'world' was deleted
  for _, char in ipairs(chars) do
    text_utils.apply_change(lines, {
      start = { line = 1, character = pos },
      ['end'] = { line = 1, character = pos }
    }, char)
    pos = pos + 1
  end

  -- Result should be clean
  assert_equal(#lines, 3, "Should still have 3 lines")
  assert_equal(lines[1], "function hello() {", "First line unchanged")
  assert_equal(lines[2], "  return 'universe';", "Second line should have 'universe'")
  assert_equal(lines[3], "}", "Third line unchanged")

  -- Now test the diff extraction
  local diff = text_utils.extract_diff(old_lines, lines)
  -- The diff should be reasonable, not have tons of newlines
  local newline_count = 0
  local start = 1
  while true do
    local pos = diff.newText:find("\n", start)
    if not pos then break end
    newline_count = newline_count + 1
    start = pos + 1
  end

  -- Should have 2 newlines (between the 3 lines), not 25
  assert_equal(newline_count, 2,
    string.format("Should have 2 newlines, got %d. newText: %q", newline_count, diff.newText))
end)

-- Run all tests
local function run_tests()
  local passed = 0
  local failed = 0

  for _, test_case in ipairs(tests) do
    local success, err = pcall(test_case.fn)
    if success then
      print("✓ " .. test_case.name)
      passed = passed + 1
    else
      print("✗ " .. test_case.name)
      print("  " .. err)
      failed = failed + 1
    end
  end

  print(string.format("\nResults: %d passed, %d failed", passed, failed))
  return failed == 0
end

-- Only run tests if this file is executed directly
if arg and arg[0] and arg[0]:match("text%-utils%.spec%.lua$") then
  run_tests()
end

test("character insertion should not add extra empty lines", function()
  -- Start with an empty document (single empty line)
  local lines = { '' }

  -- Insert 'c' at position (0,0) - should result in just one line: 'c'
  text_utils.apply_change(lines, {
    start = { line = 0, character = 0 },
    ['end'] = { line = 0, character = 0 }
  }, 'c')

  -- Should have exactly 1 line with content 'c'
  assert_equal(#lines, 1, "Should have exactly 1 line after inserting 'c'")
  assert_equal(lines[1], 'c', "First line should contain 'c'")

  -- Insert 'o' at position (0,1) - should result in one line: 'co'
  text_utils.apply_change(lines, {
    start = { line = 0, character = 1 },
    ['end'] = { line = 0, character = 1 }
  }, 'o')

  -- Should still have exactly 1 line with content 'co'
  assert_equal(#lines, 1, "Should have exactly 1 line after inserting 'o'")
  assert_equal(lines[1], 'co', "First line should contain 'co'")

  -- Insert 'n' at position (0,2) - should result in one line: 'con'
  text_utils.apply_change(lines, {
    start = { line = 0, character = 2 },
    ['end'] = { line = 0, character = 2 }
  }, 'n')

  -- Should still have exactly 1 line with content 'con'
  assert_equal(#lines, 1, "Should have exactly 1 line after inserting 'n'")
  assert_equal(lines[1], 'con', "First line should contain 'con'")
end)

return { run_tests = run_tests }

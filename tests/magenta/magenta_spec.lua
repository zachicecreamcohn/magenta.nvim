local magenta = require("magenta")

describe("magenta", function()
  before_each(function()
    magenta.setup()
  end)

  after_each(function()
    magenta.hide_sidebar()
  end)

  describe("show_sidebar", function()
    it("creates a sidebar", function()
      local initial_wins = #vim.api.nvim_list_wins()

      magenta.show_sidebar()

      local final_wins = #vim.api.nvim_list_wins()
      assert.equals(initial_wins + 1, final_wins)
    end)
  end)

  describe("toggle_sidebar", function()
    it("toggles the sidebar visibility", function()
      local initial_wins = #vim.api.nvim_list_wins()

      magenta.toggle_sidebar()
      local wins_after_show = #vim.api.nvim_list_wins()
      assert.equals(initial_wins + 1, wins_after_show)

      magenta.toggle_sidebar()
      local wins_after_hide = #vim.api.nvim_list_wins()
      assert.equals(initial_wins, wins_after_hide)
    end)
  end)
end)

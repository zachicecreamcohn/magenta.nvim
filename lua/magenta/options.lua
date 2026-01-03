local M = {}

local defaults = {
  profiles = {
    {
      name = "claude-opus-4-5",
      provider = "anthropic",
      model = "claude-opus-4-5",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    },
    {
      name = "claude-sonnet-4-5",
      provider = "anthropic",
      model = "claude-sonnet-4-5",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    },
    {
      name = "claude-max",
      provider = "anthropic",
      model = "claude-opus-4-5",
      authType = "max"
    },
    {
      name = "gpt-4o",
      provider = "openai",
      model = "gpt-4o",
      apiKeyEnvVar = "OPENAI_API_KEY"
    },
    {
      name = "copilot-claude-opus",
      provider = "copilot",
      model = "claude-opus-4-5"
    }
  },
  picker = "fzf-lua",
  sidebarPosition = "left",
  sidebarPositionOpts = {
    above = {
      displayHeightPercentage = 0.3,
      inputHeightPercentage = 0.1,
    },
    below = {
      displayHeightPercentage = 0.3,
      inputHeightPercentage = 0.1,
    },
    tab = {
      displayHeightPercentage = 0.8,
    },
    left = {
      widthPercentage = 0.4,
      displayHeightPercentage = 0.8,
    },
    right = {
      widthPercentage = 0.4,
      displayHeightPercentage = 0.8,
    }
  },
  defaultKeymaps = true,
  sidebarKeymaps = {
    normal = {
      ["<CR>"] = ":Magenta send<CR>",
    }
  },
  displayKeymaps = {
    normal = {
      ["-"] = ":Magenta threads-navigate-up<CR>",
    }
  },
  editPrediction = {
    -- profile = {
    --   provider = "anthropic",
    --   model = "claude-3-5-haiku-latest",
    --   apiKeyEnvVar = "ANTHROPIC_API_KEY"
    -- },
    -- changeTrackerMaxChanges = 20,
    -- recentChangeTokenBudget = 1500,
    -- systemPrompt = "Your custom prediction system prompt here...",
    -- systemPromptAppend = "Focus on completing function calls and variable declarations."
  },
  inlineKeymaps = {
    normal = {
      ["<CR>"] = function(target_bufnr)
        vim.cmd("Magenta submit-inline-edit " .. target_bufnr)
      end,
    },
  },
  -- note: some OSs are case sensitive, and some are not.
  -- to make this work cross-platform, we will run all globs
  -- in case-insensitive mode.
  -- So you only need to add lowercase versions of each file.
  -- So for example, you do not need both context.md and CONTEXT.MD
  autoContext = {
    "context.md",
    "claude.md",
    ".magenta/*.md"
  },
  skillsPaths = {
    "~/.magenta/skills",
    "~/.claude/skills",
    ".magenta/skills",
    ".claude/skills"
  },
  commandConfig = {
    ls = { allowAll = true },
    pwd = { args = { {} } },
    echo = { allowAll = true },
    cat = { args = { { { file = true } } } },
    head = {
      args = {
        { { optional = { "-n", { any = true } } }, { file = true } },
        { { pattern = "-[0-9]+" },                 { file = true } },
      }
    },
    tail = {
      args = {
        { { optional = { "-n", { any = true } } }, { file = true } },
        { { pattern = "-[0-9]+" },                 { file = true } },
      }
    },
    wc = { args = { { { optional = { "-l" } }, { file = true } } } },
    git = {
      subCommands = {
        status = { allowAll = true },
        log = { allowAll = true },
        diff = { allowAll = true },
        show = { allowAll = true },
        add = { allowAll = true },
        commit = { allowAll = true },
        push = { allowAll = true },
        reset = { allowAll = true },
        restore = { allowAll = true },
        branch = { allowAll = true },
        checkout = { allowAll = true },
        switch = { allowAll = true },
        fetch = { allowAll = true },
        pull = { allowAll = true },
        merge = { allowAll = true },
        rebase = { allowAll = true },
        tag = { allowAll = true },
        stash = { allowAll = true },
      }
    },
    -- ripgrep: [optional -l] pattern [optional --type ext] [files...]
    rg = {
      args = {
        { { optional = { "-l" } }, { any = true }, { optional = { "--type", { any = true } } }, { restFiles = true } },
      }
    },
    -- fd: [optional -t f|d] [optional -e ext] [optional pattern] [optional dir]
    fd = {
      args = {
        { { optional = { "-t", { any = true } } }, { optional = { "-e", { any = true } } }, { optional = { { any = true } } }, { optional = { { file = true } } } },
      }
    },
  },
  maxConcurrentSubagents = 3,
  chimeVolume = 0.3,
  getFileAutoAllowGlobs = {
    "node_modules/**/*"
  },
  customCommands = {
    -- Example custom commands (commented out by default)
    -- {
    --   name = "@nedit",
    --   text = "DO NOT MAKE ANY EDITS TO CODE. Do not use any tools that allow you to edit code. Do not execute bash commands which edit code. NO EDITING WHATSOEVER OR ELSE.",
    --   description = "Disable all code editing functionality"
    -- },
    -- {
    --   name = "@careful",
    --   text = "Be extra careful and double-check your work before making any changes.",
    --   description = "Request extra caution"
    -- }
  }
}

M.options = defaults

M.set_options = function(opts)
  M.options = vim.tbl_deep_extend("force", defaults, opts or {})
  if opts.picker == nil then
    local pickers = { "fzf-lua", "telescope", "snacks" }
    for _, picker in ipairs(pickers) do
      local success, _ = pcall(require, picker)
      if success then
        M.options.picker = picker
        break
      end
    end
  end
end

return M

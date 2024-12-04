---@class AnthropicClient
---@field static table
---@field opts table
---@field config table
local Client = {}
Client.static = {}

Client.static.opts = {
  post = require("plenary.curl").post,
  encode = vim.json.encode,
  schedule = vim.schedule_wrap
}

-- Default configuration
local default_config = {
  api_key = nil, -- Will be fetched from environment if not set
  tools = nil,   -- No tools by default
  api_version = "2023-06-01",
  model = "claude-3-sonnet-20240229",
  system_prompt = "You are an AI assistant helping with code-related tasks in Neovim.",
  api_url = "https://api.anthropic.com/v1/messages"
}

---@param config? table
---@return table
function Client.new(config)
  local opts = vim.tbl_deep_extend("force", default_config, config or {})

  return setmetatable(
    {
      opts = vim.tbl_deep_extend("force", Client.static.opts, {}),
      config = opts
    },
    { __index = Client }
  )
end

---Get the API key from config or environment
---@return string|nil, string? error
function Client:get_api_key()
  local log = require("magenta.log").log
  log.debug("Getting API key")
  if self.config.api_key then
    log.debug("Using API key from config")
    return self.config.api_key
  end
  local env_key = os.getenv("ANTHROPIC_API_KEY")
  if not env_key then
    log.error("Anthropic API key not found in config or environment")
    return nil, "Anthropic API key not found. Please set it in the config or ANTHROPIC_API_KEY environment variable"
  end
  log.debug("Using API key from environment")
  return env_key
end

---@class AnthropicRequestActions
---@field callback fun(err: nil|string, chunk: nil|table) Callback function for request completion
---@field done? fun() Function to run when request is complete
---@field on_stream? fun(chunk: string) Function to handle streaming chunks

---@param payload table The payload to be sent to the endpoint
---@param actions AnthropicRequestActions
---@param opts? table Options that can be passed to the request
---@return table|nil The Plenary job
function Client:request(payload, actions, opts)
  opts = opts or {}
  local cb = actions.callback

  local api_key, api_key_error = self:get_api_key()
  if not api_key then
    vim.schedule(
      function()
        cb(api_key_error, nil)
      end
    )
    return
  end

  -- Prepare headers
  local headers = {
    ["Content-Type"] = "application/json",
    ["x-api-key"] = api_key,
    ["anthropic-version"] = self.config.api_version
  }

  -- Prepare the request body
  local body = {
    model = self.config.model,
    messages = {
      {
        role = "user",
        content = payload.message
      }
    },
    system = payload.system or self.config.system_prompt,
    max_tokens = 4096,
    stream = payload.stream or false
  }

  if self.config.tools then
    body.tools = self.config.tools
  end

  local request_opts = {
    url = self.config.api_url,
    headers = headers,
    body = self.opts.encode(body),
    raw = { "--no-buffer" },
    callback = function(response)
      vim.schedule(
        function()
          if response.status >= 400 then
            local err = "Anthropic API error: " .. (response.body or "Unknown error")
            cb(err, nil)
          else
            if not payload.stream then
              local ok, decoded = pcall(vim.json.decode, response.body)
              if ok then
                cb(nil, decoded)
              else
                cb("Failed to decode response: " .. decoded, nil)
              end
            end
          end

          if actions.done then
            actions.done()
          end
        end
      )
    end,
    on_error = function(err)
      vim.schedule(
        function()
          cb(err, nil)
        end
      )
    end
  }

  if payload.stream then
    -- Add streaming specific headers
    request_opts.headers["Accept"] = "text/event-stream"
    request_opts.headers["Connection"] = "keep-alive"

    -- Setup streaming handler
    request_opts.stream =
        self.opts.schedule(
          function(_, chunk)
            -- Skip the event messages
            if type(chunk) == "string" and string.sub(chunk, 1, 6) == "event:" then
              return cb(nil, "")
            end

            if chunk and chunk ~= "" then
              chunk = chunk:sub(6)
              local ok, json = pcall(vim.json.decode, chunk, { luanil = { object = true } })

              if ok then
                if json.type == "message_start" then
                  -- output.role = json.message.role
                  -- output.content = ""
                  return cb(nil, "")
                elseif json.type == "content_block_delta" then
                  -- output.role = nil
                  -- output.content = json.delta.text
                  return cb(nil, json.delta.text)
                end
              end
            end
          end

        )
  end

  local job = self.opts.post(request_opts)

  local log = require("magenta.log").log
  if job and job.args then
    log.debug("Request command: %s", vim.inspect(job.args))
  end

  return job
end

return Client

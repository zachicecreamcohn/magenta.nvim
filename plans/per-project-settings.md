# Context

The goal is to implement per-project settings support in the Magenta Neovim plugin. This will allow users to create `.magenta/options.json` files in their project directories to override the default plugin settings on a per-project basis.

The current options system works as follows:

1. **Default options** are defined in `lua/magenta/options.lua`
2. **User configuration** can override defaults via the `setup()` function
3. **Test options** can override everything via `_G.magenta_test_options`
4. Options flow from Lua to TypeScript via the `bridge()` function in `lua/magenta/init.lua`
5. TypeScript parses and validates options in `node/options.ts`

The relevant files and entities are:

- **`lua/magenta/options.lua`**: Contains the defaults and `set_options()` function
  - `defaults`: The base option structure
  - `set_options()`: Merges user options with defaults
- **`lua/magenta/init.lua`**: Entry point and bridge setup
  - `bridge()`: Returns final options to TypeScript side
  - `M.setup()`: Calls `Options.set_options()` with user config
- **`node/options.ts`**: TypeScript types and validation
  - `MagentaOptions`: Main options interface
  - `parseOptions()`: Validates and transforms options from Lua
- **`node/magenta.ts`**: Main TypeScript entry point
  - `Magenta.start()`: Initializes the plugin with parsed options
  - Constructor receives validated `MagentaOptions`

Key types to understand:

- **`MagentaOptions`**: TypeScript interface defining the structure
- **`Profile`**: AI provider configuration (name, provider, model, etc.)
- **`CommandAllowlist`**: Array of allowed shell command patterns

# Implementation

## Phase 1: Add Project Settings Infrastructure

- [ ] Create project settings detection and loading utilities on TypeScript side

  - [ ] Add `findProjectSettings()` function in `node/options.ts` to locate `.magenta/options.json` files by walking up from cwd
  - [ ] Add `loadProjectSettings()` function to safely read and parse JSON files
  - [ ] Add error handling for missing files, invalid JSON, and permission issues
  - [ ] Parse the file and validate it fits the `Partial<MagentaOptions>` type
  - [ ] Iterate until no compilation/type errors

- [ ] Integrate project settings into TypeScript options flow
  - [ ] Modify `parseOptions()` to accept project settings as a parameter
  - [ ] Implement merge logic: defaults < user config < project settings < test overrides
  - [ ] Update `MagentaOptions` parsing to handle the new precedence layer
  - [ ] Iterate until no compilation/type errors

## Phase 2: Integrate Project Settings into Plugin Startup

- [ ] Modify the plugin initialization flow in TypeScript

  - [ ] Update `Magenta.start()` in `node/magenta.ts` to detect and load project settings before parsing options
  - [ ] Add current working directory detection for project root discovery
  - [ ] Call project settings loading before `parseOptions()`
  - [ ] Ensure project settings are merged with Lua-provided options
  - [ ] Iterate until no compilation/type errors

- [ ] Add project settings context to the Magenta class
  - [ ] Store project settings path information for runtime access
  - [ ] Add helper methods to query project settings status
  - [ ] Add logging for project settings application
  - [ ] Iterate until no compilation/type errors

## Phase 3: Error Handling and Validation

- [ ] Implement comprehensive error handling

  - [ ] Add graceful degradation when project settings are malformed
  - [ ] Provide user-friendly error messages for common issues
  - [ ] Add file permission and access error handling
  - [ ] Log warnings for unknown configuration keys
  - [ ] Iterate until no compilation/type errors

- [ ] Add project settings validation
  - [ ] Validate project settings schema matches expected options
  - [ ] Ensure type safety for nested configuration objects
  - [ ] Add validation for profile configurations in project settings
  - [ ] Iterate until no compilation/type errors

## Phase 4: Testing Infrastructure

- [ ] Create test utilities for project settings

  - [ ] Add `withProjectSettings()` helper in `node/test/preamble.ts`
  - [ ] Create test fixtures with various `.magenta/options.json` configurations
  - [ ] Add utilities to create temporary project directories with settings
  - [ ] Iterate until tests compile without errors

- [ ] Write comprehensive unit tests
  - [ ] Test project settings detection and loading
  - [ ] Test precedence order (defaults < user < project < test)
  - [ ] Test error handling for malformed JSON and missing files
  - [ ] Test different project directory structures
  - [ ] Write tests and iterate until all tests pass

## Phase 5: Integration and End-to-End Testing

- [ ] Write integration tests for the complete flow

  - [ ] Test plugin startup with project settings in different directories
  - [ ] Test settings inheritance and override behavior
  - [ ] Test profile switching with project-specific profiles
  - [ ] Test interaction with test overrides in integration tests
  - [ ] Write tests and iterate until all tests pass

- [ ] Add performance and edge case testing
  - [ ] Test behavior with deeply nested project directories
  - [ ] Test performance with large numbers of project settings files
  - [ ] Test concurrent access and file locking scenarios
  - [ ] Test symlink and junction point handling
  - [ ] Write tests and iterate until all tests pass

## Phase 6: Documentation and Polish

- [ ] Update documentation

  - [ ] Add project settings format specification
  - [ ] Document precedence order and override behavior
  - [ ] Add examples of common project setting configurations
  - [ ] Document error handling and troubleshooting

- [ ] Add user-facing features
  - [ ] Consider adding command to show current effective settings
  - [ ] Consider adding command to validate project settings
  - [ ] Add logging/debugging output for settings loading process

## Detailed Implementation Specifications

### Project Settings File Format

The `.magenta/options.json` file should support the same structure as the Lua options, but in JSON format:

```json
{
  "profiles": [
    {
      "name": "project-claude",
      "provider": "anthropic",
      "model": "claude-3-7-sonnet-latest",
      "apiKeyEnvVar": "PROJECT_ANTHROPIC_KEY"
    }
  ],
  "sidebarPosition": "right",
  "commandAllowlist": [
    "^make( [^;&|()<>]*)?$",
    "^cargo (build|test|run)( [^;&|()<>]*)?$"
  ],
  "autoContext": ["project-readme.md", "docs/*.md"]
}
```

### Precedence Logic

The final precedence order will be:

1. **Defaults** (lowest priority)
2. **User configuration** (via `setup()`)
3. **Project settings** (from `.magenta/options.json`)
4. **Test overrides** (highest priority, test-only)

### Project Settings Discovery

- Start from current working directory (using Node.js `process.cwd()`)
- Look for `.magenta/options.json` in current directory
- Walk up directory tree until file is found or filesystem root is reached
- Cache the discovered path to avoid repeated filesystem operations
- Use Node.js `fs` module for file system operations

### Error Handling Strategy

- **Missing file**: Continue with existing settings, log debug message
- **Invalid JSON**: Log warning, continue with existing settings
- **Permission errors**: Log warning, continue with existing settings
- **Schema validation errors**: Log warning with specific field issues, continue with existing settings
- **Unknown keys**: Log info message, ignore unknown keys

### Performance Considerations

- Project settings detection occurs once during plugin startup
- Cache the project settings file path to avoid repeated directory traversal
- Use lazy loading - only read project settings when plugin starts
- No file watching - settings changes require plugin restart

### Testing Strategy

- Unit tests for each utility function
- Integration tests for complete startup flow
- Fixture-based testing with various project directory structures
- Error condition testing with malformed files
- Performance testing with deep directory nesting
- Cross-platform testing for path handling

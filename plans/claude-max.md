## Plan: Add Claude Max Authentication Support

### Phase 1: Core Authentication Infrastructure

#### 1.1 Add OAuth Dependencies ✅

- **File**: `package.json`
- **Action**: Add required dependencies from the spec

```json
{
  "dependencies": {
    "@openauthjs/openauth": "^0.4.3"
  }
}
```

#### 1.2 Storage Features (integrated into auth module) ✅

- **Location**: `~/.local/share/magenta/auth.json` (following XDG spec)
- **Features** (built into `node/auth/anthropic.ts`):
  - Store/retrieve OAuth tokens with simple JSON validation
  - File permissions set to 0600 for security
  - Handle concurrent access safely

#### 1.3 Implement Anthropic Auth Module ✅

- **File**: `node/auth/anthropic.ts`
- **Purpose**: Handle the complete OAuth2 PKCE flow and token storage for Anthropic
- **Features**:
  - `authorize()` - Generate PKCE challenge and authorization URL
  - `exchange(code, verifier)` - Exchange authorization code for tokens
  - `refresh()` - Refresh expired access tokens
  - `getAccessToken()` - Get valid access token (with auto-refresh)
  - `isAuthenticated()` - Check if valid tokens exist
  - `storeTokens()` - Securely store tokens with proper file permissions
  - `loadTokens()` - Load tokens from storage
  - `clearTokens()` - Clear invalid/expired tokens

### Phase 2: Provider Integration

#### 2.1 Extend Profile Configuration ✅

- **File**: `lua/magenta/options.lua`
- **Action**: Add support for "max" auth type in profiles

```lua
-- New profile type example:
{
  name = "claude-max",
  provider = "anthropic",
  model = "claude-3-7-sonnet-latest",
  authType = "max", -- New field: "key" | "max"
  -- apiKeyEnvVar not needed for max
}
```

#### 2.2 Modify Anthropic Provider ✅

- **File**: `node/providers/anthropic.ts`
- **Action**: Support both API key and OAuth authentication
- **Changes**:
  - Detect auth type from profile configuration
  - Import and use `node/auth/anthropic.ts` for max auth operations
  - For "max" auth: check for valid tokens at request time (in sendMessage/forceToolUse)
  - Use custom fetch function with Bearer token from auth module
  - Add required anthropic-beta headers for OAuth
  - Remove x-api-key header, add Authorization: Bearer header

### Phase 3: Automatic Authentication Flow

#### 3.1 Integrate Auth Check in Request Methods ✅

- **File**: `node/providers/anthropic.ts`
- **Action**: Check for valid tokens before making API requests
- **Features**:
  - In `sendMessage()` and `forceToolUse()` methods, check for valid access token
  - If no valid token exists for "max" auth profiles, automatically trigger OAuth flow
  - Block request until authentication completes successfully

#### 3.2 Implement OAuth Flow Handler ✅

- **File**: `node/auth/anthropic.ts`
- **Features**:
  - Generate OAuth URL and open in browser automatically
  - Show instructions in a new floating window in magenta for how to grab the auth code, also create a floating, modifiable,
    single-line input buffer where the user can submit the token to the plugin
  - Handle code exchange and token storage
  - Return success/error status to provider requests

### Phase 4: Token Management & Error Handling

#### 4.1 Implement "Ensure Valid Token" Logic ✅

- **File**: `node/auth/anthropic.ts`
- **Purpose**: Single function to ensure we have a valid access token before requests
- **Features**:
  - Check if tokens exist, trigger OAuth flow if not
  - Check if existing tokens are expired (based on stored expiry time)
  - Automatically refresh expired tokens using refresh token
  - Handle refresh token expiration gracefully (trigger new OAuth flow)
  - Clear invalid tokens from storage
- **Usage**: Called before every API request for max auth profiles

### Phase 5: Configuration & Documentation

#### 5.1 Update Configuration Schema ✅

- **File**: `lua/magenta/options.lua`
- **Action**: Add validation for max auth profiles
- **Ensure**: Profiles with `authType = "max"` don't require `apiKeyEnvVar`

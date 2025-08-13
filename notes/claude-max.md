# Claude Code API Reverse Engineering Specification - Max Mode

This document provides a complete specification for implementing Claude Pro/Max authentication to use Claude credentials via OAuth Bearer tokens (the "max" mode from opencode).

## Dependencies

To implement this Claude integration, you'll need the following npm packages:

### Required Dependencies

```json
{
  "dependencies": {
    "@openauthjs/openauth": "^0.4.3",
    "zod": "^3.22.0",
    "ai": "^3.0.0",
    "decimal.js": "^10.5.0",
    "remeda": "^2.0.0"
  }
}
```

### Optional Dependencies (for CLI)

```json
{
  "devDependencies": {
    "@clack/prompts": "^1.0.0-alpha.1",
    "open": "^10.1.2",
    "yargs": "^18.0.0"
  }
}
```

### Key Library Functions Used

- **@openauthjs/openauth/pkce**: `generatePKCE()` - Generates PKCE challenge/verifier pairs
- **zod**: Schema validation and TypeScript types
- **ai**: AI SDK for language model providers and message handling (`streamText`, `generateText`, `wrapLanguageModel`, etc.)
- **decimal.js**: `Decimal` class for precise cost calculations
- **remeda**: Utility functions (`mergeDeep`, `sortBy`, `pipe`, `splitWhen`, `unique`)
- **@clack/prompts**: Interactive CLI prompts (`intro`, `select`, `text`, `password`, `spinner`)
- **open**: Opens browser for OAuth flow
- **Node.js built-ins**: `path`, `os`, `fs/promises`

### Dynamic Provider Loading

OpenCode uses dynamic package installation to load AI providers at runtime:

```typescript
// Dynamically installs and imports provider packages
const pkg = provider.npm ?? provider.id; // e.g., "@ai-sdk/anthropic"
const mod = await import(await BunProc.install(pkg, "latest"));
const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!];
const sdk = fn({
  name: provider.id,
  ...options,
});
```

**Common Provider Packages:**

- `@ai-sdk/anthropic` for Anthropic/Claude models
- `@ai-sdk/openai` for OpenAI models
- `@ai-sdk/google` for Google models
- `@ai-sdk/amazon-bedrock` for AWS Bedrock

## Overview

This implementation allows Claude Pro/Max subscribers to authenticate via OAuth2 PKCE flow and use their access tokens directly with Bearer authentication, providing free access to Claude models through their existing subscription.

## Authentication Flow

### 1. OAuth2 PKCE Authorization

The authentication process uses OAuth2 with PKCE (Proof Key for Code Exchange) to securely authenticate with Claude.

#### Authorization Endpoint Configuration

```typescript
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export async function authorize() {
  const pkce = await generatePKCE();

  const url = new URL("https://claude.ai/oauth/authorize");
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    "https://console.anthropic.com/oauth/code/callback",
  );
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference",
  );
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
  };
}
```

**Key Details:**

- **Client ID**: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- **Endpoint**: `https://claude.ai/oauth/authorize`
- **Redirect URI**: `https://console.anthropic.com/oauth/code/callback`
- **Scopes**: `org:create_api_key user:profile user:inference`
- **PKCE**: Uses S256 method for security

### 2. Token Exchange

After user authorizes, exchange the code for tokens:

```typescript
export async function exchange(code: string, verifier: string) {
  const splits = code.split("#");
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  });
  if (!result.ok) throw new ExchangeFailed();
  const json = await result.json();
  return {
    refresh: json.refresh_token as string,
    access: json.access_token as string,
    expires: Date.now() + json.expires_in * 1000,
  };
}
```

**Key Details:**

- **Token Endpoint**: `https://console.anthropic.com/v1/oauth/token`
- **Method**: POST with JSON body
- The authorization code may contain a hash fragment that needs to be split

### 3. Token Refresh

Refresh expired access tokens:

```typescript
export async function access() {
  const info = await Auth.get("anthropic");
  if (!info || info.type !== "oauth") return;
  if (info.access && info.expires > Date.now()) return info.access;
  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: info.refresh,
      client_id: CLIENT_ID,
    }),
  });
  if (!response.ok) return;
  const json = await response.json();
  await Auth.set("anthropic", {
    type: "oauth",
    refresh: json.refresh_token as string,
    access: json.access_token as string,
    expires: Date.now() + json.expires_in * 1000,
  });
  return json.access_token as string;
}
```

## Storage Schema

### Auth Storage Structure

```typescript
export const Oauth = z.object({
  type: z.literal("oauth"),
  refresh: z.string(),
  access: z.string(),
  expires: z.number(),
});

export type Info = z.infer<typeof Oauth>;
```

### File System Operations

```typescript
import fs from "fs/promises";

// Storage functions
export async function get(providerID: string) {
  const file = Bun.file(filepath); // or use fs.readFile with JSON.parse
  return file
    .json()
    .catch(() => ({}))
    .then((x) => x[providerID] as Info | undefined);
}

export async function set(key: string, info: Info) {
  const file = Bun.file(filepath);
  const data = await all();
  await Bun.write(file, JSON.stringify({ ...data, [key]: info }, null, 2));
  await fs.chmod(file.name!, 0o600); // Critical: Secure file permissions
}
```

**Storage Location**: `{dataPath}/auth.json` where `dataPath` is typically:

- Linux/macOS: `~/.local/share/opencode/` or `$XDG_DATA_HOME/opencode/`
- Windows: `%APPDATA%/opencode/`

## API Usage

### Custom Provider Implementation

The Anthropic provider in opencode uses a custom fetch function to inject the proper authentication and headers:

```typescript
async anthropic(provider) {
  const access = await AuthAnthropic.access()
  if (!access)
    return {
      autoload: false,
      options: {
        headers: {
          "anthropic-beta":
            "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
        },
      },
    }
  for (const model of Object.values(provider.models)) {
    model.cost = {
      input: 0,
      output: 0,
    }
  }
  return {
    autoload: true,
    options: {
      apiKey: "",
      async fetch(input: any, init: any) {
        const access = await AuthAnthropic.access()
        const headers = {
          ...init.headers,
          authorization: `Bearer ${access}`,
          "anthropic-beta":
            "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
        }
        delete headers["x-api-key"]
        return fetch(input, {
          ...init,
          headers,
        })
      },
    },
  }
}
```

### Key API Details

**Beta Features Header:**

- `"oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"`

**Authentication:**

- Use `Bearer ${access_token}` in Authorization header
- Remove the `x-api-key` header if present
- Set costs to 0 for all models (since user has access through subscription)

**System Prompt Spoofing:**

```typescript
export function header(providerID: string) {
  if (providerID.includes("anthropic")) return [PROMPT_ANTHROPIC_SPOOF.trim()];
  return [];
}
```

Where `PROMPT_ANTHROPIC_SPOOF.txt` contains:

```
You are Claude Code, Anthropic's official CLI for Claude.
```

## Message Transformations

### Caching Implementation

```typescript
function applyCaching(
  msgs: ModelMessage[],
  providerID: string,
): ModelMessage[] {
  const system = msgs.filter((msg) => msg.role === "system").slice(0, 2);
  const final = msgs.filter((msg) => msg.role !== "system").slice(-2);

  const providerOptions = {
    anthropic: {
      cacheControl: { type: "ephemeral" },
    },
    // ... other providers
  };

  for (const msg of unique([...system, ...final])) {
    const shouldUseContentOptions =
      providerID !== "anthropic" &&
      Array.isArray(msg.content) &&
      msg.content.length > 0;

    if (shouldUseContentOptions) {
      const lastContent = msg.content[msg.content.length - 1];
      if (lastContent && typeof lastContent === "object") {
        lastContent.providerOptions = {
          ...lastContent.providerOptions,
          ...providerOptions,
        };
        continue;
      }
    }

    msg.providerOptions = {
      ...msg.providerOptions,
      ...providerOptions,
    };
  }

  return msgs;
}
```

### Tool Call ID Normalization

```typescript
function normalizeToolCallIds(msgs: ModelMessage[]): ModelMessage[] {
  return msgs.map((msg) => {
    if (
      (msg.role === "assistant" || msg.role === "tool") &&
      Array.isArray(msg.content)
    ) {
      msg.content = msg.content.map((part) => {
        if (
          (part.type === "tool-call" || part.type === "tool-result") &&
          "toolCallId" in part
        ) {
          return {
            ...part,
            toolCallId: part.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_"),
          };
        }
        return part;
      });
    }
    return msg;
  });
}
```

### Model-Specific Parameters

```typescript
export function temperature(_providerID: string, modelID: string) {
  if (modelID.toLowerCase().includes("qwen")) return 0.55;
  if (modelID.toLowerCase().includes("claude")) return 1;
  return 0;
}

export function topP(_providerID: string, modelID: string) {
  if (modelID.toLowerCase().includes("qwen")) return 1;
  return undefined;
}
```

## CLI Integration

### Login Flow

```typescript
// OAuth flow for Max users
const { url, verifier } = await AuthAnthropic.authorize();
console.log("Open this URL in your browser:");
console.log(url);

const code = await prompts.text({
  message: "Paste the authorization code here: ",
  validate: (x) => (x && x.length > 0 ? undefined : "Required"),
});

try {
  const credentials = await AuthAnthropic.exchange(code, verifier);
  await Auth.set("anthropic", {
    type: "oauth",
    refresh: credentials.refresh,
    access: credentials.access,
    expires: credentials.expires,
  });
  console.log("Login successful");
} catch {
  console.log("Invalid code");
}
```

## File Locations and Permissions

- **Auth file**: `{Global.Path.data}/auth.json` with mode 0600

## Error Handling

```typescript
export class ExchangeFailed extends Error {
  constructor() {
    super("Exchange failed");
  }
}
```

Handle various error cases:

- Invalid authorization code
- Network failures during token exchange
- Token refresh failures

## Security Considerations

1. **PKCE Flow**: Uses PKCE S256 method for secure OAuth flow
2. **File Permissions**: Auth files stored with 0600 permissions
3. **Token Management**: Automatic refresh of expired access tokens
4. **Header Management**: Proper header injection without exposing internal keys

This specification provides all the necessary details to reconstruct the Claude authentication flow in another codebase, including the exact endpoints, headers, parameters, and error handling patterns used by opencode.

---
name: learn
description: Guide for learning and researching parts of a codebase before implementing changes. Use when you need to understand code, APIs, or concepts.
---

# Learning Process

When you need to learn about part of a codebase:

1. Identify all of the functions, objects and types that you may need to know about in order to complete the task
2. List all of the entities by name
3. Explicitly state: "X, Y and Z seem relevant. I will try and learn about them."
4. Use the hover tool on each entity to see its signature and declaration location
5. If the signature is ambiguous or insufficient, look at the declaration
6. Repeat until you have learned about all of the relevant interfaces

<example>
user: learn about how to implement feature X in the code
assistant: myFunction1 and myFunction2 seem relevant. I will try to learn about them.
[uses hover tool on myFunction1 - shows it's a function in myFile that accepts an opaque MyType argument]
[uses hover tool on myFunction2]
[since myFile is not part of the context, uses get_file to look at myFile to see full function implementation and where MyType is imported from]
MyType seems relevant. I will try to learn about it.
[uses hover on MyType]
[... and so on, until all relevant interfaces have been gathered ...]
</example>

# Write the notes

As you conduct your research, continuously write your findings to `notes/<name>.md`. Record the following:

## Key Entities

For each important function, class, interface, or type you discovered:
- **Name and Location**: Full name and file path
- **Signature/Interface**: Complete type information
- **Purpose**: What it does and why it exists
- **Usage Patterns**: How it's typically used based on references found
- **Dependencies**: What other entities it relies on
- **Important Notes**: Any constraints, gotchas, or architectural considerations

## Relationships and Patterns

- How the different entities work together
- Common architectural patterns used
- Data flow between components
- Important conventions to follow

When you complete your learning task, yield to the parent with just the location of your notes file.

<example>
user: Learn about how authentication works in this codebase so I can add a new auth provider

A:

# Key Entities
**AuthProvider interface** (src/auth/types.ts:15)
- Signature: interface AuthProvider { authenticate(credentials: Credentials): Promise<AuthResult>; ... }
- Purpose: Defines the contract all auth providers must implement
- Usage: Implemented by GoogleAuth, GitHubAuth classes
- Dependencies: Credentials type, AuthResult type
- Important Notes: Must handle async errors gracefully, expected to cache tokens

**AuthManager class** (src/auth/manager.ts:8)
- Purpose: Coordinates between different auth providers
- Usage: Singleton accessed via getAuthManager()
- Key methods: registerProvider(), authenticate()
- Important Notes: Providers must be registered at startup

# Relationships and Patterns
- All providers implement AuthProvider interface
- AuthManager maintains a registry of providers by name
- Authentication flow: Manager -> Provider -> External Service -> Result
- Error handling follows Result<T> pattern throughout
</example>

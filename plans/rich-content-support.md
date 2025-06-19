# Rich Content Support Implementation Plan

## Context

The goal is to extend the magenta.nvim provider system to support images and documents (PDFs, text files, etc.) in addition to the current text-only tool results. This will enable the AI assistant to analyze visual content, read PDFs, and process various file formats beyond plain text.

The current architecture processes files through the `get_file` tool which reads file contents as UTF-8 text and returns them as strings. The provider system uses `ProviderMessageContent` types that currently only support text content and tool results.

## Key Components and Files

### Core Files to Modify:

- **`node/providers/provider-types.ts`**: Defines `ProviderMessageContent` and related types
- **`node/providers/anthropic.ts`**: Maps provider types to Anthropic SDK types, handles content block creation
- **`node/tools/getFile.ts`**: The main file reading tool that needs to detect and handle different file types
- **`node/context/context-manager.ts`**: Manages file context and content updates
- **`node/utils/files.ts`**: File path utilities that may need file type detection
- **`node/tools/tool-specs.ts`**: Tool specifications for the get_file tool

### Key Types and Interfaces:

- **`ProviderMessageContent`**: Union type defining all possible message content types
- **`ProviderTextContent`**: Current text-only content type
- **`MessageParam`**: Anthropic message parameter type mapping
- **`ToolApplication`**: Context manager's view of tool applications
- **`GetFileTool`**: The main file reading controller

### Relevant Libraries:

- **`@anthropic-ai/sdk`**: Already supports images and documents via `ContentBlockParam`
- **`fs`**: Node.js file system for reading files
- **`path`**: Node.js path utilities for file type detection

## Implementation

### Phase 1: Type System Extensions ✅

- [x] Extend `ProviderMessageContent` in `node/providers/provider-types.ts` to include rich content types

  - [x] Add `ProviderImageContent` type for images (base64 and file paths)
  - [x] Add `ProviderDocumentContent` type for PDFs and other documents
  - [x] Make sure these match the corresponding Anthropic API types
  - [x] Update the union type to include new content types
  - [x] Check for type errors and iterate until they pass

**Implementation Notes:**

- Added `ProviderImageContent` with support for base64 images in JPEG, PNG, GIF, WebP formats
- Added `ProviderDocumentContent` with support for base64 PDF documents and optional titles
- Updated all provider files to handle new content types:
  - **Anthropic**: Full support implemented
  - **Bedrock**: Inherits from Anthropic (full support)
  - **Ollama**: Throws "not supported" errors as planned
  - **OpenAI**: Throws "not implemented" errors (to be completed later)
- Updated helper functions (`stringifyContent`, message rendering, mock provider) to handle new types
- All TypeScript compilation errors resolved

### Phase 2: File type detection

- [x] Add required dependencies for file type detection

  - [x] Add `file-type` package: `npm install file-type@^21.0.0`
  - [x] Add `mime-types` package: `npm install mime-types@^2.1.35`
  - [x] Add type definitions: `npm install --save-dev @types/mime-types@^2.1.4`
  - [x] Check for installation errors and iterate until dependencies are properly installed

- [x] Create file type detection utilities in `node/utils/files.ts`
  - [x] Add `FileCategory` enum with values: `text`, `image`, `pdf`, `unsupported`
  - [x] Add `FileTypeInfo` interface with category, mimeType, extension, and isSupported fields
  - [x] Implement hybrid `detectFileType(filePath: string): Promise<FileTypeInfo>` function using magic numbers + extension fallback
  - [x] Add `categorizeFileType(mimeType: string): FileCategory` helper function that determines:
    - `text`: Plain text files, source code, markdown, JSON, XML, CSV, etc. (anything that can be read as UTF-8 and diffed meaningfully)
    - `image`: JPEG, PNG, GIF, WebP formats supported by Anthropic
    - `pdf`: PDF documents supported by Anthropic
    - `unsupported`: Binary files, proprietary formats, or files too large
  - [x] Add `isSupportedMimeType(mimeType: string): boolean` validation function
  - [x] Add `isLikelyTextFile(filePath: string): Promise<boolean>` fallback detection using:
    - File extension patterns (js, ts, py, md, txt, json, xml, etc.)
    - Content sampling (read first 1KB and check for binary markers like null bytes)
    - UTF-8 encoding validation
  - [x] Add file size validation utilities with configurable limits:
    - Text files: 1MB limit (for diff performance)
    - Image files: 10MB limit (Anthropic API constraint)
    - PDF files: 32MB limit (Anthropic API constraint)
  - [x] Write comprehensive unit tests for all detection methods
  - [x] Iterate until type checks and unit tests pass

### Phase 3: Multi-Provider Rich Content Support

#### 3.1: Anthropic Provider Updates

- [x] Update Anthropic provider in `node/providers/anthropic.ts` to handle rich content

  - [x] Extend `createStreamParameters` method to map new content types to Anthropic's `ContentBlockParam`
  - [x] Add image content handling (base64 encoding for images)
  - [x] Add document content handling (base64 encoding for PDFs)
  - [x] Update content block creation logic in the `content.map()` section
  - [x] Check for type errors and iterate until they pass

#### 3.3: OpenAI Provider Updates ✅

- [x] Update OpenAI provider in `node/providers/openai.ts` to handle rich content

  - [x] Extend `createStreamParameters` method to map new content types to OpenAI's message format
  - [x] Add image content handling using OpenAI's vision capabilities:
    - Map `ProviderImageContent` to OpenAI's image content format
    - Use `data:image/{mime_type};base64,{base64_data}` format for base64 images
    - Support JPEG, PNG, GIF, WebP formats as per OpenAI documentation
  - [x] Add document content handling using OpenAI's file input capabilities:
    - Map `ProviderDocumentContent` to OpenAI's `input_file` format
    - Use `data:application/pdf;base64,{base64_data}` format for PDF documents
    - Include filename in the `input_file` object (extract from file path or use generic name)
  - [x] Update content processing in the `for (const content of m.content)` loop
  - [x] Add new case handlers for `image` and `document` content types
  - [x] Update message structure to use OpenAI's content array format instead of simple string content
  - [x] Check for type errors and iterate until they pass

**Implementation Notes:**

- Added PDF document support using OpenAI's base64 data URI format (`data:application/pdf;base64,{base64_data}`)
- Uses `input_file` type with `filename` and `file_data` properties
- Simplified implementation compared to file upload approach
- All providers now have clear support status:
  - **Anthropic/Bedrock**: Full native support ✅
  - **OpenAI**: Full support via base64 data URIs ✅
  - **Ollama**: Clear "not supported" errors ✅

### Phase 4: Enhanced get_file Tool

- [x] Enhance `GetFileTool` in `node/tools/getFile.ts` to handle different file types

  - [x] Add file type detection in `initReadFile()` method using the utilities from Phase 2
  - [x] Modify `readFile()` method to handle binary files:
    - Text files: Read as UTF-8 string using `fs.readFileSync(path, 'utf8')`
    - Binary files: Read as Buffer using `fs.readFileSync(path)`, then convert to base64 using `buffer.toString('base64')`
  - [x] Update tool result creation to return appropriate `ProviderMessageContent` types:
    - Text files: Return `ProviderTextContent` with string content
    - Images: Return `ProviderImageContent` with base64 data and MIME type
    - PDFs: Return `ProviderDocumentContent` with base64 data and MIME type
  - [x] Add user approval flow for large files or sensitive file types
  - [x] Enhance tool description to mention support for images and documents
  - [x] Check for type errors

- [x] Add content validation and size limits
  - [x] Implement maximum file size checks before reading (10MB for images, 32MB for documents)
  - [x] Add supported format validation using file type detection results
  - [x] Add error handling for unsupported formats with clear error messages

### Phase 5: Context Manager Updates

- [x] Update `ContextManager` in `node/context/context-manager.ts` to reject non-text files

  - [x] Add file type detection to `update()` method for `add-file-context` messages
  - [x] When a non-text file is added to context:
    - Log an error message indicating the file type is not supported in context
    - Do not add the file to the `files` object
    - Continue processing without throwing an exception
  - [x] Keep existing text file handling unchanged (diff-based approach using `agentsViewOfFiles`)
  - [x] Check for type errors and iterate until they pass

- [x] Update context loading to filter out non-text files

  - [x] Modify `loadAutoContext()` to check file types before adding to context
  - [x] Log informational messages about skipped non-text files during auto-context loading
  - [x] Ensure auto-context only includes text files
  - [x] Check for type errors and iterate until they pass

- [x] Keep `contextUpdatesToContent()` unchanged
  - [x] Since only text files will be in context, no changes needed to this function
  - [x] Continue returning single `ProviderMessageContent` with text content

### Phase 6: Integration Testing ✅

- [x] Write comprehensive integration tests

  - [x] Test image file processing end-to-end
  - [x] Test PDF document processing end-to-end
  - [x] Test rejection of unsupported binary files
  - [x] Test that images/PDFs are not added to context manager
  - [x] Test that text files continue to work normally in context
  - [x] Test mixed content types in a single conversation
  - [x] Test file size limits for large files
  - [x] All integration tests pass

**Implementation Notes:**

- Created comprehensive test suite in `node/tools/getFile-rich-content.spec.ts` with 8 integration tests
- Tests cover the full end-to-end workflow from tool request to provider message content
- Validates that rich content (images/PDFs) is correctly processed and returned as structured content
- Confirms that only text files are added to context, while rich content files are excluded
- Tests proper error handling for unsupported file types and size limits
- All tests pass both individually and as part of the integration test suite

### Phase 7: Documentation and Refinement ✅

- [x] Update tool documentation

  - [x] Document supported file formats and size limits in tool spec
  - [x] Update README with rich content capabilities and provider support status
  - [x] Add dedicated "Rich Content Support" section explaining features and usage

## Detailed Implementation Specifications

### Dependencies and Package Management

The implementation requires two key npm packages for robust file type detection: `file-type` and `mime-types`. The latest
versions of these should be added via npm.

### File Type Detection Strategy

The implementation uses a **hybrid approach** combining magic number detection (most reliable) with extension-based fallback:

1. **Magic Number Detection**: Uses the `file-type` package to analyze file binary signatures
2. **Extension Fallback**: Uses `mime-types` when magic number detection fails
3. **Text Analysis**: Custom logic to detect text files by content analysis

### Text vs Non-Text File Classification

**Approach: Content-Based Detection with MIME Type Classification**

Instead of enumerating all possible file extensions, use a layered detection approach:

**Text Files** (stored in `agentsViewOfFiles`, support diffing):

- **Primary Detection**: MIME type starts with `text/` (text/plain, text/html, text/css, etc.)
- **Code Files**: MIME types like `application/javascript`, `application/json`, `application/xml`
- **Fallback Detection**: Content analysis for files with unknown MIME types:
  - Read first 8KB of file
  - Check for binary markers (null bytes, control characters except whitespace)
  - Validate UTF-8 encoding
  - Calculate ratio of printable to non-printable characters (>95% printable = likely text)

**Non-Text Files** (no content storage, whole-file updates only):

- **Images**: MIME types `image/jpeg`, `image/png`, `image/gif`, `image/webp` (Anthropic supported)
- **PDFs**: MIME type `application/pdf` (Anthropic supported)
- **Other Binary**: All other MIME types or files that fail text detection (unsupported)

**Detection Logic**:

1. **Magic Number Detection**: Use `file-type` package for reliable binary format identification
2. **MIME Type Mapping**: Use `mime-types` package to get MIME type from extension as fallback
3. **Content Analysis**: For unknown/ambiguous cases, sample file content
4. **MIME Type Categorization**

### Anthropic types

`node_modules/@anthropic-ai/sdk/src/resources/messages/messages.ts`:

```
export interface ImageBlockParam {
  source: Base64ImageSource | URLImageSource;

  type: 'image';

  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control?: CacheControlEphemeral | null;
}

export interface DocumentBlockParam {
  source: Base64PDFSource | PlainTextSource | ContentBlockSource | URLPDFSource;

  type: 'document';

  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control?: CacheControlEphemeral | null;

  citations?: CitationsConfigParam;

  context?: string | null;

  title?: string | null;
}

export interface Base64PDFSource {
  data: string;

  media_type: 'application/pdf';

  type: 'base64';
}

export interface Base64ImageSource {
  data: string;
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  type: 'base64';
}

export interface URLImageSource {
  type: 'url';
  url: string;
}

export interface Base64PDFSource {
  data: string;
  media_type: 'application/pdf';
  type: 'base64';
}

export interface PlainTextSource {
  data: string;
  media_type: 'text/plain';
  type: 'text';
}

export interface URLPDFSource {
  type: 'url';
  url: string;
}

export interface ContentBlockSource {
  content: string | Array<ContentBlockSourceContent>;

  type: 'content';
}

export type ContentBlockSourceContent = TextBlockParam | ImageBlockParam;
```

## Testing Strategy

### Unit Tests

- File type detection accuracy
- Base64 encoding/decoding
- Size limit validation
- Error handling for various edge cases

### Integration Tests

- End-to-end image processing workflow
- End-to-end PDF processing workflow
- Provider integration with Anthropic API
- Context manager with mixed content types

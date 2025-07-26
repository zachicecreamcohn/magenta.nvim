# context

The goal is to implement a "next-edit-prediction" functionality that predicts the user's next edit based on recent changes and current context.

**Key Scoping Principle:**

- On ctrl-l, capture a context window of ~20 lines around the cursor
- Send this context window (along with recent edits) to the fast model
- The PredictEdit tool returns find/replace parameters scoped to this context window only
- Apply and preview edits only within this captured context range

The relevant files and entities are:

**Core Architecture:**

- `node/magenta.ts`: Main application controller containing the dispatch system
- `node/root-msg.ts`: Defines the root message types flowing through the system
- `node/change-tracker.ts`: Already exists to track recent user edits

**Key Components:**

- `ChangeTracker`: Provides `getRecentChanges()` to get recent edits up to 1000 tokens
- `NvimBuffer.setExtmark()`: For virtual text overlay functionality
- Fast model access via `profile.fastModel` for quick prediction requests
- Context window capture: ~20 lines around cursor (matching agent context size)

**Provider Integration:**

- `Provider.forceToolUse()`: Interface for forced tool use requests
- `ProviderToolSpec`: Tool specification interface for predict-edit tool
- Fast model selection from active profile for performance

**Message Flow Pattern:**
Controllers receive messages via `update` and use `myDispatch` to send messages through the system.

# Edit Prediction Feature Plan

The goal is to implement a "next-edit-prediction" functionality that predicts the user's next edit based on recent changes and current context.

## Checkpoint 1: Test-Driven Foundation ✅

**Goal:** Write a test that verifies ctrl-l triggers a forced tool use request to the "fast" provider with correct parameters.

**Test Requirements:**

- System message for prediction context
- Tool specification for predict-edit
- Provided context: 20 lines surrounding cursor + cursor position + previous edits

### Steps to Checkpoint 1:

- [x] Create basic PredictEdit tool definition
  - [x] Create `node/tools/predict-edit.ts` with minimal `StaticTool` implementation
  - [x] Define tool schema with find/replace parameters
  - [x] Register in `node/tools/tool-registry.ts`
  - [x] Run type check: `npx tsc --noEmit`

- [x] Create minimal EditPredictionController
  - [x] Create `node/edit-prediction/edit-prediction-controller.ts`
  - [x] Define `EditPredictionMsg` with just `trigger-prediction` type
  - [x] Define `EditPredictionId` branded type
  - [x] Implement constructor and basic `update()` method
  - [x] Add `captureContextWindow()` method (20 lines around cursor)
  - [x] Add method to get recent changes from ChangeTracker
  - [x] Run type check: `npx tsc --noEmit`

- [x] Wire controller into message system
  - [x] Add `EditPredictionRootMsg` to `node/root-msg.ts`
  - [x] Add message routing in `node/magenta.ts`
  - [x] Add ctrl-l keymap in `lua/magenta/keymaps.lua`
  - [x] Add predict-edit command handling in `node/magenta.ts`
  - [x] Run type check: `npx tsc --noEmit`

- [x] **Write the test for forced tool use**
  - [x] Create test file `node/edit-prediction/edit-prediction.test.ts`
  - [x] Use `withDriver` to set up test environment
  - [x] Create buffer with test content and position cursor
  - [x] Mock the fast provider to capture `forceToolUse()` calls
  - [x] Trigger ctrl-l and assert on:
    - System message content
    - Tool specification matches predict-edit
    - Context includes 20 lines around cursor with cursor marker
    - Recent changes included in context
  - [x] Run test: `npx vitest run node/edit-prediction/edit-prediction.test.ts`

- [x] Implement the logic to make test pass
  - [x] Add `triggerPrediction()` method to controller
  - [x] Implement provider.forceToolUse() call with correct parameters
  - [x] Ensure test passes: `npx vitest run node/edit-prediction/edit-prediction.test.ts`

## Checkpoint 2: Prediction Response Handling

**Goal:** Handle prediction response and store it in controller state with proper lifecycle management.

### Prediction Lifecycle States:

The EditPredictionController should manage these states:

1. **idle**: No active prediction, ready to accept new requests
2. **preparing-request**: Capturing context window, gathering recent changes, preparing forceToolUse call
3. **awaiting-agent-reply**: Request sent to provider, waiting for prediction response
4. **displaying-proposed-edit**: Prediction received, showing virtual text preview with accept/dismiss options
5. **prediction-being-applied**: User accepted, currently applying the edit changes to the buffer

### State Management:

- [x] Define `PredictionState` union type with the four states above
- [x] Add state to controller with current context and prediction data
- [x] Add state transitions in `myUpdate()` for each message type
- [x] Handle state validation (e.g., can't start new prediction while awaiting reply)

### Message Types:

- [x] Add `prediction-received` message type with tool use response
- [x] Add `prediction-accepted` and `prediction-dismissed` message types
- [x] Add `prediction-error` message type for handling failures

### Implementation:

- [x] Implement async response handling in controller
- [x] Add proper error handling for failed predictions
- [x] Store prediction context (original cursor position, context window) for later application

## Checkpoint 3: Edit Application and Preview ✅

**Goal:** Apply predicted edits and show virtual text preview with user interaction.

### Virtual Text Preview:

The controller manages a dedicated nvim namespace for all prediction overlays. Only one prediction can be active at a time.

**Diff-Style Visualization:**

- [x] Create dedicated namespace for edit prediction virtual text
- [x] **Unchanged text**: Remains as-is in the buffer
- [x] **Added text**: Displayed as virtual text with faint/grayed highlight group (e.g., `Comment` or custom group)
- [x] **Deleted text**: Original text marked with strikethrough highlight
- [x] **Mixed edits**: Combine strikethrough for deleted portions + virtual text for additions

**Implementation Details:**

- [x] Use `NvimBuffer.setExtmark()` with namespace for all overlays
- [x] Calculate diff between original context window and predicted replacement
- [x] Apply appropriate highlight groups for additions/deletions
- [x] Clear entire namespace when prediction is accepted/dismissed/cancelled
- [x] Position virtual text inline where additions should appear
- [x] Display accept/dismiss instructions as additional virtual text

**Diff Calculation Details:**

**Algorithm:** Use Myers diff algorithm (or similar LCS-based approach) for robust character-level diff calculation

- [x] Implement character-by-character diff for precise granularity
- [x] Handle newlines as regular characters in the diff calculation
- [x] Optimize for common code editing patterns (word boundaries, line breaks)

**Diff Representation:**

For extmark creation, we only need two primitive operations with character-level precision:

```typescript
type DiffOperation =
  | { type: "delete"; startPos: number; endPos: number } // character positions in original text
  | { type: "insert"; text: string; insertAfterPos: number }; // character position in original text

type EditPredictionDiff = DiffOperation[];
```

**Mapping to Virtual Text:**

- [x] **Delete operations**: Apply strikethrough highlight from `startPos` to `endPos` using `nvim_buf_add_highlight()`
- [x] **Insert operations**: Place virtual text after `insertAfterPos` with faint highlight using `setExtmark()` with `virt_text`

Note: Replace operations are handled as a delete followed by an insert at the same position.

**Character/Line Position Conversion:**

- [x] Track original context window start/end character positions for bounds checking
- [x] Convert character positions to (line, column) coordinates for nvim API calls
- [x] Handle multi-line insertions by splitting text and creating multiple extmarks
- [x] Handle deletions that span multiple lines by applying highlights across line boundaries

**Position Mapping for Extmarks:**

- [x] Store the buffer start position (line, column) where the context window begins
- [x] Build a newline index for the original context text to map character offsets to line/column within the context
- [x] Convert diff character positions to buffer coordinates: `contextStartPos + characterOffsetToLineCol(offset, newlineIndex)`
- [x] Handle edge cases where context window doesn't start at column 0

### Edit Application:

- [x] Implement find/replace within captured context window only
- [x] Validate that edits stay within original context bounds
- [x] Apply edits atomically when accepted

### User Interaction:

- [x] Add keyboard shortcuts for accepting predictions (ctrl-l)
- [x] Add keyboard shortcuts for dismissing predictions (e.g., Escape)
- [x] Clear virtual text and return to idle state after accept/dismiss
- [x] Handle edge cases (buffer changed since prediction, cursor moved significantly)

**Prediction Dismissal on User Input:**

- [x] Dismiss prediction on any buffer change
- [x] ctrl-l accepts the prediction
- [x] leaving insert mode rejects it (so esc should reject it) which makes it disappear
- [x] Set up buffer change listeners to detect typing/editing
- [x] Clear virtual text namespace and return to idle state when user types
- [x] Ensure dismissal happens before the user's keystroke is processed

### State Transitions:

- [x] `displaying-proposed-edit` → `idle` (on accept/dismiss)
- [x] `awaiting-agent-reply` → `displaying-proposed-edit` (on successful response)
- [x] `awaiting-agent-reply` → `idle` (on error/timeout)
- [x] Any state → `idle` (on explicit cancellation or buffer change)

## Architecture Notes

**Core Components:**

- `ChangeTracker`: Provides `getRecentChanges()` for recent edits
- `Provider.forceToolUse()`: Interface for forced tool use requests
- Fast model access via `profile.fastModel`

**Key Scoping Principle:**

- Predictions are scoped to ~20 line context window around cursor
- Find/replace operations only apply within this captured context
- Context window captured at time of prediction request

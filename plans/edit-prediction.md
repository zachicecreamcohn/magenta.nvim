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

**Goal:** Handle prediction response and store it in controller state.

- [ ] Extend test to verify prediction response handling
- [ ] Add prediction-received message type
- [ ] Implement async response handling
- [ ] Add state management for prediction lifecycle

## Checkpoint 3: Edit Application and Preview

**Goal:** Apply predicted edits and show virtual text preview.

- [ ] Add virtual text rendering for predictions
- [ ] Implement find/replace within context window
- [ ] Add accept/dismiss prediction functionality
- [ ] Add keyboard shortcuts for accepting/dismissing

## Architecture Notes

**Core Components:**

- `ChangeTracker`: Provides `getRecentChanges()` for recent edits
- `Provider.forceToolUse()`: Interface for forced tool use requests
- Fast model access via `profile.fastModel`

**Key Scoping Principle:**

- Predictions are scoped to ~20 line context window around cursor
- Find/replace operations only apply within this captured context
- Context window captured at time of prediction request

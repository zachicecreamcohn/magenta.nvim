# Standardize Tool Display

## Overview
Reorganize tool rendering from 6 functions (inFlightSummary/inFlightPreview/inFlightDetail + completedSummary/completedPreview/completedDetail) to 5 orthogonal functions that map to independently expandable sections in the thread view.

## Steps

- [x] Step 1: Update `ToolViewState` in thread.ts with 5 independent booleans and 5 toggle messages
- [x] Step 2: Update render-tools/index.ts dispatch to new 5-function API
- [x] Step 3: Reorganize per-tool renderers to export the new 5 functions
- [x] Step 4: Update thread-view.ts to render 5 independent sections with separate bindings
- [x] Step 5: Update streaming renderer for new format
- [x] Step 6: Fix type errors and run tests
- [x] Step 7: Format and commit

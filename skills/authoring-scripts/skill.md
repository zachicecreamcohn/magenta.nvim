---
name: authoring-scripts
description: How to author magenta scripts that run as subprocesses, spawn agent threads via thread(), and report progress via log(). Use when writing or testing a script in .magenta/scripts/.
---

# Authoring magenta scripts

Magenta scripts are TypeScript files placed in `.magenta/scripts/*.ts`. Each script
runs as a child process of the magenta node process and can drive real,
sidebar-visible agent threads.

## Where scripts live and how to import the SDK

Put scripts in `.magenta/scripts/`. Import the SDK through the stable shim that
magenta maintains in that directory:

```ts
import { registerScript } from "./magenta-sdk/index.ts";
```

Do not import from any other path — the shim resolves to the installed plugin's
SDK regardless of where the plugin lives on disk.

## The registerScript contract

```ts
registerScript(name, description, parameterSchema, runner);
```

- `name`: unique script name (how agents invoke it).
- `description`: shown to agents so they know when to use it.
- `parameterSchema`: a JSON Schema describing the `parameters` the runner receives.
- `runner(parameters, thread, log)`: an async function that does the work.

The runner receives:

- `parameters`: the validated input object.
- `thread(prompt, yieldSchema, options?)`: spawns a real magenta thread seeded
  with `prompt`, equipped with a `yield_to_parent` tool whose input schema is
  `yieldSchema`. Resolves to the structured value the agent yields. Use the
  generic to type the result: `await thread<{ done: boolean }>(...)`.
- `log(message)`: reports progress; surfaced in the magenta Scripts section.

## Minimal end-to-end example

```ts
import { registerScript } from "./magenta-sdk/index.ts";

registerScript(
  "summarize-file",
  "Summarizes a file and returns a one-line summary",
  {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  async (params: { path: string }, thread, log) => {
    log(`summarizing ${params.path}`);
    const result = await thread<{ summary: string }>(
      `Read ${params.path} and summarize it in one sentence.`,
      {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    );
    log(`summary: ${result.summary}`);
  },
);
```

## Testing a script

Use the in-process test harness from `./magenta-sdk/testing.ts`. It drives your
runner with test-double `thread`/`log` — no subprocess and no magenta required.
Statically import your script module first so its `registerScript` call runs.

```ts
import { expect, it } from "vitest";
import { runScript } from "./magenta-sdk/testing.ts";
import "./summarize-file.ts"; // registers the script

it("summarizes", async () => {
  const { handle, donePromise } = runScript("summarize-file", {
    path: "README.md",
  });

  const call = await handle.nextThread();
  expect(call.prompt).toContain("README.md");
  call.yield({ summary: "It is a readme." });

  await donePromise;
  expect(handle.logs).toContain("summary: It is a readme.");
});
```

`handle.nextThread()` resolves with each pending `thread()` call (in order),
exposing `prompt`, `yieldSchema`, `options`, and `yield(value)` / `reject(error)`
to settle that specific call. `handle.logs` captures `log()` output.

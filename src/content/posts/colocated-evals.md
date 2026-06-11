---
title: "Your agent's evals should live next to its tools"
description: 'Eval distance is an iteration tax. Why efferent keeps its eval suites in the same workspace as the prompts and tools they judge.'
pubDate: 2026-06-05
tags: [evals, effect, ai]
draft: true
---

Every agent codebase I've read keeps its evals somewhere else. A separate repo, a dashboard, a notebook someone ran in March. The code that *decides behavior* — system prompts, tool descriptions, loop policy — lives here; the thing that *measures behavior* lives there. Then a prompt edit ships because it looked fine in one manual session, and the regression is discovered by a user.

The fix is boring: evals are unit tests for behavior, and nobody puts their unit tests in a different repo.

## The shape

efferent's workspace has four packages, and evals are simply one of them:

```
packages/
├── core/       prompts, ports, tools — the behavior being judged
├── adapters/   provider SDKs + IO
├── cli/        composition root + TUI
└── evals/      the judges, in the same dependency graph
```

`packages/evals` imports the *real* system prompt and the *real* toolkit from `core`. There is no copy-paste of the prompt into a YAML file that drifts. When a tool description changes, the eval compiles against the new description or it doesn't compile at all.

## An eval is an Effect program

A case is data; a scorer is an Effect (the simple ones are wrapped predicates — but a judge can itself call a model); the runner is an Effect that provides the same Layers the app uses, minus the real terminal:

```ts title="packages/evals/src/suites/toolSelection.eval.ts"
const CASES = [
  {
    name: 'read-named-file',
    input: {
      files: { 'config.json': '{ "port": 8088, "host": "localhost" }\n' },
      prompt: "Read config.json and tell me which port the server uses. Don't edit anything.",
    },
    expected: { firstTool: 'read_file' },
  },
  // …
]

export const toolSelectionEval = defineEval<ToolInput, CoderRun, ToolExpected, EvalEnv>({
  name: 'tool-selection',
  threshold: 0.6,
  data: CASES,
  task: (input) =>
    runCoder(input.files, input.prompt, {
      allowTools: READ_ONLY,        // grep, glob, ls, read_file, read_skill
      stopAfterFirstToolTurn: true, // a case costs ~1 LLM call, never mutates
    }),
  scorers: [
    predicate('first_tool_exact', ({ output, expected }) =>
      output.tools[0] === expected.firstTool),
  ],
})
```

```bash
bun run eval tool-selection   # key-gated; skips politely without a credential
```

The runner provides the real router `LanguageModel` (a real model, judging real behavior) and even the real filesystem and shell — pointed at a disposable temp workspace that `Effect.acquireUseRelease` deletes afterwards, failure or not. What's swapped is everything stateful: in-memory conversation and context-tree stores instead of Postgres (no Docker), credentials read from env vars instead of the interactive `:login` flow, an allow-everything approval policy instead of the TUI modal. Same loop, same prompts, same Layer graph as `main.ts` — which is the quiet payoff of doing ports-and-adapters from day one: the test harness was free.

## Distance is the tax

The argument for colocation isn't tidiness, it's latency of the loop:

- **Change a prompt → run the suite** is one command in the same terminal, not a context switch to another repo and a deploy to an eval service.
- **Evals review with the diff.** The PR that softens a tool description carries the eval change that documents the new expectation. Reviewers see behavior and measurement move together.
- **CI gates on behavior.** `bun run typecheck && bun test` catches broken code; the eval suite catches broken *judgment*. Both run from the same checkout.

I started on [Evalite](https://www.evalite.dev) and still like its model — the reason efferent grew its own thin runner is Effect-specific: suites needed to provide Layers, and scorers wanted the typed run output — which tools fired, in what order — rather than strings. That's a few hundred lines (plus pass thresholds and per-case concurrency), not a framework. The principle survived the rewrite: *the eval lives where the behavior lives.* If your agent's judgment is defined in one repo and measured in another, one of those repos is lying to you, and you won't find out which until a user does.

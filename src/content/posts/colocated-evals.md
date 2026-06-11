---
title: "Your agent's evals should live next to its tools"
description: 'Eval distance is an iteration tax. Why efferent keeps its eval suites in the same workspace as the prompts and tools they judge.'
pubDate: 2026-06-05
tags: [evals, effect, ai]
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

A case is data; a scorer is a pure function; the runner is an Effect that provides the same Layers the app uses, minus the real terminal:

```ts title="packages/evals/src/suites/toolSelection.ts"
export const toolSelection = suite('tool-selection', [
  evalCase({
    name: 'failing test → read before edit',
    conversation: [user('fix the failing test in src/retry.test.ts')],
    score: firstToolCall(
      (call) => call.name === 'read_file',
      'agent should read the test before editing anything',
    ),
  }),
  evalCase({
    name: 'ambiguous ask → no bash yet',
    conversation: [user('clean this project up')],
    score: noToolCall((call) => call.name === 'bash'),
  }),
])
```

```bash
bun run eval tool-selection   # key-gated; skips politely without a credential
```

The runner provides `LanguageModelPort` live (a real model, judging real behavior) but swaps the filesystem and shell ports for sandboxed in-memory fakes. Same loop, same prompts, no Docker, no staging environment. A suite is just another Effect composed of the same Layers — which is the quiet payoff of doing ports-and-adapters from day one: the test harness was free.

## Distance is the tax

The argument for colocation isn't tidiness, it's latency of the loop:

- **Change a prompt → run the suite** is one command in the same terminal, not a context switch to another repo and a deploy to an eval service.
- **Evals review with the diff.** The PR that softens a tool description carries the eval change that documents the new expectation. Reviewers see behavior and measurement move together.
- **CI gates on behavior.** `bun run typecheck && bun test` catches broken code; the eval suite catches broken *judgment*. Both run from the same checkout.

I started on [Evalite](https://www.evalite.dev) and still like its model — the reason efferent grew its own thin runner is Effect-specific: suites needed to provide Layers, and scorers wanted typed access to `ModelEvent` streams rather than strings. That's a few hundred lines, not a framework. The principle survived the rewrite: *the eval lives where the behavior lives.* If your agent's judgment is defined in one repo and measured in another, one of those repos is lying to you, and you won't find out which until a user does.

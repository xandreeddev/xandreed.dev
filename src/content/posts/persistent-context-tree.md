---
title: 'Sub-agents over a persistent context tree'
description: "Sub-agent context is a tree worth keeping, not scaffolding to throw away. Resume, branch, handoff, staleness briefs, and fan-out under one token budget."
pubDate: 2026-06-09
tags: [agents, ai, effect]
draft: true
---

Most agent frameworks treat a sub-agent like a subprocess: spawn it, collect stdout, forget it existed. The transcript — every file it read, every dead end it ruled out — is garbage-collected the moment the summary lands. Then twenty minutes later you need that same sub-agent to go one step further, and your only option is to pay for the whole investigation again.

efferent makes the opposite bet: **a sub-agent's context is a node in a persistent tree**, stored in the same SQLite/Postgres database as the conversations themselves.

## One tool, folder-scoped

The parent agent has exactly one spawning tool:

```ts title="packages/core/src/usecases/buildScopeRuntime.ts"
const RunAgentTool = Tool.make('run_agent', {
  description: 'Spawn a sub-agent to do focused work scoped to a folder. …',
  parameters: {
    // …descriptions elided
    name: Schema.String,    // shown wherever the agent appears in the UI
    folder: Schema.String,  // relative to the workspace root
    task: Schema.String,
    seedFromNode: Schema.optional(Schema.String),
    seedMode: Schema.optional(
      Schema.Literal('resume', 'branch', 'handoff'), // [!code highlight]
    ),
  },
  success: Schema.Struct({
    summary: Schema.String,
    filesChanged: Schema.Array(Schema.String),
    nodeId: Schema.String,
  }),
  failure: Failure,
  failureMode: 'return',
})
```

The sub-agent gets the full coding toolkit, but writes are confined to `folder` (bash is cwd-bound there too), and if the folder has a `SCOPE.md`, its body is injected as ambient context — the directory's local rules, known by every agent that ever works there. Independent folders fan out in parallel; same-folder spawns queue on a per-folder lock, because two agents editing one directory is how you get merge conflicts with yourself.

## Resume, branch, or hand off

Because every spawn persists its messages, `seedFromNode` gives the parent three verbs over history:

- **`resume`** — continue *in* that node's context. The sub-agent that mapped `packages/adapters` yesterday picks up with everything it learned still in its window. It's also the expensive verb — a resume re-feeds the node's entire history every turn — so it's reserved for when the exact file contents in that context matter.
- **`branch`** (the default) — fork a *new* node seeded from those messages. The original stays intact; the fork explores a different approach from the same starting knowledge.
- **`handoff`** — seed a *fresh* node with a generated brief of the source's work. Continuity at a fraction of the tokens; the tool description tells the model to prefer it for follow-ups.

That turns sub-agent transcripts from exhaust into capital. An investigation is paid for once and drawn on repeatedly — `:tree` in the TUI browses the whole branching history: status, provenance (spawned / branched / resumed), files changed, what each node returned.

## The repo moves; the tree notices

A persisted context has a failure mode a fresh one doesn't: the world changes under it. Every node is stamped with the git `HEAD` it last saw. Resuming a node after the repo moved injects a *staleness brief* — a short diffstat of what changed since the stamp — and `:tree` shows a `stale` badge so the parent knows the node's beliefs predate the current code.

```
● packages/cli    spawned · done
● packages/core   branched · stale ← HEAD moved 14 commits
```

A stale node is still useful — that's why it's a brief, not an eviction. The model just stops trusting its memory of file contents and re-reads before editing.

## Fan-out wants a budget, not a leash

Parallel sub-agents are how an agent gets real work done, and also how a $3 turn becomes a $40 one. All sub-agents in a turn share one token pool (default 1M billed tokens, `:set subAgentTokenBudget`). A drained pool refuses new spawns with a failure written *for the model*:

> the sub-agent token budget for this turn is exhausted — do the remaining work yourself instead of spawning.

Running sub-agents stop at their next turn boundary and mark their results partial. The parent reads that and degrades gracefully — finishes the remaining folders itself, sequentially, in its own context. Spend shows per-node in `:tree`, so when a turn was expensive you can see exactly which subtree ate it.

The through-line: context windows are the scarce resource in agent systems, and scarce resources deserve persistence, provenance, and accounting. A tree with all three turns sub-agents from a gamble into infrastructure.

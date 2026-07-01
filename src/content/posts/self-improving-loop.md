---
title: 'Self-improvement is mostly distrust'
description: "efferent's learning loop in three jobs: a cheap model mines every run for lessons, an independent Opus referee refutes them in a clean-room sandbox, and deterministic code — never an LLM — writes the survivors."
pubDate: 2026-09-15
tags: [agents, effect, ai]
draft: true
series:
  name: 'Building a coding agent'
  order: 12
---

Here is a line from `.efferent/CONSTRAINTS.md` that no human wrote:

```md title=".efferent/CONSTRAINTS.md"
- [fleet-research-budget] (✓0 ✗0) Right-size the fleet to the task. A recent run
  over-worked it (12 workers, ~1840k billed tokens). For a question answerable
  from a few sources, use ONE researcher and a couple of search_web calls;
  reserve a multi-agent fleet for genuinely multi-axis or multi-package work.
```

The runtime wrote it, after a run in which the [fleet](/posts/async-fleet-orchestration/) fanned out absurdly wide for a small question — the worst case on record burned 69 `web_fetch` calls on a two-item answer. That runaway got attacked from two sides: a hard per-worker fetch budget, and this learned constraint, which every run since auto-loads into the system prompt under a `# Constraints` heading. The same task now lands in well under half the fetches, and delivers.

That's the whole promise of a self-improving agent in one bullet: a mistake, made once, becomes a rule the next run inherits. And the promise has an obvious failure mode that's worse than not learning at all — a confidently-wrong lesson doesn't poison one run, it poisons *every future run*, because it rides in on the system prompt wearing the authority of a rule. An agent runtime is amnesiac by default: run #400 starts from the same prompt as run #1. The naive fix — let the model write down what it learned — replaces amnesia with the possibility of durable, compounding delusion.

So the interesting part of the learning loop in [efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building on Effect, isn't the learning. A cheap model will happily propose lessons all day. The interesting part is that almost every component between "proposed" and "persisted" is machinery for saying **no**.

## Three jobs, and only one is allowed to create

The loop is three roles, and the division of labor is the design. It comes from [ACE](https://arxiv.org/abs/2510.04618) — Agentic Context Engineering, the Stanford/Berkeley/SambaNova work on evolving contexts — with the verify-gate idea borrowed from a much-circulated playbook (a 300-agent Kimi swarm with Opus as the closer; the thesis, *"the engine learns, the closer keeps it honest,"* is theirs). The roles:

- The **Reflector** (`packages/sdk-core/src/usecases/distill.ts`) reads a finished conversation and proposes candidate lessons. It runs on the `fast` tier — the same cheap model role that writes session titles and [approval judgments](/posts/bash-approval-rules/). It is the only role trusted to *create*, and nothing it says is believed.
- The **Verifier** (`packages/sdk-core/src/ports/Verifier.ts`) is an independent Opus process whose only job is to *refute*. It can't write anything. It can only kill candidates.
- The **Curator** (`packages/sdk-core/src/usecases/persistArtifact.ts`) persists the survivors — and it is not an LLM at all. It's deterministic code doing a delta-merge.

Propose cheaply, refute expensively, persist mechanically. Each stage distrusts the one before it.

## The Reflector: cite your evidence

`distill()` renders the transcript into a compact, **position-indexed** text — every message prefixed with its absolute index, tool floods summarized to one-liners, USER turns in caps so authority is attributable — and asks the fast model to mine it. What comes back is decoded against a schema, never hand-parsed; malformed JSON collapses to an empty list, not a crash. The shape of a candidate is where most of the discipline lives:

```ts title="packages/sdk-core/src/entities/Distillation.ts"
export const Candidate = Schema.Struct({
  kind: Schema.Literal('skill', 'memory', 'constraint', 'process'),
  name: Schema.String,        // kebab-case identity — the Curator's merge key
  description: Schema.String,
  body: Schema.String,        // the ABSTRACTED rule, never a play-by-play
  scope: Schema.Literal('global', 'project'),  // every repo, or just this one
  source: Schema.Literal('user', 'inferred'),  // who authored it — matters later
  evidence: Schema.Struct({
    conversationId: Schema.String,
    positions: Schema.Array(Schema.Number),    // transcript lines that justify it
  }),
})
```

The prompt's rules are lifted from the literature because the literature already paid for them. *Abstract the routine, not the log* — "when editing a Zod schema, run `bun typecheck` after" is a lesson; "I edited src/foo/bar.ts line 42" is a diary entry ([AWM](https://arxiv.org/abs/2409.07429)'s induce-the-workflow rule). *Skills only from success, constraints only from observed failure* — a skill proposed from a run that flailed is a recipe for flailing ([Reflexion](https://arxiv.org/abs/2303.11366) stores failures as verbal lessons; that's exactly what a constraint is). And the opening instruction is the one that fights the model's nature hardest: *most sessions yield NOTHING worth saving — return an empty list rather than padding.*

`evidence.positions` is the load-bearing field. Each lesson must cite the transcript lines that justify it, and the code stamps `conversationId` itself — the model never invents provenance. Evidence is what turns the next stage from an opinion into a check.

## The referee runs in a clean room

The `Verifier` is a port in the [ports-and-adapters](/posts/llm-provider-runtime-selection/) sense — sdk-core declares the interface, the adapter lives at the edge:

```ts title="packages/sdk-core/src/ports/Verifier.ts"
export class Verifier extends Context.Tag('@xandreed/sdk-core/Verifier')<
  Verifier,
  {
    /** The learning gate. Fail-CLOSED: any error → the candidate is dropped. */
    readonly refute: (
      candidate: Candidate,
      ctx: VerifyContext,
    ) => Effect.Effect<Verdict, VerifierError>
    /** The deliverable gate: sound / needs_work / blocked on a whole swarm run. */
    readonly gate: (
      input: GateInput,
    ) => Effect.Effect<DeliverableVerdict, VerifierError>
  }
>() {}
```

The production adapter, `ClaudeHeadlessVerifierLive` (`packages/sdk-adapters/src/verifier/claudeHeadless.ts`), does something that looks primitive next to everything else in the codebase: it shells out to the real `claude` CLI through the same `Shell` port the Bash tool uses. That's deliberate, twice over. First, headless Claude Code is the sanctioned path to the Opus *subscription* rate — an API key would bill the gate per token. Second, and more important: **the referee should be a process the engine can't influence.** efferent has its own Anthropic OAuth path; using it would mean the judge shares the engine's process, its config, its cache. A subprocess with a fresh context shares nothing.

Independence gets enforced physically, not rhetorically. Each verification runs in a sandbox:

```ts title="packages/sdk-adapters/src/verifier/claudeHeadless.ts"
// fresh temp dir: a controlled CLAUDE.md (the validator role) + the prompt file
const dir = await mkdtemp(join(tmpdir(), 'efferent-verify-'))
await writeFile(join(dir, 'CLAUDE.md'), VALIDATOR_CLAUDE_MD, 'utf8')
// copy ONLY claude's credentials in — it authenticates, but inherits no
// global CLAUDE.md, no memory, no user config
await copyFile(join(homedir(), '.claude', '.credentials.json'),
               join(dir, '.claude', '.credentials.json'))

const command =
  `HOME=${sq(dir)} ${bin} -p "$(cat ${sq(promptPath)})" ` +
  `--output-format json --model ${sq(model)} ${extraArgs}${addDir}` // [!code highlight]
```

Pointing `HOME` at the sandbox is the airtight move: claude authenticates but loads none of the user's global instructions or memory — measured empirically, inherited context drops to roughly nothing. The model is pinned (`EFFERENT_VERIFY_MODEL`, default `claude-opus-4-8` — a floating `opus` alias can change behavior under you). The repo is attached read-only via `--add-dir`, and *only* when the check is code-related: a project-scoped learning or a deliverable that changed files. A general rule like "use `const`" is judged on its merits, with no repo narrative to charm the judge.

Inside the sandbox, the refute prompt is reject-by-default: not true, not general, redundant with the existing library, unsafe (secrets, home paths, personal names), or simply not useful — any one kills the candidate. And because claude runs *as an agent*, not a text classifier, it greps the actual code and checks the cited transcript positions against ground truth. One earned fix here: the gate originally ran with `--permission-mode plan`, which is read-only — and a judge that structurally *cannot run the typecheck* will rubber-stamp code that doesn't compile, which it did. The default args now allow `Bash`/`Read`/`Grep`/`Glob` and deny every edit tool: the referee may run the project's own checks, and may change nothing.

Everything on the `refute` path is **fail-closed**. No `claude` on the PATH, a non-zero exit, an unparseable verdict — the candidate is dropped, never persisted. An unverifiable lesson and a false lesson get the same treatment, because from the library's point of view they're the same risk.

## The day structured output made it worse

The parsing story deserves its own confession, because I flip-flopped and the flip-flop taught me more than the design did.

The original gate scraped claude's free-text reply for a verdict with a greedy regex — `/\{[\s\S]*\}/`, first brace to last. Then a live run failed with `could not parse a deliverable verdict`: Opus had written a long, careful assessment of *code*, and code is full of braces, so the greedy span swallowed pages of prose into one unparseable blob. This looked like exactly the disease structured output cures. So I replaced the whole CLI adapter with a `StructuredVerifierLive` that called Opus through `generateObject` with a schema — a provider-enforced verdict, parse errors structurally impossible.

It survived one day. On the next live headless run the gate fell open with `verifier UNAVAILABLE — work NOT verified`, which is the one message this design must never produce for a shape reason. Two things had gone wrong at once: the engine's own provider route had no `generateObject` at all, and on the Anthropic side `generateObject` is really a forced tool call plus a client-side decode — the schema is a *hint*, not a contract. Opus returned `reasons: ""` — a bare string where the schema demanded an array — the strict decode rejected it, and a perfectly good verdict became "unavailable." The work shipped unverified. Fail-open, via the exact machinery I'd added to prevent parse failures.

So it went back — `claude -p` restored, structured adapter deleted — but with the lesson encoded where it belongs, in the parser (`packages/sdk-core/src/usecases/extractJson.ts`): a string-aware **balanced-brace scan** that walks the text tracking depth while skipping string literals, returns every top-level `{…}` object **last-first** — the prompt asks the model to *end* with the verdict, so the trailing object wins past any brace-heavy analysis — and decodes each against a tolerant schema where `reasons` may be an array, a bare string, or missing. If no object decodes but there *is* output, a keyword fallback extracts the verdict from prose and degrades to `needs_work` — fail-closed, re-check the work. "Unavailable" now means only its true cause: claude produced nothing.

The takeaway isn't "structured output is bad." It's that on a subprocess boundary, robustness has to live in the parser, because the schema can't reach across it — and that a verifier's failure modes matter more than its happy path. A gate that fails open is decoration.

## The Curator is not a model

Accepted candidates go to `persistArtifact()`, and this is the stage where the design refuses the most tempting shortcut. The obvious move — hand the library file and the new lesson to an LLM, ask for the merged file — is the one ACE measured as harmful. Ask a model to fold a context into itself and it *compresses*: their example collapsed an 18,282-token context at 66.7% accuracy into 122 tokens at 57.1% in a single rewrite. They call it context collapse. It's also a prompt-cache disaster — a wholesale rewrite invalidates the prefix on every run.

So the Curator is plain code, and every learning is a **delta item** with a stable id. A constraint is one bullet in `.efferent/CONSTRAINTS.md`; the merge is `findIndex` and a splice:

```ts title="packages/sdk-core/src/usecases/persistArtifact.ts"
const idx = lines.findIndex((l) => l.includes(`[${id}]`))
if (idx >= 0) {
  // update in place: keep the existing counters, refresh the rule text
  const counters = lines[idx]?.match(/\((✓\d+\s*✗\d+)\)/)?.[0] ?? '(✓0 ✗0)'
  lines[idx] = `- [${id}] ${counters} ${rule}`
}
// new id → append one line; NEVER regenerate the file
```

Skills land as `.efferent/skills/<slug>.md` with `source: distilled` in the frontmatter — the first programmatic write path skills ever had here — and a name collision *doesn't overwrite*: a possibly human-edited skill is never clobbered by a machine's second opinion. `scope` routes the write: a `global` lesson ("in Effect domain code, return typed errors, don't throw") lands under `~/.efferent/` and every project inherits it; a `project` lesson stays in the repo. The read side already walked both tiers, so the deposit compounds on the next run with no new loader — constraints render under `# Constraints`, and `process` learnings land in an operating-guidance overlay, `.efferent/prompts/coder.md`, rendered as `# Operating guidance` *above* the constraints. That last file means the loop can edit its own operating instructions — one bullet at a time, by id, deterministically.

## Two bypasses, both earned the same way

Two kinds of learning skip the Opus gate, and they share one justification: trustworthy by construction.

The first is **you**. When a USER turn states a rule — "use `const`", "no try/catch in the domain" — the miner tags it `source: "user"` and it persists directly, no refutation. The human is the authority; making you clear a gate to have your own correction remembered would be a strange power inversion, and the entire payoff is that you state a correction *once*. The bypass has one carve-out: a `process` learning — a rule about how the agent should *work*, destined for the prompt overlay — **always** passes Opus, even when a human prompted it. Editing the agent's own instructions is high-stakes enough that nobody gets to skip the referee.

The second is the **deterministic efficiency gate** (`packages/sdk-core/src/usecases/efficiencyGate.ts`) — the thing that wrote the bullet this post opened with. After every turn it reads the [persisted context tree](/posts/persistent-context-tree/) and sums two numbers: sub-agents spawned and tokens billed. Past deliberately egregious thresholds (more than 8 workers, or 1.5M tokens), it emits the canonical `fleet-research-budget` constraint — no LLM proposed it, so no LLM needs to check it, and the canonical slug means repeat offenses merge into one bullet instead of piling up. It catches the runaway the per-worker fetch cap can't: not one worker fetching too much, but too *many* workers, each individually within budget.

## The model can't opt out

For a while, the loop's deliverable-checking half was a tool. The coordinator's toolkit had `verify_with_gate` and `note_constraint`, and its prompt ended with a VALIDATE → LEARN → RETRY phase — please call the gate before you deliver. Which means the gate ran exactly when a model felt like remembering it.

Those tools are gone — defs and handlers deleted. Gating is now **structural** at both orchestrator tiers: the root's `driveLoop` runs it over the whole run, and every coordinator's subtree passes through it before that coordinator returns, both through one shared decision function:

```ts title="packages/sdk-core/src/usecases/gateLoop.ts"
export type GateStep =
  | { kind: 'no-subagents' }                 // no fleet this run — nothing to gate
  | { kind: 'accept'; event: AgentGateEvent }
  | { kind: 'stop';   event: AgentGateEvent }
  | { kind: 'retry';  event: AgentGateEvent; feedback: AgentMessage }
```

Each tier waits for the run's fresh sub-agent nodes to settle, then `gateOnce` unions their `filesChanged` and asks the Verifier's deliverable gate for a verdict. `sound` accepts. `needs_work` under the attempt cap (default 3) first *distills* — the failed attempt is mined for lessons while it's fresh — then retries with the verifier's concrete reasons injected as the next turn, so the swarm fixes named problems instead of re-rolling the dice. A broken gate emits a loud `unavailable` event and proceeds: never a silent pass, never an infinite loop. There is no tool to call and no tool to forget. The prompt can't opt out of the referee any more than your code can opt out of the type checker.

One verdict, though, was being over-enforced, and the fix is the most recent commit as I write this. A research run's deliverable is prose — no files changed. The gate used to treat a `needs_work` on prose like a red typecheck: re-run the entire fleet with the reviewer's notes, three times, then give up — the user watched their answer die in review. But a reviewer's `needs_work` on a *report* is an opinion, not a build failure; there's no compile error to fix, only judgment to disagree with. Now a deliverable that changed no files stops with an `advisory` flag and ships *with* the reviewer's notes — the TUI renders it as `⚑ verifier notes (delivered)` instead of a red failure. Fail-closed stays reserved for code, which genuinely either builds or doesn't.

## Mining the backlog

Because every conversation is [already in the database](/posts/persistent-context-tree/), the loop isn't limited to learning at turn boundaries — it can replay history:

```bash
efferent distill --dry-run --limit 5    # what WOULD it learn — no gate, no writes
efferent distill --since 2026-08-01     # mine + Opus-verify + persist survivors
efferent distill --conversation 43f2    # one conversation, by id prefix
```

The economics of the three-role split get literal here: the cheap miner reads the *whole* backlog; Opus fires only on the few candidates that survive it. `--dry-run` is the trust-building mode — review what the loop wants to believe before it's allowed to believe anything.

## What it costs

**The referee is slow and external.** An Opus review that actually reads files and runs the typecheck takes minutes — the timeout default is a generous 30, after an earlier 3-minute cap kept killing legitimate reviews mid-flight and reporting the gate "unavailable." And it requires the `claude` binary, logged in, on your PATH. For learnings that's fine — fail-closed just means learning pauses. For deliverables the design is fail-soft by intent: your task never blocks on a missing referee, you just don't get the sign-off.

**The counters don't count yet.** Every delta item carries `(✓0 ✗0)` helpful/harmful counters, and nothing increments them — the retrieval-to-outcome signal isn't wired. Dedup is by name only; the SkillOps-style maintenance pass ([retire when low-utility *and* duplicated](https://arxiv.org/abs/2605.13716)) is designed and unbuilt. The format carries the data from day one so the day the signal lands, history exists.

**The gate itself is the hardest thing here to eval.** It needs a logged-in binary, not an API key, so it can't run inside the key-gated [eval harness](/posts/colocated-evals/); the orchestration around it — fail-closed, thresholds, dry-run — is unit-tested against a stub verifier instead. The Reflector, by contrast, has a live eval suite scoring whether it extracts a lesson when there is one and stays quiet when there isn't. Staying quiet is the harder test.

**And writes invalidate the prompt cache.** Every persisted lesson changes the system-prompt prefix. That's acceptable precisely because the loop writes at boundaries — turn end, conversation end, a nightly cron — never mid-session. One deliberate prefix rebuild, same rule as a handoff.

## What survives, compounds

The lineage is worth stating plainly, because none of the load-bearing ideas are mine: ACE contributed the three roles and the deterministic delta-merge, AWM the abstract-the-routine and gate-on-success rules, Reflexion the failures-as-constraints framing, SkillOps the maintenance model the counters are waiting for — and the swarm-plus-closer shape came from a playbook whose engine half efferent already was. What the assembly adds is the posture: every stage assumes the previous one is wrong. The miner must cite positions. The referee must be a separate process in a bare room, and must run the tests. The writer must not be able to paraphrase. The model must not be able to skip the gate. A lesson that survives all of that has earned its line in the prompt — and the line at the top of this post is the receipt: the swarm that ran yesterday's task really is dumber than the one running today's.

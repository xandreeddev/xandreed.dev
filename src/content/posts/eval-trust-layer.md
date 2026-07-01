---
title: 'An eval suite is an instrument, and instruments need calibration'
description: 'Pinned sampling, pass^k, an independent judge scored against human labels, hidden tests, and bootstrap confidence intervals — the layer that decides whether an eval number means anything.'
pubDate: 2026-09-18
tags: [evals, agents]
draft: true
---

In late June I picked a code model for [efferent](https://github.com/xandreeddev/efferent) by running four candidates through its eval suite. The most useful line in the report was the one that refused to pick: every quality delta between the four came back `~ noise` — the confidence interval included zero — and the only real separation was cost, where one candidate spent ~40% more tokens for no measurable quality gain. A few weeks earlier the same experiment would have printed four means, I'd have ranked them, and I'd have been ranking sampling error.

[The June post](/posts/colocated-evals/) argued that evals are unit tests for behavior and belong in the repo. It ended with two confessions — *the numbers wobble* and *judges can be wrong* — and a promise that the machinery grown since was its own post. This is that post, and it's about a different question than where evals live: **why should anyone, including me, believe what they say?**

The frame that organizes everything below: an eval suite is a measurement instrument, and instruments need calibration. A unit-test suite is trustworthy by construction — deterministic code, exact assertions. An eval suite is not: there's a sampler inside the subject, a model inside the scorer, and a human inside the dataset. That opens four ways for the suite to silently stop measuring:

1. **Noise read as signal** — the same commit scores 0.78, then 0.71, and someone "fixes" the regression.
2. **A miscalibrated judge** — the LLM grader is lenient, or rewards length, and every rubric score inherits the bias.
3. **Teaching to the test** — the agent (or you, tuning prompts) overfits to the visible cases; or the test oracle itself is flaky.
4. **Underpowered comparisons** — an A/B delta over nine cases, presented as a finding.

Each one gets a mechanism. Everything below ships in `packages/evals` today, with paths.

## Noise: pin the sampler, then count what's left

The first move is boring and load-bearing: make the eval as deterministic as the providers allow. efferent's `Settings` entity grew two fields for exactly this — `samplingTemperature` and `samplingSeed` — which the product leaves unset (interactive use keeps provider defaults) and the eval environment pins:

```ts title="packages/evals/src/config/settingsLayer.ts"
/** Eval determinism defaults: greedy decoding + a fixed seed, so a measured
 *  delta reflects the CHANGE, not sampling noise. */
export const EVAL_DEFAULT_TEMPERATURE = 0
export const EVAL_DEFAULT_SEED = 0x5eed

export const withEvalDeterminism = (s: Settings): Settings => ({
  ...s,
  samplingTemperature: s.samplingTemperature ?? EVAL_DEFAULT_TEMPERATURE, // [!code highlight]
  samplingSeed: s.samplingSeed ?? EVAL_DEFAULT_SEED,
})
```

The overlay applies on both paths — a `--config` run and a bare local `bun run eval` — and the config path goes further: the run's settings live in a `FixedSettingsStore` whose `load()` ignores disk entirely, so `EFFERENT_MODEL` or a stray `.efferent/config.json` can't swap the model mid-experiment. A config is the independent variable of the run; the store makes it unstealable.

Honesty from the schema annotations themselves: temperature 0 is honored by the opencode gateway and Google, best-effort on OpenAI and Anthropic; the seed helps where supported. So this is variance *reduction*, not reproducibility — which is why the runner refuses to trust a single draw. A bare `bun run eval` runs every case **3 times** by default and reports mean ± stdev; `--samples 1` is the explicit opt-out for quick iteration.

Once you have k samples per case, you owe the report two different verbs, and this is where most eval writeups blur together:

```ts title="packages/evals/src/framework/runEval.ts"
// pass@k: at least one of the k samples passed the gate.
// pass^k: every sample did — the consistency metric.
const passAtK = samples.some((s) => samplePassed(spec, s))
const passHatK = samples.every((s) => samplePassed(spec, s)) // [!code highlight]
```

**pass@k asks "can it, ever."** That's the number you want while exploring capability — does any of k attempts solve it? **pass^k asks "does it, every time"** — and that's the product number for an agent that writes to real files unsupervised, because a 90% per-run success rate is a 59% success rate over five runs. The two metrics diverge exactly where it hurts: a flaky capability scores high on pass@k and terribly on pass^k, and the second one is the truth about shipping it.

One subtlety earns its own field. What does "a sample passed" mean? If it means "mean score above threshold," a generous judge can drag a broken sample over the bar and pass^k quietly becomes a judge-consistency metric. So a spec can name its gate:

```ts title="packages/evals/src/suites/feature.eval.ts"
export const feature = defineEval<Input, ScenarioRun, Expected, EvalEnv>({
  name: 'feature',
  threshold: 0.4,
  // pass^k gates on the OBJECTIVE scorer — all hidden tests green —
  // so consistency reflects code correctness, never the LLM judge.
  gate: { scorer: 'tests', min: 1 }, // [!code highlight]
  // …
})
```

## The judge: independent first, calibrated second

The June post's judge had two mitigations: a conservative system prompt and fail-closed JSON parsing. Real, and nowhere near enough, because the deeper problem is structural: if the judge is the same model as the agent under test, you've built a self-grading exam — the literature calls it self-preference bias — and if the judge runs on the same provider as the loop, one flaky gateway zeroes a correct solution's quality score.

So the judge became its own service. Not a config flag on the existing model — a separate `Context.Tag`, so the type system knows scorers and agents draw from different wells:

```ts title="packages/evals/src/framework/judge.ts"
/** The model that backs the LLM-as-judge scorers. Deliberately a SEPARATE
 *  tag from the agent's `LanguageModel`, so the judge can be a strong,
 *  INDEPENDENT grader — a different model from the one under test. */
export class JudgeModel extends Context.Tag('eval/JudgeModel')<
  JudgeModel,
  LanguageModel.Service
>() {}
```

Every `llmJudge` scorer resolves `JudgeModel`, never `LanguageModel`. The eval environment pins it to `--judge anthropic:claude-sonnet-4-6` (or whatever you pass) while the model under test is something else entirely; transient judge failures retry, and a hard failure degrades to a 0 with the cause in the score's detail rather than crashing the case. On top of it sits `qualityRubric`, which wraps every rubric in **fixed anchor levels** — 1.0 / 0.75 / 0.5 / 0.25 / 0, each with a one-line definition — so a 0.5 means the same thing in every suite and the scorecard is trendable across runs.

But an independent judge is still just a different model making numbers up, until you check it against the only ground truth that exists: human labels. `packages/evals/src/calibration/` is that check. The golden set is sixteen (rubric, output) pairs I hand-scored, deliberately covering the full 0..1 range *plus the documented LLM-judge failure modes as traps*:

```ts title="packages/evals/src/calibration/judgeGolden.ts"
{
  name: 'LENGTH-TRAP-long-confident-wrong',
  rubric: "Answers whether `parseInt('08')` returns 8 in modern JS.",
  // five confident sentences of octal folklore, concluding it "reliably returns 0":
  output:
    "This is a wonderfully subtle question that trips up even seasoned " +
    "engineers. Historically, JavaScript's `parseInt` was notorious…",
  human: 0.1, // [!code highlight]
},
{
  name: 'BREVITY-terse-correct',
  rubric: "Answers whether `parseInt('08')` returns 8 in modern JS.",
  output: "Yes — 8. ES5+ dropped the octal-on-leading-zero behavior.",
  human: 1, // [!code highlight]
},
```

The pairing is the point: same rubric, one long-confident-wrong answer, one terse-correct one. A judge with length bias fails the pair in a way the metrics can name. Alongside them: a fabricated citation (human 0.25), scope creep on a one-line rename (0.5), a hedging non-answer (0.25), a restated question dressed as an answer (0).

`bun run eval --judge-agreement` grades the whole set with the *real* judge — the exact `qualityRubric` scorer the suites use, so the numbers describe the judge they actually trust — and prints two families of agreement stats. Binary: Cohen's κ on pass/fail plus TPR/TNR, because raw percent agreement flatters a judge when most cases pass. Graded: MAE, signed bias (positive means systematically lenient), Pearson and Spearman correlation, and a length-bias probe — the judge's bias on longer-than-median outputs minus its bias on the shorter half. And the trust bar is executable:

```ts title="packages/evals/src/run.ts"
// Soft gate by default; --strict fails the run on a weak/biased judge.
if (argv.includes('--strict') && (s.cohensKappa < 0.41 || cal.mae > 0.25 || cal.lengthBias > 0.2)) {
  console.error('✘ judge calibration below trust bar (κ<0.41 or MAE>0.25 or length-bias>0.2)')
  process.exitCode = 1
}
```

κ below 0.41 — the conventional floor of "moderate agreement" — means the judge axis is decoration, and the run says so with an exit code.

## Overfitting: tests the agent can't read, checked before they can score

The suites from June share a weakness the moment you use them to *rank models* rather than catch regressions: the cases are visible. Visible to the agent, whose loop could in principle read the assertions; and visible to me, who tunes prompts against the same dozen cases every week. Both are overfitting; only the second one is embarrassing.

The `feature` suite is the counter. Each scenario is a full feature — an LRU cache with per-entry TTL, an RFC-4180 CSV parser, a nested-transaction KV store — shipped to the agent as a typed stub plus a precise prose spec. The grading suite is **hidden**: 44 `bun test` assertions written into the workspace *after* the agent finishes, then executed in the same network-less container. The agent can't read them, can't edit them, and must infer the full spec from the prompt — exactly the deal production users offer. Scenarios also tag their nastiest file as `edgeTests`, scored separately as `tests_edge`, because an overall pass-ratio drowns the hard cases in happy-path wins.

This suite exists because its predecessor stopped discriminating. The `quality` suite's toy tasks — one-line bug fix, add a pure function, a two-file rename — saturate at ~1.0 for any competent coder, which is how four candidate code models came back statistically indistinguishable in the June matrix run. A saturated eval isn't measuring anymore; the fix was harder cases with enumerable edge cases (recency-vs-expiry interplay, CSV quoting, tombstone semantics), where a weak coder ships a plausible solution that fails the edges. There's also an escape hatch for the fully paranoid: `EFFERENT_EVAL_PRIVATE` loads extra scenarios from a JSON file outside the repo, so the hardest cases never enter a public commit a future model might be trained on.

Hidden tests introduce their own trust problem, though: now the *oracle* can be wrong, and a flaky hidden test silently corrupts every model's score. So each scenario carries a known-good `reference` implementation the agent never sees, and a pre-check runs it against the hidden tests three times:

```ts title="packages/evals/src/support/validateSuites.ts"
const deterministic = runs.every(
  (r) => r.pass === first.pass && r.fail === first.fail && r.exitCode === first.exitCode,
)
const allPass = runs.every((r) => r.exitCode === 0 && r.fail === 0 && r.pass > 0)
// deterministic AND allPass — the suite is a reliable oracle. // [!code highlight]
```

A flaky or broken hidden suite is caught by `bun test` before it can grade anyone. The module's header cites the numbers that scared it into existence, from published audits of SWE-bench: 30 of its 34 flakiest tasks flaked on the *gold* solution, and only ~39% of instances were verifiably deterministic. An execution-graded eval is only as trustworthy as its oracle, and oracles don't validate themselves.

## Deltas: a confidence interval or it didn't happen

Everything so far protects a single number. Most eval-driven decisions compare two — old prompt vs new prompt, model A vs model B — and comparison is where small-suite evals quietly lie hardest, because a handful of cases times a stochastic system produces impressive-looking deltas out of nothing.

efferent's answer is one function, deliberately dependency-free and deterministic:

```ts title="packages/evals/src/trace/significance.ts"
export const pairedDeltaCI = (
  baseline: ReadonlyArray<number>, // per-case means, paired by case name
  candidate: ReadonlyArray<number>,
  iterations = 2000,
  seed = 0x5eed1e, // fixed-seed PRNG: same data, same CI, unit-testable
  comparisons = 1, // Bonferroni: alpha = 0.05 / comparisons
): DeltaCI => {
  // … resample WHOLE-CASE deltas (each case = one cluster) …
  return { delta, low, high, significant: low > 0 || high < 0, n, cohensD, standardError }
}
```

The choices matter more than the code. **Paired**: the same cases run under both configs, and the bootstrap resamples per-case *deltas*, so case difficulty cancels out instead of inflating the variance. **Clustered**: with k samples per case, resampling happens at the case level, because samples within a case are correlated — the comment credits Anthropic's eval-statistics work for the observation that naive per-sample standard errors can understate the noise several-fold. **Bonferroni-corrected**: comparing four candidates against a baseline at raw 95% is a one-in-five chance of a spurious "winner"; the alpha shrinks with the number of comparisons and the report label changes to match. **Deterministic**: the bootstrap PRNG is seeded, so the statistics module — the thing deciding "significant" — is itself under ordinary unit test.

Every comparison in the report ends in one of three verdicts: `✔ better`, `✘ worse`, or `~ noise`. The receipts, from the repo's committed baselines: the June delegation-prompt tune (shipped alongside a judge fix that let the rubric see every read-back file) moved the quality suite from 0.82 to 0.99 — Δ +0.17, 95% CI [0.05, 0.29], significant, keep it. The code-model matrix from the opening of this post: every quality delta `~ noise`, decision made on cost instead. And the baselines README carries a caution I keep rereading: the 0.99 snapshot happened to land routing at 1.0 on every case, so its per-case stdev reads 0.00 — which *understates* the true run-to-run variance. A later run dipping on one scenario is within noise; trust the CI verdict over any raw per-case delta.

Baselines are what make this a gate rather than a party trick. `--save` writes a dated, git-SHA-stamped JSON snapshot — including a reproducibility manifest: the sandbox image's content digest, a hash of `bun.lock`, and the exact model selection per role — and the snapshot gets committed under `packages/evals/baselines/`. A later `--compare` pairs cases by name, bootstraps the CI, and:

```ts title="packages/evals/src/run.ts"
// Regression GATE: fail the run iff a suite SIGNIFICANTLY regressed
// (paired bootstrap CI excludes 0, Bonferroni-corrected). A
// non-significant dip is reported but never fails.
if (regressions.length > 0) process.exitCode = 1 // [!code highlight]
```

That last comment is the part I'd defend hardest: a gate that fires on noise is a gate people learn to re-run until it's green, and then it's not a gate. This one only fails on a drop the statistics can stand behind. In CI it's cost-gated — a `run-evals` PR label or a manual dispatch, never every push — because each run spends real provider money.

## The smaller guards in the ledger

Three more mechanisms, briefly, because each kills a quieter failure mode:

- **A tool-coverage map.** `packages/evals/src/coverage.ts` records which suites behaviorally exercise each coding tool; a test fails if a tool is added to the toolkit without a coverage decision. An empty entry is legal — it means *considered, deliberately uncovered*, a documented gap instead of an oversight. This exists because the background-shell tools once shipped with no eval at all, invisibly.
- **A hardened clean room.** The June post covered the disposable-workspace basics ([temp dirs, allow-all approval, in-memory stores](/posts/colocated-evals/)). The suites that execute LLM-generated code go further now: each case runs in an ephemeral Docker container with `--network none`, a 2 GB memory ceiling with swap disabled, a PID limit against fork bombs, and a CPU cap — and `sandboxRunArgs` is a pure function, so a unit test asserts the hardening flags are present without needing a Docker daemon.
- **The framework is under test beneath the models.** The agreement metrics, the bootstrap, the report aggregation, the coverage map, the oracle pre-check — all pure, all covered by plain `bun test` with no key and no network. The parts of the instrument that *can* be deterministic, are.

Running it, from a source checkout — `bun run eval` in the repo, or the `efferent eval` subcommand, which forwards to the same runner:

```bash
bun run eval                              # every suite, 3 samples per case
bun run eval feature --samples 5 \
  --main opencode:kimi-k2.6 --judge anthropic:claude-sonnet-4-6
bun run eval --judge-agreement --strict   # is the judge itself trustworthy?
bun run eval quality \
  --compare packages/evals/baselines/2026-06-25-quality.json
efferent verify                           # graded acceptance battery, tiers A/B/C
```

`efferent verify` is the same philosophy pointed at the CLI itself: Tier A is deterministic and keyless (boot, subcommand parsing, UI flows, daemon lifecycle), Tier B runs real turns on the cheap model but asserts *side effects* — a file on disk, a successful tool call — never prose, and Tier C bridges to a small eval smoke set, soft by default because a flaky judge shouldn't fail a build.

## What's still weak

Calibration talk invites its own audit, so: the judge's independence is opt-in — with no `--judge` flag it falls back to the main model, and the self-preference mitigation quietly evaporates. The binary labeled set is eight obvious cases; the file's own comment admits a set like that reads κ≈1 trivially and needs to grow to ~50 borderline cases mined from real sessions before the κ gate means much. The public feature set is three scenarios — a real discriminator, not yet a broad one. The CI workflow compares against `packages/evals/baseline.json`, a path nothing has committed yet (the dated baselines live one directory over), so today's CI run reports but the regression gate can't actually fire — wiring, not philosophy, but unfinished wiring. And determinism remains a provider negotiation: on Anthropic, temperature 0 is a request, not a contract.

## Instruments drift

The thesis, earned the long way: every mechanism in this post exists because some part of the measurement chain was silently lying. The sampler lied about deltas, so temperature and seed got pinned and the residual got counted as pass^k. The judge lied about quality, so it became an independent model graded against human labels, with its length bias measured as a number. The visible cases lied about generalization, so the tests went hidden — and then the hidden tests could lie, so a reference implementation checks the oracle before the oracle checks anyone. The comparisons lied about significance, so no delta ships without a confidence interval that excludes zero.

None of it makes the numbers *true*. A calibrated instrument is still an instrument — what changes is that it now reports how wrong it might be, and refuses to render verdicts beyond its resolution. `~ noise` is my favorite output the suite produces. An eval that can say "I don't know" is the only kind whose "worse" I'm willing to let fail a build.

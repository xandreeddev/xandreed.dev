---
title: 'Bash approval: rules, not dialogs'
description: 'Every approval dialog should leave a rule behind. How efferent makes its permission prompt rate decay instead of compound.'
pubDate: 2026-06-02
tags: [agents, ux]
draft: true
---

A coding agent that can run shell commands needs a permission gate, and the default design is a dialog: *allow / deny*. The problem with a dialog is that it's stateless. You will approve `bun test` four hundred times this month, and the four-hundredth dialog teaches the system nothing. Stateless approval doesn't make you safer, it makes you numb — and numb users click *allow* on the command that mattered.

efferent's gate asks a different question. Every command prompt has four answers:

1. **allow once** — this command, this time
2. **allow `bun test …` for this session** — a prefix rule, session-scoped
3. **always allow in this project** — a prefix rule, persisted
4. **deny, with a reason** — refused, and the reason travels

Three of the four answers create a rule. That's the design, stated as a claim: **every approval interaction should leave the system knowing more than it did.** Under that invariant the prompt rate decays toward exactly the commands you've never blessed — which is the set you actually want to look at.

A rule is just a string key, and granularity is the whole game. Too coarse (`bash:*`) recreates unrestricted shell one click at a time; too fine (exact commands) re-prompts on every changed test path and recreates the rubber stamp. The landing spot is command + subcommand:

```ts title="packages/core/src/ports/Approval.ts"
export const bashRuleKey = (command: string): string => {
  const trimmed = command.trim().replace(/\s+/g, ' ')
  if (SHELL_META.test(trimmed)) return `exact:${trimmed}`
  const [head, second] = trimmed.split(' ')
  if (head === undefined || head.length === 0) return `exact:${trimmed}`
  return second !== undefined && !second.startsWith('-')
    ? `cmd:${head} ${second}` // [!code highlight]
    : `cmd:${head}`
}
```

So blessing `bun test src/retry.test.ts` leaves `cmd:bun test` behind — except a flag as the second word collapses to the bare command (a blessed `cmd:rm -rf` would read safer than it is), and anything carrying shell metacharacters gets an `exact:` rule, because a pipe or substitution can't be judged by its first words. Project answers persist these keys in the workspace settings (`approvedBashRules: ['cmd:bun test', …]`); session answers live in memory and die with it.

The sleeper feature is answer four. In most agents, a denial is a dead end — the tool call fails, the model shrugs, the turn dies. Here the denial *and your reason* go back to the model as a structured tool failure:

```json
{
  "error": "Denied",
  "message": "the user denied this command: don't touch the prod db, use test.db — adjust your approach; don't retry it verbatim."
}
```

A reason is course-correction data. The model reads it and tries the test database, the same way it would react to a failing compiler. You said no *once*, with one sentence, and the rest of the turn bends around it instead of dying.

In front of the modal sits one more rule-shaped thing: a judge. A fast-tier model classifies each command no rule matches before any dialog appears — ordinary development work whose paths stay inside the permitted folders (the workspace root, plus any folder you've granted) is waved through; installs, global state, network, broad deletes, or anything unclear falls back to the human. The grants themselves are *folders*, not command prefixes: when a command reaches outside and you answer "always allow in this project", what persists is the folder it reached for. And the judge is routing, not enforcement — its error channel is `never`, so any failure (no key, a 429, malformed JSON) degrades to showing you the dialog. It can only ever remove prompts, never add risk.

Headless modes don't get dialogs at all — `--print` and CI runs keep the static `--allow-bash` gate, because a prompt nobody will ever see is just a hang with extra steps.

None of this is novel security machinery; it's interaction design applied to a security surface. The gate's job isn't to interrupt you, it's to accumulate your judgment. A permission system you train is one you keep reading. One that nags you four hundred times is one you turn off.

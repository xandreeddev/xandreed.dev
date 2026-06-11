---
title: 'Bash approval: rules, not dialogs'
description: 'Every approval dialog should leave a rule behind. How efferent makes its permission prompt rate decay instead of compound.'
pubDate: 2026-06-02
tags: [agents, ux]
---

A coding agent that can run shell commands needs a permission gate, and the default design is a dialog: *allow / deny*. The problem with a dialog is that it's stateless. You will approve `bun test` four hundred times this month, and the four-hundredth dialog teaches the system nothing. Stateless approval doesn't make you safer, it makes you numb — and numb users click *allow* on the command that mattered.

efferent's gate asks a different question. Every command prompt has four answers:

1. **allow once** — this command, this time
2. **allow `bun test …` for this session** — a prefix rule, session-scoped
3. **always allow in this project** — a prefix rule, persisted
4. **deny, with a reason** — refused, and the reason travels

Three of the four answers create a rule. That's the design, stated as a claim: **every approval interaction should leave the system knowing more than it did.** Under that invariant the prompt rate decays toward exactly the commands you've never blessed — which is the set you actually want to look at.

```ts title="packages/core/src/entities/bashRule.ts"
export class BashRule extends Schema.Class<BashRule>('BashRule')({
  prefix: Schema.String,                              // "bun test"
  scope: Schema.Literal('session', 'project'),
  decision: Schema.Literal('allow', 'deny'),
}) {}
```

The sleeper feature is answer four. In most agents, a denial is a dead end — the tool call fails, the model shrugs, the turn dies. Here the denial *and your reason* go back to the model as a structured tool failure:

```json
{ "denied": true, "reason": "don't touch the prod db, use test.db" }
```

A reason is course-correction data. The model reads it and tries the test database, the same way it would react to a failing compiler. You said no *once*, with one sentence, and the rest of the turn bends around it instead of dying.

Headless modes don't get dialogs at all — `--print` and CI runs keep the static `--allow-bash` gate, because a prompt nobody will ever see is just a hang with extra steps.

None of this is novel security machinery; it's interaction design applied to a security surface. The gate's job isn't to interrupt you, it's to accumulate your judgment. A permission system you train is one you keep reading. One that nags you four hundred times is one you turn off.

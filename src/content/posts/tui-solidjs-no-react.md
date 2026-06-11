---
title: 'A terminal UI with SolidJS signals and no React'
description: "Streaming agent output is a fine-grained reactivity problem. Why efferent's TUI is OpenTUI + Solid signals instead of Ink, and what the cost model looks like."
pubDate: 2026-06-12
tags: [tui, typescript, agents]
draft: true
---

An agent TUI has an unusual rendering profile: long stretches of nothing, then a burst of hundreds of tiny updates per second — token counters ticking, a spinner, new conversation lines, a context gauge — each touching a few terminal cells. The natural way to say "this number changed" should cost about as much as changing the number.

That profile is why efferent's TUI is **OpenTUI + SolidJS signals**, and why it isn't Ink.

## The cost model is the argument

Ink is React for the terminal, and it inherits React's update semantics: state changes schedule a re-render, components re-execute, the reconciler diffs element trees, and the renderer works out what changed. For a settings form, fine. For a stream pushing thirty token-count updates a second into a UI that also has a conversation pane, a file list, and a status bar, you're paying tree-diff prices for cell-sized changes — at streaming frequency, with the GC participating.

Solid has no virtual anything. `createSignal` wires a dependency from a value to the exact JSX expressions that read it. When the value changes, those expressions re-run. Nothing else does:

```tsx title="packages/cli/src/tui-solid/Activity.tsx"
const [tokensOut, setTokensOut] = createSignal(0)
const [contextUsed, setContextUsed] = createSignal(0)

export const Activity = () => (
  <box border title="activity">
    <text>context  {fmtTokens(contextUsed())} / 1M</text>
    <text>tok out  {fmtTokens(tokensOut())}</text>
  </box>
)
```

When `setTokensOut` fires, the one text node showing the count updates. OpenTUI's native renderer (loaded over FFI) keeps a retained scene graph and repaints damaged regions — Solid's fine-grained graph tells it precisely which region that is. The "diff" step doesn't get cheaper; it gets *deleted*.

## Effect on one side, signals on the other

The agent loop is Effect all the way down, so the seam between the two worlds is one adapter: fibers push, signals receive.

```ts
const wireTokens = (events: Stream.Stream<ModelEvent, ModelError>) =>
  events.pipe(
    Stream.filter((e) => e._tag === 'TokenDelta'),
    Stream.runForEach((e) =>
      Effect.sync(() => setTokensOut((n) => n + e.count)),
    ),
  )
```

Streams stay typed and interruptible on the Effect side (Esc cancels the fiber, not the UI); rendering stays synchronous and surgical on the Solid side. Neither framework leaks into the other's half — `core` has no idea a terminal exists.

It also composes upward: assistant prose renders as markdown and code blocks come back syntax-highlighted through tree-sitter, all as OpenTUI components sitting in the same signal graph — not a hand-rolled ANSI escape pass over strings.

## "No React" is a cost model, not a mood

The README says *no Electron, no React, no Ink*, and it's worth being precise about why, because it isn't aesthetics. React's reconciliation is a brilliant amortization strategy for DOM trees mutated by unpredictable handlers. A terminal streaming pipeline is the opposite shape: updates are predictable, tiny, and constant. Paying reconciliation there is buying insurance against a risk you don't have.

Choose the rendering model whose cost curve matches your update pattern. For an agent's terminal — thousands of small, known mutations — that's signals into a retained native renderer. If that conclusion generalizes past terminals, well. The blog you're reading ships zero framework JavaScript.

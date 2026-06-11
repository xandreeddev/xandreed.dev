---
title: 'Swap your LLM provider at runtime, not compile time'
description: 'Provider choice is request-scoped state, not architecture. How efferent routes one LanguageModel service across Claude, Gemini, and OpenAI per request.'
pubDate: 2026-05-29
tags: [effect, ai, agents]
draft: true
---

The standard Effect answer to "how do I support multiple LLM providers?" is the one I shipped first: the agent loop talks to one service — `@effect/ai`'s `LanguageModel` — and you satisfy it with a provider Layer at the composition root.

```ts
// composition root, take one
const ModelLive = config.provider === 'google'
  ? GoogleLanguageModel.model('gemini-…')
  : AnthropicLanguageModel.model('claude-…')
```

This is clean and it is wrong, because it answers the wrong question. Layers are resolved when the runtime is built. A user sitting in the TUI who types `:model` and picks a different provider is not asking you to rebuild the runtime — they are changing a preference, mid-session, and they expect the *next message* to honor it. Provider choice is request-scoped state. Treating it as architecture means a restart to switch models, which is roughly the moment a terminal tool stops feeling native.

## One service, resolved per request

efferent keeps the single `LanguageModel` tag, but the live Layer is a router. Nothing about the agent loop knows providers exist; it asks the service to stream. The router resolves *which* provider client to use inside each call:

```ts title="packages/adapters/src/llm/router.ts"
export const RouterLanguageModelLive = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const registry = yield* ModelRegistry      // the `:model` choice
    const authStore = yield* AuthStore         // ~/.efferent/auth.json
    const settingsStore = yield* SettingsStore
    const http = yield* HttpClient.HttpClient

    const resolveAndBuild = (sel: ModelSelection) =>
      Effect.gen(function* () {
        const cred = yield* authStore.get(sel.provider)
        const key = yield* authStore.resolveKey(sel.provider) // …error mapping elided
        const settings = yield* settingsStore.get()
        return yield* makeProviderLanguageModel(sel, key, cred, settings)
      })

    const service: LanguageModel.Service = {
      // generateText / generateObject: same shape, wrapped in Effect.scoped
      streamText: (options) =>
        Stream.unwrapScoped(
          registry.current.pipe( // [!code highlight]
            Effect.flatMap((sel) =>
              resolveAndBuild(sel).pipe(
                Effect.map(({ svc }) => svc.streamText(options)), // …prompt shaping elided
              ),
            ),
            Effect.provideService(HttpClient.HttpClient, http),
          ),
        ),
    }
    return service
  }),
)
```

The trick is `Stream.unwrapScoped`: the selection happens inside the stream's own setup effect, so every request re-reads the active model. And the *scoped* half matters as much as the unwrap — the provider client built by `resolveAndBuild` lives exactly one call, so nothing holds a stale client for a provider you switched away from. `:login` writes a credential, `:model` writes a selection, and the very next turn goes out on the new provider — same session, no restart, no rebuilt Layer graph.

The error channel stays honest too. A failed `resolveKey` — usually a dead OAuth refresh — surfaces as an error that says to run `:login <provider>` again, not as a stack trace from deep inside a provider SDK.

Provider quirks ride the same seam. Anthropic caches nothing unless the request carries `cache_control` breakpoints, so the router stamps them (`withAnthropicCacheBreakpoints`) right where it shapes each outgoing call. Per-request routing didn't preclude provider-specific behavior; it gave it exactly one place to live.

## The abstraction has to carry opaque state

Multi-provider abstractions die on the details, not the happy path. Gemini's thinking models return a `thought_signature` that must be echoed back on the next turn, or the model loses its reasoning thread. If your message type normalizes everything down to `{ role, content }`, you have silently destroyed provider state you didn't know existed.

So the message schema carries a slot the core never inspects:

```ts title="packages/core/src/entities/Conversation.ts"
export const AssistantMessage = Schema.Struct({
  role: Schema.Literal('assistant'),
  content: Schema.Array(
    Schema.Union(TextPart, ReasoningPart, ToolCallPart),
  ),
  providerOptions: Schema.optional(Schema.Unknown), // [!code highlight]
})
```

The Gemini adapter round-trips signatures through `providerOptions` (every content part carries the same slot); the Anthropic adapter ignores it. An abstraction is allowed to have a hole in it, as long as the hole is typed and exactly one adapter looks inside.

## So what are Layers for, then?

Tests, still. The unit tests hand the loop a scripted model — `Effect.provideService(LanguageModel.LanguageModel, model.layer)` — and the whole agent loop runs against canned responses; that's the swap Layers are genuinely good at, the one that happens at build time because the *program* is different. (The eval suites go the other way and deliberately keep the live router — they exist to judge real model behavior.) The swap users do forty times a day belongs in state. Getting those two confused is how you end up restarting your agent to change a dropdown.

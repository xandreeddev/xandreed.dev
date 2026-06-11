---
title: 'Swap your LLM provider at runtime, not compile time'
description: 'Provider choice is request-scoped state, not architecture. How efferent routes one LanguageModel port across Claude, Gemini, and OpenAI per request.'
pubDate: 2026-05-29
tags: [effect, ai, agents]
---

The standard Effect answer to "how do I support multiple LLM providers?" is the one I shipped first: define a port, write one Layer per provider, pick the Layer at the composition root.

```ts title="packages/core/src/ports/languageModel.ts"
export class LanguageModelPort extends Context.Tag('core/LanguageModelPort')<
  LanguageModelPort,
  {
    readonly stream: (
      request: ModelRequest,
    ) => Stream.Stream<ModelEvent, ModelError>
  }
>() {}
```

```ts
// composition root, take one
const ModelLive = config.provider === 'google'
  ? GeminiLanguageModel.layer
  : AnthropicLanguageModel.layer
```

This is clean and it is wrong, because it answers the wrong question. Layers are resolved when the runtime is built. A user sitting in the TUI who types `:model` and picks a different provider is not asking you to rebuild the runtime — they are changing a preference, mid-session, and they expect the *next message* to honor it. Provider choice is request-scoped state. Treating it as architecture means a restart to switch models, which is roughly the moment a terminal tool stops feeling native.

## One port, resolved per request

efferent keeps a single `LanguageModelPort`, but the live Layer is a router. Nothing about the agent loop knows providers exist; it asks the port to stream. The router resolves *which* provider client to use inside each call:

```ts title="packages/adapters/src/llm/router.ts"
export const RouterLanguageModel = Layer.effect(
  LanguageModelPort,
  Effect.gen(function* () {
    const auth = yield* AuthStore          // ~/.efferent/auth.json
    const settings = yield* SettingsStore  // the `:model` choice
    const clients = yield* ProviderClients // one lazy client per provider

    return {
      stream: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const selection = yield* settings.activeModel
            const credential = yield* auth.credentialFor(selection.provider)
            const client = yield* clients.for(selection.provider, credential)
            return client.stream({ ...request, model: selection.model })
          }),
        ),
    }
  }),
)
```

The trick is `Stream.unwrap`: the selection happens inside the stream's own effect, so every request re-reads the active model. `:login` writes a credential, `:model` writes a selection, and the very next turn goes out on the new provider — same session, no restart, no rebuilt Layer graph.

The error channel stays honest too. `credentialFor` fails with a tagged `MissingCredential` that the TUI renders as "run `:login`", not as a stack trace from deep inside a provider SDK.

## The abstraction has to carry opaque state

Multi-provider ports die on the details, not the happy path. Gemini's thinking models return a `thought_signature` that must be echoed back on the next turn, or the model loses its reasoning thread. If your port normalizes messages down to `{ role, content }`, you have silently destroyed provider state you didn't know existed.

So the port's message type carries a slot the core never inspects:

```ts
export class AssistantMessage extends Schema.Class<AssistantMessage>('AssistantMessage')({
  content: Schema.Array(ContentBlock),
  providerMeta: Schema.optional(Schema.Unknown), // [!code highlight]
}) {}
```

The Gemini adapter round-trips signatures through `providerMeta`; the Anthropic adapter ignores it. A port is allowed to have a hole in it, as long as the hole is typed and exactly one adapter looks inside.

## So what are Layers for, then?

Tests, still. The eval suites swap `LanguageModelPort` for a scripted model with `Layer.succeed` and the whole agent loop runs against canned responses — that's the swap Layers are genuinely good at, the one that happens at build time because the *program* is different. The swap users do forty times a day belongs in state. Getting those two confused is how you end up restarting your agent to change a dropdown.

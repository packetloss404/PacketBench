# Provider integrations — October 6, 2026

PacketBench 0.14.9 adds Sugar, ClinePass, OpenCode Go, Ollama Cloud, Google
Gemini and xAI. It is now included in the updated desktop executable. Peer
review, release source and installation evidence are recorded in
[the 0.14.9 release record](./provider-release-0.14.9.md).

## Configuration

Open Settings → AI Providers → Providers & Models. Save a separate API key
for each service, then choose its endpoint under Provider Endpoints. Keys
stay in the OS credential store; endpoint overrides are stored in the existing
backend provider settings file. Reset restores the documented service URL.

| Provider | Default API base | Model discovery |
| --- | --- | --- |
| Sugar | `https://usesugar.dev/api/v1` | Authenticated `/models` |
| ClinePass | `https://api.cline.bot/api/v1` | `clinePass` entries from `/ai/cline/recommended-models` |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | `/models` |
| Ollama Cloud | `https://ollama.com/v1` | `/api/tags` on the same host |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Paginated `/v1beta/models`, filtered for text generation |
| xAI | `https://api.x.ai/v1` | `/language-models` |

For the local Sugar project at `D:\projects\sugar`, use
`http://localhost:3211/api/v1` and a Sugar-issued API key. The integration does
not start, modify or deploy Sugar, or copy its upstream provider credentials.
Google uses an AI Studio key, not a Vertex service account. Ollama Cloud is
separate from the local Ollama daemon and its memory/context settings.

The current-model controls also refresh direct Anthropic and OpenAI catalogs.
Model pickers share the catalog cache, refresh on use after one hour, and offer
an explicit Refresh action. Key/endpoint changes invalidate the affected cache;
late responses from the old configuration cannot replace the new list.
Existing conversation model IDs are preserved. The new providers have no
invented bundled model defaults: select a discovered model or enter its exact ID.

Public subscription catalogs report inventory, not account entitlement. A
stored-key badge is not a successful inference check. Missing keys, rejected
keys and discovery failures remain visible. Unreported pricing is not a promise
of free usage, including cloud-hosted models sharing local model names.

## Runtime

All six providers use the native API-agent runtime and its existing tool
permissions, cancellation and SSH execution context. They appear in the
conversation provider picker, Flight target selection and explicit auxiliary
task routing. Auxiliary routes require a selected model; automatic cheap-model
selection does not guess one for these services.

Sugar, ClinePass, Ollama Cloud and Gemini use Chat Completions. Gemini tool
signatures and gateway reasoning are preserved across tool rounds. OpenCode Go
uses Messages for MiniMax/Qwen, Responses for GPT/Muse and newer Grok models,
and Chat Completions for the remaining families. Its requests carry this app's
user agent and the conversation's `x-opencode-session` identifier. The Go
catalog currently supplies IDs without transport metadata, so family routing
follows its documented endpoint table and must be revisited if that contract
changes. No inference request is retried against another protocol.

xAI and modern direct OpenAI models use stateless Responses requests. Returned
output items, including encrypted reasoning, are replayed with tool results.
Messages requests preserve signed content blocks. Truncated streams and
streamed error responses are surfaced as failures.

## Evidence and remaining acceptance

Read-only research checked the Sugar source and the official references below.
The public ClinePass, Go and Ollama Cloud catalogs responded on October 6.
No paid generation or private-account discovery was performed.

Regression coverage includes configured catalog URLs and auth headers, Pass-only
filtering, Google generation capabilities, current model IDs, all three Go
transports, tool metadata replay, incomplete streams, settings edits, model
refresh errors and stale-response invalidation. Local HTTP fixtures use dummy
keys and never contact paid services. All 11 local quality gates passed, including
frontend tests, end-to-end tests, production frontend build, Rust checks/tests,
sidecar checks and command-schema parity. Final follow-up verification passed:
Rust library tests (1,041 passed, 5 ignored), frontend tests and lint, and the
production frontend build including TypeScript compilation. The corrected
model-discovery test file also passed all 19 tests.

Account acceptance remains: configure real keys, refresh each catalog, then run
a short conversation with a tool call and a follow-up turn on each provider.
Check the selected subscription's entitlement separately. The owner's paid
Claude test remains deferred because of subscription cost.

## References

- [ClinePass API use](https://docs.cline.bot/getting-started/clinepass)
- [Cline's Pass catalog](https://api.cline.bot/api/v1/ai/cline/recommended-models)
- [OpenCode Go endpoints and session headers](https://opencode.ai/docs/go/)
- [Ollama Cloud](https://docs.ollama.com/cloud)
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [Gemini signed tool calls](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- [xAI language model discovery](https://docs.x.ai/developers/rest-api-reference/inference/models)
- [xAI Responses and encrypted reasoning](https://docs.x.ai/developers/model-capabilities/text/generate-text)
- [Anthropic model discovery](https://platform.claude.com/docs/en/api/models/list)
- [OpenAI model discovery](https://developers.openai.com/api/reference/resources/models/methods/list)
- [OpenAI Responses replay](https://developers.openai.com/api/docs/guides/migrate-to-responses)

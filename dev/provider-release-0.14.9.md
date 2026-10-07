# PacketBench 0.14.9 release

Release preparation: October 6, 2026. The owner requested peer review, a new
release tag, commit/push, compilation and an update of the desktop installation.

## Scope

Sugar (including the local gateway), ClinePass, OpenCode Go, Ollama Cloud,
Google Gemini and xAI are configurable API providers. Direct Anthropic and
OpenAI share the live catalog refresh controls. Provider-specific stream and
tool-history handling is included. Configuration, protocol choices and account
acceptance limits are documented in [the integration record](./provider-integrations-2026-10-06.md).

## Acceptance boundaries

The source implementation passed all eleven quality gate categories. Final
implementation follow-up passed 1,041 Rust library tests (5 ignored), frontend
tests, lint and the production frontend build. Release peer review and final
artifact/install evidence are recorded below when completed.

Real-key model discovery and paid-provider conversations are not established by
local HTTP fixtures. Interactive Workspace dogfooding remains incomplete. The
paid Claude check remains deferred because of subscription cost. Signing and
the updater remain under the existing owner-only distribution decision.

## Peer review and corrections

An independent code-review agent reviewed the provider diff against main. The
named Bugbot tool was unavailable, so the review used the available code-review
agent. All three confirmed findings were corrected before release:

| Severity | Location (file:line) | Finding |
| --- | --- | --- |
| P1 | `src-tauri/src/core/tool_subagent.rs:127` | Child agents dropped opaque provider state after tool calls. Collection and assistant history now retain it; each child also owns a stable session identifier. |
| P1 | `src-tauri/src/core/llm_openai_compat.rs:565` | Named chat providers did not request streamed usage. Their requests now ask for usage, with a regression covering the final usage-only frame. |
| P2 | `src/components/views/tools/ProviderRoutingCard.tsx:45` | Workflow roles read only bundled models, leaving new providers empty. They now use the shared live/manual model picker, and incomplete automatic routes fail before launch. |

Follow-up inspection also corrected retries: a same-provider retry retains the
selected model, and one-click reassignment suggestions require a concrete model
default. Providers without one remain available in the normal launch picker.
Tests cover selected live models reaching Flight targets, cache invalidation,
nonzero streamed usage and child tool round-trip metadata for all three wire
formats. Cline token-limit field compatibility remains an account acceptance
item; no speculative conversion was added.

## Release validation

All eleven quality gate categories passed after the peer-review corrections:
format, lint, TypeScript, frontend tests, frontend build, Remote Agents checks,
browser tests, sidecar checks, Rust check/test and command-schema parity. The
full run found only release-version file formatting; that was corrected and
the same formatting gate passed separately. The lightweight packaging gate
also passed all eleven checks. Artifact and installation results follow in a
post-build evidence update; they are not implied by source validation.

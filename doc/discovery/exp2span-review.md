# exp2span Review: semantic-convention alignment for opencode-otel-exporter

## Scope and confidence

This review compares the current plugin implementation in [`/opencode-otel-semantics-exporter.ts`](/opencode-otel-semantics-exporter.ts) with the newer `exp2span` implementation and docs, with special focus on OpenTelemetry semantic conventions.

Confidence ranking for source material used in `exp2span`:

1. **Most reliable**: source code in [`rektide/exp2span` `src/parser.rs`](https://github.com/rektide/exp2span/blob/main/src/parser.rs), [`rektide/exp2span` `src/exporter.rs`](https://github.com/rektide/exp2span/blob/main/src/exporter.rs)
2. **Mostly reliable**: [`rektide/exp2span` `README.md`](https://github.com/rektide/exp2span/blob/main/README.md)
3. **Often stale / planning-only**: [`rektide/exp2span` `doc/PLAN-enhancements.md`](https://github.com/rektide/exp2span/blob/main/doc/PLAN-enhancements.md), [`rektide/exp2span` `doc/PLAN-nested.md`](https://github.com/rektide/exp2span/blob/main/doc/PLAN-nested.md), [`rektide/exp2span` `doc/PLAN-cursor-trace.md`](https://github.com/rektide/exp2span/blob/main/doc/PLAN-cursor-trace.md)

The current implementation here is already solid in architecture and event correlation; most recommendations below are incremental semantic tightening.

## What current implementation already does well

- Correlates events into a meaningful hierarchy (`chat` parent with `thinking` and `tools/call <tool>` children), rather than one span per raw event.
- Uses core GenAI attributes from current conventions (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.conversation.id`).
- Uses MCP operation semantics for tool calls (`mcp.method.name=tools/call`, `gen_ai.operation.name=execute_tool`).
- Maintains per-session state, and closes active spans on `session.completed` / `session.error` / idle boundaries.
- Emits token usage attributes and a dedicated token metric instrument.

## Learnings from exp2span worth carrying forward

From `exp2span` source, these are the strongest patterns to keep mirroring:

- Keep one turn-oriented parent span model (`chat`) and attach tool/reasoning spans as children.
- Keep `gen_ai.input.messages` / `gen_ai.output.messages` in message-part schema shape, not legacy `gen_ai.prompt` / `gen_ai.completion` fields.
- Keep explicit MCP tool-call semantics (`tools/call`, `execute_tool`) instead of custom `opencode.*` keys for core behavior.
- Prefer stable, low-cardinality span names (`chat`, `thinking`, `tools/call <tool>`).

## Gaps against current specs (and how to improve)

### 1) Add `mcp.session.id` alongside `gen_ai.conversation.id`

- Current plugin records conversation id, but not explicit MCP session id.
- MCP semconv recommends `mcp.session.id` for session-scoped requests.
- Recommendation: emit both, with same value when mapped from OpenCode session id.

Reference:
- [MCP semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/)
- [MCP attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/mcp/)

### 2) Avoid hard-coding `network.transport=tcp`

- Current plugin always sets `network.transport=tcp`.
- MCP semconv says transport should reflect actual channel (`pipe` for stdio, `tcp`/`quic` for HTTP transport).
- Recommendation: make transport configurable/detected; default to `pipe` if this is in-process/stdio behavior.

Reference:
- [MCP transport guidance](https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/#recording-mcp-transport)
- [Network attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/network/)

### 3) Populate `jsonrpc.request.id` when available

- Current code has call IDs and tool IDs but does not emit `jsonrpc.request.id`.
- Recommendation: map `callId`/request id to `jsonrpc.request.id` on tool-call spans.

Reference:
- [JSON-RPC attributes registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/jsonrpc/)
- [JSON-RPC 2.0 spec](https://www.jsonrpc.org/specification)

### 4) Reduce forced `StatusCode.OK` writes

- Current instrumentation explicitly sets `OK` for many successful spans.
- OTel trace guidance generally expects instrumentation libraries to leave status unset unless recording an error.
- Recommendation: only set status on errors (`ERROR`), and leave success as unset unless there is a concrete reason.

Reference:
- [OTel tracing API: Set Status](https://opentelemetry.io/docs/specs/otel/trace/api/#set-status)

### 5) Add structured error attributes for failed operations

- On failures, current code closes spans as error but does not set `error.type` and does not map RPC status codes.
- Recommendation: on `session.error` and tool failures, set `error.type`; for JSON-RPC failures also set `rpc.response.status_code` when known.

Reference:
- [MCP semconv client span requirements](https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/#client)

### 6) Align token metric with current GenAI metric conventions

- Current instrument: counter named `gen_ai.client.token.usage` with `gen_ai.token.type` and `gen_ai.conversation.id`.
- Current GenAI metrics semconv defines `gen_ai.client.token.usage` as a **histogram**, and requires attributes including `gen_ai.operation.name` and `gen_ai.provider.name`.
- Recommendation: switch to histogram, emit required attrs (`gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.token.type`), and include model/server attrs when known.

Reference:
- [GenAI metrics semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/)

### 7) Add content controls for sensitive fields

- Tool args/results and message bodies are emitted by default.
- Semconv docs explicitly warn these fields may contain sensitive content.
- Recommendation: add config gates (off/redact/hash/truncate/full) for:
  - `gen_ai.input.messages`
  - `gen_ai.output.messages`
  - `gen_ai.tool.call.arguments`
  - `gen_ai.tool.call.result`

Reference:
- [GenAI attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)

### 8) Context propagation inside MCP metadata (when event payload allows)

- MCP semconv recommends propagating trace context in `params._meta` (for message-level propagation independent of transport).
- Recommendation: if OpenCode exposes request param metadata, inject/extract `traceparent`/`tracestate` at MCP message boundary in addition to ambient context.

Reference:
- [MCP semconv context propagation](https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/#context-propagation)
- [MCP spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/)

## exp2span docs that appear stale vs code

- `doc/PLAN-enhancements.md` is mostly pre-implementation planning language and does not reflect current shipped behavior.
- `doc/PLAN-nested.md` contains older attribute names/shape discussion that no longer matches `src/parser.rs` outputs.
- `doc/PLAN-cursor-trace.md` is a separate proposal track (agent-trace export), not a semconv truth source for current exporter behavior.
- `README.md` is useful but includes aspirational fields not consistently present in current `src/exporter.rs`.

For semconv alignment decisions, prefer `exp2span` code first, then README, then plans.

## Suggested implementation order for this repo

1. Emit `mcp.session.id` and `jsonrpc.request.id`; make `network.transport` accurate/configurable.
2. Stop defaulting status to `OK`; add `error.type` / `rpc.response.status_code` on failures.
3. Add privacy controls for content-bearing attributes.
4. Update token metric instrument + attribute set to current GenAI metric conventions.
5. Add MCP `_meta` trace propagation when data model supports it.

## Appendix: `_meta` trace propagation (brief)

When OpenCode event payloads expose MCP request/notification params, use this flow:

1. **Outbound MCP request path**
   - Build/retain `params._meta` object.
   - Inject W3C context into that bag using OTel propagation (`traceparent`, optional `tracestate`, optional `baggage`).
   - Do not overwrite unrelated `_meta` keys already set by app/tooling.

2. **Inbound MCP handling path**
   - Extract parent context from `params._meta` first.
   - Start MCP/tool span with extracted remote parent.
   - If ambient transport context exists (for example HTTP span), add it as a span link when parent differs.

3. **Fallback behavior**
   - If `_meta` is missing, use existing ambient context behavior.
   - If extraction fails, continue without failing request processing.

Minimal JSON shape:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "read",
    "_meta": {
      "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "tracestate": "rojo=00f067aa0ba902b7"
    }
  },
  "id": 1
}
```

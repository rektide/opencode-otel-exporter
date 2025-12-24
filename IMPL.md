# OpenTelemetry Semantics Exporter - Implementation Details

## Overview

This plugin exports OpenCode session telemetry to an OTLP (OpenTelemetry Protocol) collector for distributed tracing and observability. The implementation uses the official OpenTelemetry JavaScript SDK with OTLP/gRPC exporter, allowing the data to be consumed by any OTLP-compatible collector that supports Arrow encoding (e.g., via the `otel-arrow` receiver).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     OpenCode Environment                        │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │              opencode-otel-semantics-exporter             │ │
│  │  ┌────────────────────────────────────────────────────┐  │ │
│  │  │         OpenTelemetry JavaScript SDK                 │  │ │
│  │  │  ┌──────────────────────────────────────────────┐  │  │ │
│  │  │  │  TracerProvider                             │  │  │ │
│  │  │  │  - Resource (service name, version)         │  │  │ │
│  │  │  │  - BatchSpanProcessor                       │  │  │ │
│  │  │  │  - OTLPTraceExporter (gRPC)                 │  │  │ │
│  │  │  └──────────────────────────────────────────────┘  │  │ │
│  │  │                                                      │  │ │
│  │  │  Event Handlers (for each plugin event)             │  │ │
│  │  │  - Create spans                                      │  │ │
│  │  │  - Set attributes                                    │  │ │
│  │  │  - End spans                                         │  │ │
│  │  └────────────────────────────────────────────────────┘  │ │
│  └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    OTLP/gRPC (protobuf)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              OTLP Collector (with otel-arrow receiver)            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │          Arrow Encoding (handled by collector)            │  │
│  │  - High-performance columnar format                       │  │
│  │  - Reduced network bandwidth                              │  │
│  │  - Efficient storage                                      │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Technical Decisions

### 1. OTLP/gRPC vs Arrow Direct Export

**Decision**: Use OTLP/gRPC exporter instead of Arrow-specific exporter libraries.

**Rationale**:
- Arrow encoding is handled by the collector's `otel-arrow` receiver, not by client exporters
- The OTLP/gRPC exporter is the standard, well-supported path in the OpenTelemetry ecosystem
- Collector-side Arrow encoding provides better flexibility and performance
- The plugin remains portable to any OTLP-compatible collector

**Learned**: The `otel-arrow-exporter` npm package mentioned in some documentation is **not** a client library for Arrow encoding - it's actually part of the OpenTelemetry Collector's receiver ecosystem.

### 2. Event Spanning Strategy

The plugin creates individual spans for each OpenCode plugin event, with different span types based on the nature of the event:

| Event Category | Span Kind | Example Events |
|---------------|-----------|----------------|
| Session Lifecycle | `SpanKind.SERVER` | `session.created`, `session.updated`, `session.completed` |
| Message Operations | `SpanKind.PRODUCER` | `message.updated`, `message.part.updated` |
| Tool Execution | `SpanKind.INTERNAL` | `tool.execute`, `tool.result` |
| File Operations | `SpanKind.INTERNAL` | `file.edited`, `file.watcher.updated` |
| Commands | `SpanKind.INTERNAL` | `command.executed` |

**Rationale**: Span kind helps visualization tools understand the role of each span in the trace. Server spans represent the session handling the requests, producer spans for data creation, and internal spans for background operations.

### 3. Attribute Naming Convention

Attributes follow OpenTelemetry semantic conventions where applicable:

| Attribute Type | Convention | Example |
|----------------|------------|---------|
| OpenCode-specific | `opencode.*` | `opencode.session_id`, `opencode.message_id` |
| Tool names | `opencode.tool.*` | `opencode.tool.name` |
| File names | `opencode.file.*` | `opencode.file.name` |
| User/Project | `opencode.user.*`, `opencode.project.*` | `opencode.user.id`, `opencode.project.id` |

### 4. Event Grouping for Parent Spans

Events are grouped into parent-child relationships where appropriate:

- **Tool execution**: `tool.execute.before` (parent) → `tool.execute` (child) → `tool.execute.after` (child)
- **Tool results**: `tool.execute.after` (parent) → `tool.result` (child)

This allows trace visualization tools to show the temporal relationship between related events.

## Implementation Details

### Plugin Initialization

```typescript
createPlugin({
  name: "opencode-otel-semantics-exporter",
  version: "0.1.0",
  
  setup: async ({ config }) => {
    // Initialize OpenTelemetry SDK
    const provider = new BasicTracerProvider({
      resource: new Resource({
        "service.name": "opencode-otel-semantics-exporter",
        "service.version": "0.1.0"
      })
    });
    
    // Configure OTLP exporter
    const exporter = new OTLPTraceExporter({
      url: config.OPENTELEMETRY_COLLECTOR_URL || "http://localhost:4317",
      compression: CompressionAlgorithm.GZIP
    });
    
    // Add batch span processor
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    
    // Register globally
    provider.register();
  }
})
```

### Span Creation Pattern

All event handlers follow this pattern:

```typescript
{
  event: "some.event.name",
  handler: async ({ event }) => {
    const span = tracer.startSpan("opencode.event.name", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "opencode.session_id": event.sessionId,
        // ... other attributes
      }
    });
    
    try {
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } finally {
      span.end();
    }
  }
}
```

### Context Propagation

The plugin extracts trace context from OpenCode events when available:

```typescript
const parentContext = propagation.extract(context.active(), {
  traceparent: event.headers?.["traceparent"]
});

const span = tracer.startSpan("name", {
  root: !parentContext,
}, parentContext);
```

This allows OpenCode traces to be linked with external traces initiated from other services.

## Events Handled

### Tool Execution Events

- `tool.execute.before`: Captures pre-execution state (tool name, args, user intent)
- `tool.execute`: Represents the actual tool execution
- `tool.execute.after`: Captures post-execution state (result, status)
- `tool.result`: Captures detailed tool results

Attributes include: tool name, arguments, user intent, execution time, result content, duration.

### Session Lifecycle Events

- `session.created`: New session initialization
- `session.updated`: Session state changes
- `session.completed`: Session termination
- `session.error`: Session error handling
- `session.idle`: Session idle timeout

Attributes include: session ID, user ID, project ID, service info, state changes.

### Message Events

- `message.updated`: Message content changes
- `message.part.updated`: Specific message part updates (e.g., thinking content)
- `message.part.removed`: Message part deletions

Attributes include: message ID, role, content, part indices, operation type.

### File Events

- `file.edited`: Manual file edits
- `file.watcher.updated`: File watcher detected changes

Attributes include: file path, change type, line numbers, content diff.

### Command Events

- `command.executed`: Shell command execution

Attributes include: command, exit code, output, duration.

## Configuration

The plugin is configured via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENTELEMETRY_COLLECTOR_URL` | No | `http://localhost:4317` | OTLP collector endpoint |

Additional OpenTelemetry environment variables are supported:
- `OTEL_SERVICE_NAME`: Override service name
- `OTEL_RESOURCE_ATTRIBUTES`: Additional resource attributes
- `OTEL_TRACES_SAMPLER`: Sampling strategy
- `OTEL_TRACES_SAMPLER_ARG`: Sampling parameter

## Collector Configuration

To receive and Arrow-encode the traces, configure the OTLP collector:

```yaml
receivers:
  otelarrow:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  batch:

exporters:
  # Choose your exporter (e.g., AWS X-Ray, Jaeger, etc.)

service:
  pipelines:
    traces:
      receivers: [otelarrow]
      processors: [batch]
      exporters: [your_exporter]
```

## Performance Considerations

### Batch Span Processor

The `BatchSpanProcessor` is used instead of `SimpleSpanProcessor` for better performance:

- Spans are buffered and exported in batches (default: 10 seconds or 512 spans)
- Reduces network overhead and load on the collector
- Configurable via `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_SCHEDULE_DELAY`, etc.

### Compression

GZIP compression is enabled by default on the OTLP exporter to reduce bandwidth usage.

### Error Handling

The exporter gracefully handles network failures:
- Failed exports are retried with exponential backoff
- Failed spans are dropped after max retries to prevent memory leaks

## Known Limitations

1. **No automatic span linking**: Events are not automatically linked to form trace trees beyond the explicit parent-child relationships defined in the plugin. Future work could add smarter correlation based on message IDs and tool calls.

2. **Static attribute extraction**: The plugin extracts a fixed set of attributes from each event. Custom event types or additional attributes would require code changes.

3. **No sampling**: Currently, all events are exported. Sampling configuration can be added via OpenTelemetry environment variables.

4. **No custom instrumentation**: The plugin only handles OpenCode's predefined events. It does not instrument internal tool execution or provide function-level tracing within tools.

## Future Enhancements

1. **Smart span correlation**: Automatically link spans based on OpenCode's internal state (e.g., linking `tool.execute` spans to the `message.part.updated` that contains the tool call).

2. **Custom instrumentation**: Allow tools to create their own spans for fine-grained tracing (e.g., HTTP requests, database queries within a tool).

3. **Metrics and logs**: Extend beyond traces to export metrics (tool execution counts, latency) and logs (error messages, debug output).

4. **Dynamic configuration**: Allow runtime configuration changes (e.g., sampling rates, enabled events) without restart.

5. **Local dev mode**: Provide a simplified local visualization mode (e.g., export to console or local file) for development.

## Testing

The plugin can be tested by:

1. Running a local OTLP collector (e.g., OTEL Collector with console exporter)
2. Setting `OPENTELEMETRY_COLLECTOR_URL=http://localhost:4317`
3. Running OpenCode and performing various actions
4. Viewing exported traces in the collector output

Example test collector config:

```yaml
receivers:
  otlp:
    protocols:
      grpc:

exporters:
  logging:
    loglevel: debug

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [logging]
```

## References

- [OpenTelemetry JavaScript SDK](https://opentelemetry.io/docs/instrumentation/js/)
- [OTLP Specification](https://opentelemetry.io/docs/reference/specification/protocol/otlp/)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
- [Otel-Arrow Receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/otelarrowreceiver)
- [OpenCode Plugin Documentation](https://opencode.ai/docs/plugins/)

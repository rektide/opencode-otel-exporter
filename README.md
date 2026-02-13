# OpenCode OpenTelemetry Traces Exporter Plugin

OpenCode plugin that exports OpenTelemetry traces for various plugin events using OpenTelemetry JavaScript SDK.

## Features

Exports spans using an MCP/gen-ai trace shape derived from `exp2span` patterns:
- One parent `chat` span per conversation turn
- Child `tools/call <tool>` spans for tool execution
- Child `thinking` spans for reasoning/snapshots
- Session-aware span closing on `session.updated`, `session.idle`, `session.completed`, and `session.error`

**Multi-format export support:**
- OTLP/gRPC (default) - Production distributed tracing
- OTLP/HTTP - Firewall-friendly HTTP transport
- Console - Development and debugging
- File (JSON) - Offline analysis
- File (NDJSON) - Stream processing and log aggregation
- Jaeger - Direct Jaeger integration
- Composite - Multiple exporters simultaneously

## Installation

1. Add plugin to your project:

```bash
# Create plugin directory if it doesn't exist
mkdir -p .opencode/plugin

# Copy plugin directory
cp -r opencode-otel-semantics-exporter.ts .opencode/plugin/
cp -r exporters .opencode/plugin/
```

2. Install dependencies:

```bash
npm install @opentelemetry/api \
  @opentelemetry/sdk-trace \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/exporter-trace-otlp-grpc \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-jaeger \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions \
  @opencode-ai/plugin
```

## Configuration

### Export Format Selection

Use `OPENTELEMETRY_EXPORT_FORMAT` environment variable to select export format:

```bash
# Default: OTLP/gRPC (production)
export OPENTELEMETRY_EXPORT_FORMAT=otlp-grpc

# OTLP/HTTP (firewall-friendly)
export OPENTELEMETRY_EXPORT_FORMAT=otlp-http
export OPENTELEMETRY_COLLECTOR_URL=https://otel.example.com/v1/traces

# Console logging (development)
export OPENTELEMETRY_EXPORT_FORMAT=console

# File export (offline analysis)
export OPENTELEMETRY_EXPORT_FORMAT=file-json
export OPENTELEMETRY_FILE_PATH=./spans.json

# NDJSON file (log aggregation)
export OPENTELEMETRY_EXPORT_FORMAT=file-ndjson
export OPENTELEMETRY_FILE_PATH=./spans.ndjson

# Jaeger (direct integration)
export OPENTELEMETRY_EXPORT_FORMAT=jaeger
export OPENTELEMETRY_JAEGER_ENDPOINT=http://localhost:14268/api/traces

# Composite (multiple exporters)
export OPENTELEMETRY_EXPORT_FORMAT=composite
export OPENTELEMETRY_COMPOSITE_EXPORTERS='[{"format":"otlp-grpc","otlp":{"url":"http://localhost:4317"}},{"format":"console"}]'
```

### OTLP/gRPC Configuration

```bash
# Collector endpoint
export OPENTELEMETRY_COLLECTOR_URL=http://localhost:4317

# Compression (default: gzip)
export OPENTELEMETRY_OTLP_COMPRESSION=gzip
export OPENTELEMETRY_OTLP_COMPRESSION=none
```

### OTLP/HTTP Configuration

```bash
# Collector endpoint
export OPENTELEMETRY_COLLECTOR_URL=https://otel.example.com/v1/traces

# Compression (default: gzip)
export OPENTELEMETRY_OTLP_COMPRESSION=gzip
```

### Jaeger Configuration

```bash
# HTTP endpoint
export OPENTELEMETRY_JAEGER_ENDPOINT=http://localhost:14268/api/traces

# UDP agent
export OPENTELEMETRY_JAEGER_AGENT_HOST=localhost
export OPENTELEMETRY_JAEGER_AGENT_PORT=6832

# Authentication (optional)
export OPENTELEMETRY_JAEGER_USERNAME=user
export OPENTELEMETRY_JAEGER_PASSWORD=pass
```

### Console Exporter Configuration

```bash
# Pretty print JSON (default: true)
export OPENTELEMETRY_CONSOLE_PRETTY=true

# Include span attributes (default: true)
export OPENTELEMETRY_CONSOLE_ATTRIBUTES=true

# Include span events (default: true)
export OPENTELEMETRY_CONSOLE_EVENTS=true
```

### File Exporter Configuration

```bash
# File path
export OPENTELEMETRY_FILE_PATH=./spans.json

# Append to file (default: true)
export OPENTELEMETRY_FILE_APPEND=true
```

### Batching Configuration

Batching is enabled by default for exporters that support it:

```bash
# Maximum batch size (default: 512)
export OPENTELEMETRY_BATCH_MAX_SIZE=512

# Export delay in milliseconds (default: 5000)
export OPENTELEMETRY_BATCH_DELAY=5000

# Export timeout in milliseconds (default: 30000)
export OPENTELEMETRY_EXPORT_TIMEOUT=30000

# Maximum queue size (default: 2048)
export OPENTELEMETRY_BATCH_QUEUE_SIZE=2048

# Disable batching
export OPENTELEMETRY_BATCH_ENABLED=false
```

## Usage

The plugin automatically starts exporting traces when OpenCode loads. Configuration is done via environment variables.

## Trace Model

This plugin favors semantic trace quality over raw event mirroring. Instead of one span per OpenCode event, events are correlated into nested spans.

Conversation turn hierarchy:

```text
chat (CLIENT)
├─ thinking (INTERNAL)
└─ tools/call <tool> (CLIENT)
```

Behavior:
- User text becomes `gen_ai.input.messages` on the next `chat` span
- Assistant text becomes `gen_ai.output.messages` on the active `chat` span
- Tool input/output map to `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`
- Tool and thinking spans are parented to the active `chat` span via OTel context propagation
- Session completion/error events close active spans so traces flush cleanly

### Development Workflow

For local development, use console output:

```bash
OPENTELEMETRY_EXPORT_FORMAT=console opencode
```

### Testing File Export

Export to file for later analysis:

```bash
OPENTELEMETRY_EXPORT_FORMAT=file-ndjson \
OPENTELEMETRY_FILE_PATH=./test-spans.ndjson \
opencode

# View exported spans
cat test-spans.ndjson | jq '.'
```

### Production Deployment

Export to OTLP collector:

```bash
OPENTELEMETRY_EXPORT_FORMAT=otlp-grpc \
OPENTELEMETRY_COLLECTOR_URL=https://otel.example.com:4317 \
opencode
```

## Attributes

The plugin emits MCP/gen-ai aligned attributes:

Core attributes:
- `service.name`: `opencode-otel-exporter`
- `service.version`: `1.0.0`
- `mcp.protocol.version`: `2025-06-18`
- `gen_ai.conversation.id`: Session/conversation identifier

Transport and protocol attributes:
- `jsonrpc.protocol.version`: `2.0`
- `network.transport`: `tcp`

GenAI chat attributes:
- `gen_ai.input.messages`
- `gen_ai.output.messages`
- `gen_ai.system.agent_name` (when present)
- `gen_ai.model.name` (when present)

MCP tool call attributes:
- `mcp.method.name`: `tools/call`
- `gen_ai.operation.name`: `execute_tool`
- `gen_ai.tool.name`
- `gen_ai.tool.call.arguments`
- `gen_ai.tool.call.result`

## Collector Configuration

### OTLP Collector with Arrow Encoding

To receive and Arrow-encode traces:

```yaml
receivers:
  otelarrow:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  batch:

exporters:
  # Your choice of exporter (e.g., AWS X-Ray, Jaeger, etc.)

service:
  pipelines:
    traces:
      receivers: [otelarrow]
      processors: [batch]
      exporters: [your_exporter]
```

### Simple Console Collector (Development)

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

## Architecture

The plugin is built with a modular exporter architecture and a session-aware span correlator:

```
┌─────────────────────────────────────────────────────────────────┐
│               opencode-otel-semantics-exporter                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │     Session State Correlator (by conversation id)        │ │
│  │  - Active chat span                                      │ │
│  │  - Active tool-call spans                                │ │
│  │  - Pending user input                                    │ │
│  └──────────────────────────────────────────────────────────┘ │
│                         │                                    │
│                         ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │      OpenTelemetry JS SDK / TracerProvider              │ │
│  │  └─ SpanForwarder (format-agnostic processor)           │ │
│  └──────────────────────────────────────────────────────────┘ │
│                         │                                    │
│                         ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │          Exporter Manager (configurable)                │ │
│  │  - OTLP/gRPC  - OTLP/HTTP  - Jaeger                     │ │
│  │  - Console    - File JSON   - File NDJSON               │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

See [PLAN-export-formats.md](./PLAN-export-formats.md) for detailed architecture and future plans.

## License

MIT

## Author

rektide de la faye

# OpenCode OpenTelemetry Traces Exporter Plugin

OpenCode plugin that exports OpenTelemetry traces for various plugin events using OpenTelemetry JavaScript SDK.

## Features

Exports spans for following OpenCode events:
- Tool execution (`tool.execute`, `tool.execute.before`, `tool.execute.after`, `tool.result`)
- Session lifecycle (`session.created`, `session.updated`, `session.completed`, `session.error`)
- Message updates (`message.updated`, `message.part.updated`, `message.part.removed`)
- File operations (`file.edited`, `file.watcher.updated`)
- Command execution (`command.executed`)

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

The plugin adds the following attributes to spans:

Common attributes:
- `service.name`: `opencode-otel-exporter`
- `service.version`: `1.0.0`

Context attributes:
- `opencode.session.id`: Session ID
- `opencode.message.id`: Message ID
- `opencode.tool.name`: Tool name
- `opencode.file.name`: File name
- `opencode.user.id`: User ID
- `opencode.project.id`: Project ID

Event-specific attributes:
- Tool events: `tool.name`, `tool.input`, `tool.output`
- Session events: `session.status`, `session.cost`, `session.messageCount`
- Message events: `message.length`, `message.part.type`, `message.part.fileName`
- File events: `file`

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

The plugin is built with a modular exporter architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│               opencode-otel-semantics-exporter                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         OpenTelemetry JavaScript SDK                      │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │  TracerProvider                                 │  │  │
│  │  │  └─ SpanForwarder (format-agnostic processor)   │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                         │                                     │
│                         ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │          Exporter Manager (configurable)                 │  │
│  │  - OTLP/gRPC Exporter                                 │  │
│  │  - Console Exporter                                    │  │
│  │  - File (JSON) Exporter                               │  │
│  │  - File (NDJSON) Exporter                             │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

See [PLAN-export-formats.md](./PLAN-export-formats.md) for detailed architecture and future plans.

## License

MIT

## Author

rektide de la faye

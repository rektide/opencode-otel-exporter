# OpenCode OpenTelemetry Traces Exporter Plugin

OpenCode plugin that exports OpenTelemetry traces for various plugin events using the OpenTelemetry JavaScript SDK.

## Features

Exports spans for the following OpenCode events:
- Tool execution (`tool.execute`, `tool.execute.before`, `tool.execute.after`, `tool.result`)
- Session lifecycle (`session.created`, `session.updated`, `session.completed`, `session.error`)
- Message updates (`message.updated`, `message.part.updated`, `message.part.removed`)
- File operations (`file.edited`, `file.watcher.updated`)
- Command execution (`command.executed`)

## Installation

1. Add the plugin to your project:

```bash
# Create plugin directory if it doesn't exist
mkdir -p .opencode/plugin

# Copy the plugin file
cp opencode-otel-semantics-exporter.ts .opencode/plugin/
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

Set the `OPENTELEMETRY_COLLECTOR_URL` environment variable to specify your OpenTelemetry collector endpoint:

```bash
export OPENTELEMETRY_COLLECTOR_URL=http://localhost:4317
```

If not set, the plugin will default to `http://localhost:4317`.

## Usage

The plugin automatically starts exporting traces when OpenCode loads. No additional configuration needed beyond setting the collector URL.

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

## License

MIT

## Author

rektide de la faye

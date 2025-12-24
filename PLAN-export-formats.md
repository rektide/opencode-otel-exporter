# Multi-Format Export Plan

## Overview

This document outlines the strategy for supporting multiple export formats beyond OTLP, enabling flexible telemetry export for different use cases (development, production, offline analysis, custom integrations).

## Export Format Options

### Primary Formats

| Format | Use Case | Transport | Encoding |
|--------|----------|-----------|----------|
| **OTLP/gRPC** | Production, distributed tracing | gRPC | Protobuf |
| **OTLP/HTTP** | Firewall-friendly, simpler infrastructure | HTTP/JSON | Protobuf (base64) |
| **Console/Logging** | Development, debugging | Stdout | JSON |
| **File (JSON/NDJSON)** | Offline analysis, testing | Filesystem | JSON/NDJSON |
| **Jaeger** | Direct Jaeger integration | UDP/HTTP | Thrift/Protobuf |

### Secondary Formats (Future)

| Format | Use Case | Notes |
|--------|----------|-------|
| **Arrow** | High-performance analytics | Direct Arrow columnar format |
| **Zipkin** | Legacy systems | Zipkin v2 API compatibility |
| **Prometheus/OpenMetrics** | Metrics dashboards | Only for metrics, not traces |
| **CSV/TSV** | Simple BI tools | Limited to tabular span data |
| **Custom/Pluggable** | User-defined formats | Plugin system for custom exporters |

## Architecture

### Current Architecture (Single Format)

```
┌─────────────────────────────────────────────────────────────┐
│               opencode-otel-semantics-exporter               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         OpenTelemetry SDK (monolithic)                │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │  TracerProvider                               │  │  │
│  │  │  ├─ BatchSpanProcessor                        │  │  │
│  │  │  └─ OTLPTraceExporter (fixed)                 │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Proposed Architecture (Multi-Format)

```
┌─────────────────────────────────────────────────────────────┐
│               opencode-otel-semantics-exporter               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              OpenTelemetry SDK                        │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │  TracerProvider                               │  │  │
│  │  │  ├─ BatchSpanProcessor (optional)             │  │  │
│  │  └─ SpanForwarder (custom processor)            │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
│                         │                                     │
│                         ▼                                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │          Exporter Manager (new)                      │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │  Exporter Registry                            │  │  │
│  │  │  - Register exporters                          │  │  │
│  │  │  - Select active exporter                      │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │  Span Normalizer                               │  │  │
│  │  │  - Convert to common format                   │  │  │
│  │  │  - Apply transformations                        │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
│                         │                                     │
│          ┌──────────────┼──────────────┐                    │
│          ▼              ▼              ▼                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ OTLP Export │ │ File Export │ │ Console Exp │  ...      │
│  └─────────────┘ └─────────────┘ └─────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. Exporter Interface

```typescript
interface SpanExporter {
  name: string;
  supportsBatching: boolean;
  initialize(config: ExporterConfig): Promise<void>;
  export(spans: ReadableSpan[]): Promise<ExportResult>;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}
```

#### 2. Exporter Registry

```typescript
class ExporterRegistry {
  private exporters: Map<string, SpanExporter> = new Map();
  
  register(exporter: SpanExporter): void;
  get(name: string): SpanExporter | undefined;
  list(): string[];
}
```

#### 3. Span Forwarder (Custom Processor)

Replaces or wraps `BatchSpanProcessor` to support both batch and non-batch exporters:

```typescript
class SpanForwarder implements SpanProcessor {
  constructor(
    private exporter: SpanExporter,
    private config: ForwarderConfig
  ) {}
  
  onEnd(span: ReadableSpan): void {
    if (this.exporter.supportsBatching) {
      // Buffer for batch export
      this.buffer.push(span);
    } else {
      // Export immediately
      this.exporter.export([span]);
    }
  }
}
```

#### 4. Span Normalizer

Converts OpenTelemetry spans to a common intermediate format:

```typescript
interface NormalizedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime: number;
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
  events: { time: number; name: string; attributes: Record<string, unknown> }[];
  links: { context: Context; attributes: Record<string, unknown> }[];
}
```

## Implementation Strategy

### Phase 1: Refactor for Modularity

**Goal**: Extract the current OTLP exporter into a separate module.

**Tasks**:

1. Create `exporters/` directory structure:
   ```
   exporters/
   ├── base.ts              # Base exporter interface
   ├── registry.ts          # Exporter registry
   ├── otlp/
   │   └── grpc.ts         # Current OTLP/gRPC implementation
   ├── file/
   │   ├── json.ts         # File (JSON) exporter
   │   └── ndjson.ts       # File (NDJSON) exporter
   └── console/
       └── logger.ts       # Console/logger exporter
   ```

2. Extract OTLP logic into `exporters/otlp/grpc.ts`:
   ```typescript
   export class OtlpGrpcExporter implements SpanExporter {
     name = "otlp-grpc";
     supportsBatching = true;
     
     constructor(private config: OtlpGrpcConfig) {}
     
     async initialize() {
       this.otelExporter = new OTLPTraceExporter({
         url: this.config.url,
         compression: this.config.compression
       });
     }
     
     async export(spans: ReadableSpan[]) {
       return this.otelExporter.export(spans);
     }
     
     async shutdown() {
       await this.otelExporter.shutdown();
     }
     
     async forceFlush() {
       await this.otelExporter.forceFlush();
     }
   }
   ```

3. Create `exporters/base.ts` with the base interface and utilities.

4. Update main plugin file to use the new exporter:
   ```typescript
   const exporter = new OtlpGrpcExporter({
     url: config.OPENTELEMETRY_COLLECTOR_URL || "http://localhost:4317"
   });
   
   provider.addSpanProcessor(new SpanForwarder(exporter, {}));
   ```

### Phase 2: Implement Additional Exporters

**Goal**: Add console and file exporters.

**Console Exporter** (`exporters/console/logger.ts`):

```typescript
export class ConsoleExporter implements SpanExporter {
  name = "console";
  supportsBatching = false;
  
  async initialize() {}
  
  async export(spans: ReadableSpan[]) {
    for (const span of spans) {
      console.log(JSON.stringify({
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        name: span.name,
        duration: span.duration[0],
        attributes: span.attributes
      }, null, 2));
    }
    return ExportResult.SUCCESS;
  }
  
  async shutdown() {}
  async forceFlush() {}
}
```

**File Exporter** (`exporters/file/json.ts`):

```typescript
export class FileJsonExporter implements SpanExporter {
  name = "file-json";
  supportsBatching = true;
  
  constructor(private config: { filepath: string }) {}
  
  async export(spans: ReadableSpan[]) {
    const output = spans.map(span => ({
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      name: span.name,
      duration: span.duration[0],
      attributes: span.attributes
    }));
    
    await fs.appendFile(this.config.filepath, JSON.stringify(output) + "\n");
    return ExportResult.SUCCESS;
  }
}
```

### Phase 3: Configuration System

**Goal**: Enable runtime format selection via configuration.

**Config Schema**:

```typescript
interface ExporterConfig {
  format: "otlp-grpc" | "otlp-http" | "console" | "file-json" | "file-ndjson";
  
  // OTLP-specific
  otlp?: {
    url: string;
    compression: "gzip" | "none";
    headers: Record<string, string>;
  };
  
  // File-specific
  file?: {
    filepath: string;
    append: boolean;
  };
  
  // Batching (applies to batching exporters)
  batching?: {
    enabled: boolean;
    maxBatchSize: number;
    scheduleDelay: number;
  };
}
```

**Loader Function**:

```typescript
async function loadExporter(config: ExporterConfig): Promise<SpanExporter> {
  switch (config.format) {
    case "otlp-grpc":
      return new OtlpGrpcExporter(config.otlp!);
    
    case "console":
      return new ConsoleExporter();
    
    case "file-json":
      return new FileJsonExporter(config.file!);
    
    default:
      throw new Error(`Unknown exporter format: ${config.format}`);
  }
}
```

**Environment Variable Mapping**:

| Env Var | Maps To | Default |
|---------|---------|---------|
| `OPENTELEMETRY_EXPORT_FORMAT` | `config.format` | `otlp-grpc` |
| `OPENTELEMETRY_COLLECTOR_URL` | `config.otlp.url` | `http://localhost:4317` |
| `OPENTELEMETRY_FILE_PATH` | `config.file.filepath` | `./spans.json` |
| `OPENTELEMETRY_BATCH_ENABLED` | `config.batching.enabled` | `true` |

### Phase 4: Multi-Exporter Support (Optional)

**Goal**: Allow multiple exporters to run simultaneously.

**Use Cases**:
- Export to production collector AND local file for debugging
- Dual export to multiple collectors for redundancy
- Real-time console logging + async file export

**Composite Exporter**:

```typescript
export class CompositeExporter implements SpanExporter {
  name = "composite";
  supportsBatching = true;
  
  constructor(private exporters: SpanExporter[]) {}
  
  async export(spans: ReadableSpan[]): Promise<ExportResult> {
    const results = await Promise.all(
      this.exporters.map(exporter => exporter.export([...spans]))
    );
    
    return results.every(r => r === ExportResult.SUCCESS)
      ? ExportResult.SUCCESS
      : ExportResult.FAILED_RETRYABLE;
  }
  
  async shutdown() {
    await Promise.all(this.exporters.map(e => e.shutdown()));
  }
  
  async forceFlush() {
    await Promise.all(this.exporters.map(e => e.forceFlush()));
  }
}
```

**Config Example**:

```json
{
  "format": "composite",
  "exporters": [
    {
      "format": "otlp-grpc",
      "otlp": { "url": "http://prod-collector:4317" }
    },
    {
      "format": "file-json",
      "file": { "filepath": "./debug-spans.json" }
    }
  ]
}
```

## Exporter Implementations

### OTLP/gRPC Exporter

**Status**: ✅ Implemented (needs refactoring)

**Features**:
- Uses OpenTelemetry SDK's `OTLPTraceExporter`
- Supports GZIP compression
- Automatic retries with exponential backoff
- Batch export for performance

**Config**:
```typescript
{
  format: "otlp-grpc",
  otlp: {
    url: "http://localhost:4317",
    compression: "gzip",
    headers: { "X-Custom-Header": "value" }
  }
}
```

### OTLP/HTTP Exporter

**Status**: 📋 Planned

**Features**:
- HTTP/JSON transport (firewall-friendly)
- Same semantics as OTLP/gRPC
- Uses `OTLPTraceExporter` with HTTP URL

**Config**:
```typescript
{
  format: "otlp-http",
  otlp: {
    url: "https://collector.example.com/v1/traces",
    compression: "gzip"
  }
}
```

### Console Exporter

**Status**: 📋 Planned

**Features**:
- Immediate export (no batching)
- Pretty-printed JSON
- Color-coded span status
- Filterable by log level

**Config**:
```typescript
{
  format: "console",
  console: {
    prettyPrint: true,
    includeAttributes: true,
    colorize: true,
    level: "debug"
  }
}
```

### File (JSON) Exporter

**Status**: 📋 Planned

**Features**:
- Append to file (or overwrite)
- Optional rotation by size/time
- JSON array format per batch
- Can be imported by other tools

**Config**:
```typescript
{
  format: "file-json",
  file: {
    filepath: "./spans.json",
    append: true,
    rotation: {
      maxSize: "100MB",
      maxFiles: 10
    }
  }
}
```

### File (NDJSON) Exporter

**Status**: 📋 Planned

**Features**:
- Newline-delimited JSON (one span per line)
- Stream-friendly
- Easier to parse line-by-line
- Compatible with `jq`, `awk`, etc.

**Config**:
```typescript
{
  format: "file-ndjson",
  file: {
    filepath: "./spans.ndjson",
    append: true
  }
}
```

### Jaeger Exporter

**Status**: 📋 Planned

**Features**:
- Direct Jaeger UDP/HTTP export
- No collector needed
- Useful for local development
- Uses OpenTelemetry's `JaegerExporter`

**Config**:
```typescript
{
  format: "jaeger",
  jaeger: {
    endpoint: "http://localhost:14268/api/traces",
    agentHost: "localhost",
    agentPort: 6832
  }
}
```

### Arrow Exporter

**Status**: 📋 Future

**Features**:
- Direct Arrow IPC format
- High-performance columnar storage
- Requires Arrow libraries
- Bypasses collector

**Config**:
```typescript
{
  format: "arrow",
  arrow: {
    filepath: "./spans.arrow",
    compression: "zstd"
  }
}
```

## Implementation Roadmap

### Phase 1: Refactoring (Week 1)
- [ ] Create `exporters/` directory structure
- [ ] Extract OTLP exporter into `exporters/otlp/grpc.ts`
- [ ] Create base exporter interface in `exporters/base.ts`
- [ ] Update main plugin to use new structure
- [ ] Verify existing functionality still works

### Phase 2: Core Exporters (Week 2)
- [ ] Implement console exporter
- [ ] Implement file-JSON exporter
- [ ] Implement file-NDJSON exporter
- [ ] Add configuration loader
- [ ] Add environment variable mapping
- [ ] Update documentation

### Phase 3: Additional Formats (Week 3)
- [ ] Implement OTLP/HTTP exporter
- [ ] Implement Jaeger exporter
- [ ] Add exporter tests
- [ ] Performance benchmarking

### Phase 4: Advanced Features (Week 4+)
- [ ] Implement composite exporter (multi-export)
- [ ] Add span filtering/sampling
- [ ] Add export metrics (export counts, failures)
- [ ] Implement Arrow exporter
- [ ] Create custom exporter plugin system

## Design Decisions

### 1. Reuse OpenTelemetry SDK Where Possible

**Decision**: Use OpenTelemetry's existing exporters (OTLP, Jaeger) directly rather than re-implementing protocols.

**Rationale**:
- Reduces maintenance burden
- Leverages battle-tested implementations
- Easier to stay updated with spec changes

**Trade-off**: Less flexibility for custom formats, but can work around with normalization layer.

### 2. Separate Batching from Exporter

**Decision**: Make batching a concern of the `SpanForwarder`, not the exporter.

**Rationale**:
- Some exporters (console) don't support batching
- Allows per-exporter batching configuration
- Simplifies exporter implementations

**Trade-off**: Slightly more complex processor logic.

### 3. Config-Driven Exporter Selection

**Decision**: Use a configuration file + environment variables to select exporters.

**Rationale**:
- Runtime flexibility (change export format without code change)
- Environment-specific configurations (dev vs prod)
- Easy to add new exporters without changing plugin code

**Trade-off**: Configuration validation complexity.

### 4. Span Normalization

**Decision**: Create a common `NormalizedSpan` interface for non-OpenTelemetry exporters.

**Rationale**:
- Decouples exporters from OpenTelemetry internals
- Easier to implement custom formats
- Can apply transformations (attribute renaming, filtering) consistently

**Trade-off**: Performance overhead of normalization step.

### 5. Error Handling Strategy

**Decision**: Exporter failures should not prevent span recording, but should be logged.

**Rationale**:
- Telemetry failures shouldn't break the main application
- Observability should be resilient
- Users need visibility into export failures

**Trade-off**: Silent failures if logging is misconfigured.

## Considerations & Trade-offs

### Performance

| Exporter | Latency | Throughput | CPU | Network |
|----------|---------|------------|-----|---------|
| OTLP/gRPC | Low | High | Medium | Yes |
| OTLP/HTTP | Medium | Medium | Medium | Yes |
| Console | Very Low | Very Low | Low | No |
| File | Low | High | Low | I/O |
| Jaeger | Low | High | Medium | Yes |
| Arrow | Low | Very High | High | I/O |

### Complexity vs Flexibility

- **Simple approach**: Single config option `exportFormat`
  - Easy to understand
  - Limited to one format at a time
  
- **Flexible approach**: Composite exporter with multiple formats
  - More configuration options
  - Supports multiple exporters simultaneously
  - Better for complex deployments

### Development Workflow

**Recommended dev setup**:
```bash
# Local development - console logging
OPENTELEMETRY_EXPORT_FORMAT=console

# Testing file output
OPENTELEMETRY_EXPORT_FORMAT=file-ndjson
OPENTELEMETRY_FILE_PATH=./test-spans.ndjson

# Production - OTLP to collector
OPENTELEMETRY_EXPORT_FORMAT=otlp-grpc
OPENTELEMETRY_COLLECTOR_URL=https://otel.example.com:4317

# Debugging - export to both collector and file
OPENTELEMETRY_EXPORT_FORMAT=composite
OPENTELEMETRY_EXPORTERS='[
  {"format":"otlp-grpc","otlp":{"url":"https://otel.example.com:4317"}},
  {"format":"file-json","file":{"filepath":"./debug-spans.json"}}
]'
```

## Migration Path

### For Existing Users

**Current behavior** (implicit):
```typescript
// Always uses OTLP/gRPC
const exporter = new OTLPTraceExporter({
  url: config.OPENTELEMETRY_COLLECTOR_URL || "http://localhost:4317"
});
```

**After Phase 1** (no behavior change):
```typescript
const exporter = new OtlpGrpcExporter({
  url: config.OPENTELEMETRY_COLLECTOR_URL || "http://localhost:4317"
});
```

**After Phase 3** (opt-in new behavior):
```typescript
// Old config still works (defaults to otlp-grpc)
// New config enables other formats
const format = config.OPENTELEMETRY_EXPORT_FORMAT || "otlp-grpc";
const exporter = await loadExporter({ format, [format]: config });
```

### Backward Compatibility

1. **Phase 1**: No breaking changes - purely internal refactoring
2. **Phase 2-3**: Additive changes - existing config still works, new config is optional
3. **Phase 4**: Breaking changes if removing old config format (consider deprecation period)

## Testing Strategy

### Unit Tests

- Test each exporter in isolation
- Mock network calls for OTLP exporters
- Test file I/O with temp directories
- Verify span normalization

### Integration Tests

- End-to-end with actual collectors (OTLP, Jaeger)
- File output verification
- Composite exporter coordination
- Configuration parsing

### Performance Tests

- Export latency measurements
- Throughput benchmarks
- Memory usage with high span volume
- Batch size optimization

## Future Directions

### 1. Pluggable Exporters

Allow users to write custom exporters:

```typescript
export interface CustomExporterConfig {
  type: "custom";
  module: string; // Path to user-defined module
  options: Record<string, unknown>;
}
```

### 2. Span Transformations

Apply transformations before export:

```typescript
{
  format: "otlp-grpc",
  transforms: [
    {
      type: "filter",
      condition: "attributes['opencode.tool.name'] !== 'bash'"
    },
    {
      type: "rename",
      from: "opencode.session_id",
      to: "session_id"
    }
  ]
}
```

### 3. Conditional Export

Export based on runtime conditions:

```typescript
{
  format: "otlp-grpc",
  condition: {
    env: "production",
    attribute: "opencode.user.premium",
    value: true
  }
}
```

### 4. Export Health Monitoring

Track export health and expose metrics:

- Export success rate
- Export latency p50/p95/p99
- Failed retry count
- Buffer size (for batching exporters)

## Conclusion

This plan provides a clear path from the current single-format OTLP implementation to a flexible, modular system supporting multiple export formats. The phased approach allows incremental delivery while maintaining backward compatibility.

Key benefits:
- **Flexibility**: Choose the right export format for your use case
- **Modularity**: Easy to add new exporters
- **Testability**: Isolated exporter logic
- **Performance**: Optimized batching per-exporter
- **Future-proof**: Extensible to custom formats

The architecture balances complexity with flexibility, making it suitable for both development workflows and production deployments.

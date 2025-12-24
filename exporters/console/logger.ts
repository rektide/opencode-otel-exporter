import { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { ExportResult } from "@opentelemetry/otlp-exporter-base"
import type { SpanExporter, NormalizedSpan } from "../base.js"
import { normalizeSpan } from "../base.js"

export interface ConsoleConfig {
  prettyPrint?: boolean
  includeAttributes?: boolean
  includeEvents?: boolean
  colorize?: boolean
}

export class ConsoleExporter implements SpanExporter {
  name = "console"
  supportsBatching = false

  private config: Required<ConsoleConfig>

  constructor(config: ConsoleConfig = {}) {
    this.config = {
      prettyPrint: config.prettyPrint ?? true,
      includeAttributes: config.includeAttributes ?? true,
      includeEvents: config.includeEvents ?? true,
      colorize: config.colorize ?? true,
    }
  }

  async initialize(): Promise<void> {}

  async export(spans: ReadableSpan[]): Promise<ExportResult> {
    for (const span of spans) {
      this.logSpan(span)
    }
    return ExportResult.SUCCESS
  }

  private logSpan(span: ReadableSpan): void {
    const normalized = normalizeSpan(span)
    const output = {
      traceId: normalized.traceId,
      spanId: normalized.spanId,
      parentSpanId: normalized.parentSpanId,
      name: normalized.name,
      kind: normalized.kind,
      duration: `${(normalized.duration / 1e6).toFixed(2)}ms`,
      status: normalized.status,
    }

    if (this.config.includeAttributes) {
      output["attributes"] = normalized.attributes
    }

    if (this.config.includeEvents && normalized.events.length > 0) {
      output["events"] = normalized.events
    }

    if (this.config.prettyPrint) {
      console.log(JSON.stringify(output, null, 2))
    } else {
      console.log(JSON.stringify(output))
    }
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

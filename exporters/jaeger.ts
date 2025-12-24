import { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { ExportResult } from "@opentelemetry/otlp-exporter-base"
import { JaegerExporter } from "@opentelemetry/exporter-jaeger"
import type { SpanExporter } from "../base.js"

export interface JaegerConfig {
  endpoint?: string
  agentHost?: string
  agentPort?: number
  username?: string
  password?: string
}

export class JaegerTraceExporter implements SpanExporter {
  name = "jaeger"
  supportsBatching = true

  private exporter: JaegerExporter | null = null
  private config: JaegerConfig

  constructor(config: JaegerConfig = {}) {
    this.config = config
  }

  async initialize(): Promise<void> {
    this.exporter = new JaegerExporter({
      endpoint: this.config.endpoint,
      agentHost: this.config.agentHost ?? "localhost",
      agentPort: this.config.agentPort ?? 6832,
      username: this.config.username,
      password: this.config.password,
    })
  }

  async export(spans: ReadableSpan[]): Promise<ExportResult> {
    if (!this.exporter) {
      return ExportResult.FAILED_NOT_RETRYABLE
    }
    return this.exporter.export(spans)
  }

  async shutdown(): Promise<void> {
    if (this.exporter) {
      await this.exporter.shutdown()
      this.exporter = null
    }
  }

  async forceFlush(): Promise<void> {
    if (this.exporter) {
      await this.exporter.forceFlush()
    }
  }
}

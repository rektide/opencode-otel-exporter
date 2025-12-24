import { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { ExportResult } from "@opentelemetry/otlp-exporter-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base"
import type { SpanExporter } from "../base.js"

export interface OtlpHttpConfig {
  url: string
  compression?: "gzip" | "none"
  headers?: Record<string, string>
}

export class OtlpHttpExporter implements SpanExporter {
  name = "otlp-http"
  supportsBatching = true

  private exporter: OTLPTraceExporter | null = null
  private config: OtlpHttpConfig

  constructor(config: OtlpHttpConfig) {
    this.config = config
  }

  async initialize(): Promise<void> {
    this.exporter = new OTLPTraceExporter({
      url: this.config.url,
      compression:
        this.config.compression === "none"
          ? CompressionAlgorithm.NONE
          : CompressionAlgorithm.GZIP,
      headers: this.config.headers,
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

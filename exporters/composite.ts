import { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { ExportResult } from "@opentelemetry/otlp-exporter-base"
import type { SpanExporter } from "./base.js"

export class CompositeExporter implements SpanExporter {
  name = "composite"
  supportsBatching = true

  private exporters: SpanExporter[]

  constructor(exporters: SpanExporter[]) {
    if (exporters.length === 0) {
      throw new Error("CompositeExporter requires at least one exporter")
    }
    this.exporters = exporters
  }

  async initialize(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.initialize()))
  }

  async export(spans: ReadableSpan[]): Promise<ExportResult> {
    const results = await Promise.all(
      this.exporters.map((exporter) => exporter.export([...spans])),
    )

    const allSuccess = results.every((r) => r === ExportResult.SUCCESS)
    return allSuccess ? ExportResult.SUCCESS : ExportResult.FAILED_RETRYABLE
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.shutdown()))
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.forceFlush()))
  }
}

import {
  SpanProcessor,
  ReadableSpan,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import type { SpanExporter } from "./base.js"

export interface ForwarderConfig {
  batchSize?: number
  scheduleDelay?: number
  exportTimeoutMillis?: number
  maxQueueSize?: number
}

export class SpanForwarder implements SpanProcessor {
  private processor: SpanProcessor | null = null
  private exporter: SpanExporter

  constructor(exporter: SpanExporter, config: ForwarderConfig = {}) {
    this.exporter = exporter

    if (exporter.supportsBatching) {
      this.processor = new BatchSpanProcessor(exporter, {
        maxExportBatchSize: config.batchSize ?? 512,
        scheduledDelayMillis: config.scheduleDelay ?? 5000,
        exportTimeoutMillis: config.exportTimeoutMillis ?? 30000,
        maxQueueSize: config.maxQueueSize ?? 2048,
      })
    }
  }

  forceFlush(): Promise<void> {
    if (this.processor) {
      return this.processor.forceFlush()
    }
    return Promise.resolve()
  }

  onStart(span: ReadableSpan): void {
    if (this.processor) {
      this.processor.onStart(span)
    }
  }

  onEnd(span: ReadableSpan): void {
    if (this.processor) {
      this.processor.onEnd(span)
    } else {
      this.exporter.export([span]).catch((err) => {
        console.error(`[SpanForwarder] Export failed:`, err)
      })
    }
  }

  shutdown(): Promise<void> {
    if (this.processor) {
      return this.processor.shutdown()
    }
    return this.exporter.shutdown()
  }
}

import * as fs from "node:fs/promises"
import { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { ExportResult } from "@opentelemetry/otlp-exporter-base"
import type { SpanExporter, NormalizedSpan } from "../../base.js"
import { normalizeSpan } from "../../base.js"

export interface FileNdjsonConfig {
  filepath: string
  append?: boolean
}

export class FileNdjsonExporter implements SpanExporter {
  name = "file-ndjson"
  supportsBatching = true

  private config: Required<FileNdjsonConfig>
  private initialized = false

  constructor(config: FileNdjsonConfig) {
    this.config = {
      filepath: config.filepath,
      append: config.append ?? true,
    }
  }

  async initialize(): Promise<void> {
    if (!this.config.append) {
      await fs.writeFile(this.config.filepath, "", "utf-8")
    }
    this.initialized = true
  }

  async export(spans: ReadableSpan[]): Promise<ExportResult> {
    if (!this.initialized) {
      await this.initialize()
    }

    for (const span of spans) {
      const line = JSON.stringify(normalizeSpan(span)) + "\n"
      await fs.appendFile(this.config.filepath, line, "utf-8")
    }

    return ExportResult.SUCCESS
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

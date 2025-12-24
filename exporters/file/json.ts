import * as fs from "node:fs/promises"
import { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { ExportResult } from "@opentelemetry/otlp-exporter-base"
import type { SpanExporter, NormalizedSpan } from "../../base.js"
import { normalizeSpan } from "../../base.js"

export interface FileJsonConfig {
  filepath: string
  append?: boolean
}

export class FileJsonExporter implements SpanExporter {
  name = "file-json"
  supportsBatching = true

  private config: Required<FileJsonConfig>
  private initialized = false

  constructor(config: FileJsonConfig) {
    this.config = {
      filepath: config.filepath,
      append: config.append ?? true,
    }
  }

  async initialize(): Promise<void> {
    if (!this.config.append) {
      await fs.writeFile(this.config.filepath, "[]", "utf-8")
    }
    this.initialized = true
  }

  async export(spans: ReadableSpan[]): Promise<ExportResult> {
    if (!this.initialized) {
      await this.initialize()
    }

    const output = spans.map(normalizeSpan)

    if (this.config.append) {
      const data = JSON.stringify(output) + "\n"
      await fs.appendFile(this.config.filepath, data, "utf-8")
    } else {
      const existingData = await fs.readFile(this.config.filepath, "utf-8")
      let existing: unknown[] = []
      try {
        existing = JSON.parse(existingData) as unknown[]
      } catch {
        existing = []
      }
      existing.push(...output)
      await fs.writeFile(
        this.config.filepath,
        JSON.stringify(existing, null, 2),
        "utf-8",
      )
    }

    return ExportResult.SUCCESS
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
